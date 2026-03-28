import { Elysia, t } from "elysia";
import { readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { ingestFile, isSupportedFile, getDb, registerDir, scanForMissedFiles } from "@localsearch/core";

// ---------------------------------------------------------------------------
// Shared indexing-status state — covers both manual POST /index and rescan
// ---------------------------------------------------------------------------
export interface IndexStatus {
  running: boolean;
  startedAt: string | null;
  operation: "index" | "rescan" | null;
  lastResult: string | null;
  progress: { current: number; total: number } | null;
  failureCount: number;
}

let _status: IndexStatus = { running: false, startedAt: null, operation: null, lastResult: null, progress: null, failureCount: 0 };

export function getIndexStatus(): IndexStatus {
  // Always read a fresh failure count from the DB
  try {
    const db = getDb();
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM failed_files").get();
    return { ..._status, failureCount: row?.n ?? 0 };
  } catch {
    return { ..._status };
  }
}

export function setRunning(op: "index" | "rescan", total?: number) {
  _status = {
    running: true,
    startedAt: new Date().toISOString(),
    operation: op,
    lastResult: null,
    progress: total != null ? { current: 0, total } : null,
    failureCount: _status.failureCount,
  };
}
export function setProgress(current: number, total: number) {
  if (_status.running) {
    _status = { ..._status, progress: { current, total } };
  }
}
export function setIdle(result?: string) {
  _status = { running: false, startedAt: null, operation: null, lastResult: result ?? null, progress: null, failureCount: _status.failureCount };
}


function walkDir(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(full));
      } else if (entry.isFile() && isSupportedFile(full)) {
        files.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return files;
}

export const indexRoute = new Elysia()
  // ── GET /index/status ──────────────────────────────────────────────────────
  .get(
    "/index/status",
    () => getIndexStatus(),
    {
      detail: {
        tags: ["index"],
        summary: "Get current indexing status",
        description: `Returns live status for background index/rescan jobs, including progress, last result message, and current failed-file count.

Example response:
{"running":true,"startedAt":"2026-03-28T10:00:00.000Z","operation":"index","progress":{"current":42,"total":300},"failureCount":2}`,
      },
    }
  )

  // ── POST /index ────────────────────────────────────────────────────────────
  .post(
    "/index",
    async ({ body }) => {
      if (_status.running) {
        return { error: "An indexing operation is already in progress", status: getIndexStatus() };
      }
      const { path, recursive = true } = body;
      let files: string[];
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          files = recursive ? walkDir(path) : readdirSync(path)
            .map((f) => join(path, f))
            .filter((f) => statSync(f).isFile() && isSupportedFile(f));
        } else {
          files = isSupportedFile(path) ? [path] : [];
        }
      } catch (e) {
        return { error: `Cannot access path: ${path}`, details: String(e) };
      }

      if (files.length === 0) {
        return { message: "No supported files found at path", path, results: [] };
      }

      setRunning("index", files.length);

      // Fire-and-forget — scan runs in background so the client can disconnect/refresh freely
      (async () => {
        const results: { path: string; status: string; chunks?: number; error?: string }[] = [];
        try {
          for (let i = 0; i < files.length; i++) {
            const result = await ingestFile(files[i]);
            results.push(result);
            setProgress(i + 1, files.length);
          }
        } finally {
          const indexed = results.filter((r) => r.status === "indexed").length;
          const skipped = results.filter((r) => r.status === "skipped").length;
          const errors  = results.filter((r) => r.status === "error").length;

          // Register the root path so it is watched and survives restarts
          const watchRoot = (() => {
            try { return statSync(path).isDirectory() ? path : dirname(path); } catch { return null; }
          })();
          if (watchRoot) registerDir(watchRoot);

          setIdle(`Indexing complete: ${indexed} indexed, ${skipped} skipped, ${errors} errors`);
        }
      })();

      return { started: true, total: files.length };
    },
    {
      body: t.Object({
        path: t.String({ description: "File or directory path to index" }),
        recursive: t.Optional(t.Boolean({ description: "Recurse into subdirectories (default: true)" })),
      }),
      detail: {
        tags: ["index"],
        summary: "Index a file or directory",
        description: `Starts background indexing for the given path. Supports single files or directories. Progress can be tracked via GET /index/status.

Example request body:
{"path":"/home/user/Documents","recursive":true}

Example response:
{"started":true,"total":427}`,
      },
    }
  )

  // ── POST /index/rescan ─────────────────────────────────────────────────────
  .post(
    "/index/rescan",
    async () => {
      if (_status.running) {
        return { error: "An indexing operation is already in progress", status: getIndexStatus() };
      }

      setRunning("rescan");

      // Fire-and-forget — rescan runs in background so the client can disconnect/refresh freely
      (async () => {
        try {
          const db = getDb();

          // Read the stored root dirs — no subdir expansion needed here;
          // scanForMissedFiles does its own recursive walkDir internally.
          const roots = db
            .query<{ path: string }, []>("SELECT path FROM watched_dirs ORDER BY added_at")
            .all()
            .map((r) => (r as { path: string }).path);

          // Run the scan across all roots
          const result = await scanForMissedFiles(roots, ({ current, total }) => {
            setProgress(current, total);
          });

          setIdle(`Rescan complete: ${result.newCount} new, ${result.updatedCount} updated, ${result.removedCount} removed, ${result.skippedCount} skipped, ${result.failed.length} failed`);
        } catch (e) {
          setIdle(`Rescan error: ${String(e)}`);
        }
      })();

      return { started: true };
    },
    {
      detail: {
        tags: ["index"],
        summary: "Rescan all watched directories for new/changed/deleted files",
        description: `Starts a background drift scan across watched roots to index new/modified files and remove deleted ones from the index.

Example response:
{"started":true}`,
      },
    }
  )

  // ── DELETE /index/:docId ───────────────────────────────────────────────────
  .delete(
    "/index/:docId",
    ({ params }) => {
      const db = getDb();
      const doc = db
        .query<{ path: string }, number>("SELECT path FROM documents WHERE id = ?")
        .get(params.docId);

      if (!doc) {
        return { error: "Document not found" };
      }

      db.run("DELETE FROM documents WHERE id = ?", [params.docId]);
      return { message: "Document removed from index", path: doc.path };
    },
    {
      params: t.Object({ docId: t.Numeric() }),
      detail: {
        tags: ["index"],
        summary: "Remove a document from the index",
        description: `Deletes one indexed document by ID, including its chunks and vector/FTS records via relational cleanup.

Example request:
DELETE /index/42

Example response:
{"message":"Document removed from index","path":"/home/user/Documents/report.pdf"}`,
      },
    }
  );
