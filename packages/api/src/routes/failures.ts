import { Elysia, t } from "elysia";
import { getDb, ingestFile } from "@localsearch/core";
import { getIndexStatus, setRunning, setProgress, setIdle } from "./index";

interface FailedFileRow {
  path: string;
  error: string;
  failed_at: number;
}

export const failuresRoute = new Elysia()
  // ── GET /index/failures ────────────────────────────────────────────────────
  .get(
    "/index/failures",
    ({ query }) => {
      const db = getDb();
      const dir = query.dir?.trim();
      const search = query.search?.trim();
      const searchLike = search ? `%${search}%` : null;

      let rows: FailedFileRow[];
      if (dir) {
        const prefix = dir.endsWith("/") ? dir : dir + "/";
        if (searchLike) {
          rows = db
            .query<FailedFileRow, [string, string, string, string]>(
              "SELECT path, error, failed_at FROM failed_files WHERE (path = ? OR path LIKE ?) AND (path LIKE ? OR error LIKE ?) ORDER BY failed_at DESC"
            )
            .all(dir, prefix + "%", searchLike, searchLike);
        } else {
          rows = db
            .query<FailedFileRow, [string, string]>(
              "SELECT path, error, failed_at FROM failed_files WHERE path = ? OR path LIKE ? ORDER BY failed_at DESC"
            )
            .all(dir, prefix + "%");
        }
      } else if (searchLike) {
        rows = db
          .query<FailedFileRow, [string, string]>(
            "SELECT path, error, failed_at FROM failed_files WHERE path LIKE ? OR error LIKE ? ORDER BY failed_at DESC"
          )
          .all(searchLike, searchLike);
      } else {
        rows = db
          .query<FailedFileRow, []>(
            "SELECT path, error, failed_at FROM failed_files ORDER BY failed_at DESC"
          )
          .all();
      }

      return {
        failures: rows.map((r) => ({
          path: r.path,
          error: r.error,
          failedAt: new Date(r.failed_at).toISOString(),
        })),
        total: rows.length,
      };
    },
    {
      query: t.Object({
        dir: t.Optional(t.String({ description: "Filter by directory prefix" })),
        search: t.Optional(t.String({ description: "Filter by path or error message (case-insensitive substring)" })),
      }),
      detail: {
        tags: ["index"],
        summary: "List files that failed to index",
        description:
          "Returns all files that failed during indexing, optionally filtered by directory prefix and/or search term. Failures are cleared when a file is successfully re-indexed or deleted.",
      },
    }
  )

  // ── DELETE /index/failures ─────────────────────────────────────────────────
  .delete(
    "/index/failures",
    () => {
      const db = getDb();
      const { changes } = db.run("DELETE FROM failed_files");
      return { cleared: changes };
    },
    {
      detail: {
        tags: ["index"],
        summary: "Clear all failed-file records",
        description: "Removes every entry from failed_files. Does not re-index anything.",
      },
    }
  )

  // ── POST /index/failures/retry ─────────────────────────────────────────────
  .post(
    "/index/failures/retry",
    ({ query }) => {
      const status = getIndexStatus();
      if (status.running) {
        return { error: "An indexing operation is already in progress", status };
      }

      const db = getDb();
      const rows = db
        .query<{ path: string }, []>("SELECT path FROM failed_files ORDER BY failed_at DESC")
        .all();

      if (rows.length === 0) {
        return { started: false, message: "No failed files to retry" };
      }

      const timeoutMs = (query.timeoutSeconds ?? 300) * 1000;
      const paths = rows.map((r) => r.path);
      setRunning("index", paths.length);

      (async () => {
        try {
          for (let i = 0; i < paths.length; i++) {
            const filePath = paths[i];
            try {
              await Promise.race([
                ingestFile(filePath),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`ingest timed out after ${query.timeoutSeconds ?? 300}s`)), timeoutMs)
                ),
              ]);
            } catch (e) {
              const error = String(e);
              console.warn(`[retry-all] timeout/error: ${filePath} — ${error}`);
              try {
                db.run(
                  "INSERT OR REPLACE INTO failed_files (path, error, failed_at) VALUES (?, ?, ?)",
                  [filePath, error, Date.now()]
                );
              } catch { /* ignore DB errors */ }
            }
            setProgress(i + 1, paths.length);
          }
        } finally {
          setIdle(`Retry complete: attempted ${paths.length} file${paths.length !== 1 ? "s" : ""}`);
        }
      })();

      return { started: true, total: paths.length };
    },
    {
      query: t.Object({
        timeoutSeconds: t.Optional(t.Number({ description: "Per-file ingest timeout in seconds (default 300)", minimum: 1 })),
      }),
      detail: {
        tags: ["index"],
        summary: "Retry all failed files",
        description: "Re-ingests every file currently in failed_files. Runs in the background; poll /index/status for progress. Optional timeoutSeconds controls per-file limit (default 300).",
      },
    }
  )

  // ── POST /index/failures/retry/:path ──────────────────────────────────────
  .post(
    "/index/failures/retry/:encodedPath",
    async ({ params, query }) => {
      const filePath = decodeURIComponent(params.encodedPath);
      const timeoutMs = (query.timeoutSeconds ?? 300) * 1000;
      const db = getDb();

      let result: Awaited<ReturnType<typeof ingestFile>>;
      try {
        result = await Promise.race([
          ingestFile(filePath),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`ingest timed out after ${query.timeoutSeconds ?? 300}s`)), timeoutMs)
          ),
        ]);
      } catch (e) {
        const error = String(e);
        console.warn(`[retry] timeout/error: ${filePath} — ${error}`);
        try {
          db.run(
            "INSERT OR REPLACE INTO failed_files (path, error, failed_at) VALUES (?, ?, ?)",
            [filePath, error, Date.now()]
          );
        } catch { /* ignore DB errors */ }
        return { path: filePath, status: "error" as const, error };
      }

      return { path: filePath, status: result.status, error: result.error };
    },
    {
      params: t.Object({
        encodedPath: t.String({ description: "URL-encoded absolute file path" }),
      }),
      query: t.Object({
        timeoutSeconds: t.Optional(t.Number({ description: "Ingest timeout in seconds (default 300)", minimum: 1 })),
      }),
      detail: {
        tags: ["index"],
        summary: "Retry a single failed file",
        description: "Re-ingests one file by its URL-encoded path. Optional timeoutSeconds controls the limit (default 300). Clears the failed_files entry on success.",
      },
    }
  );
