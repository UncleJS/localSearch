import { watch, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { getDb } from "./db";
import { ingestFile, isSupportedFile } from "./ingest";

const DEBOUNCE_MS = 5_000;

// dir → FSWatcher
const watchers = new Map<string, ReturnType<typeof watch>>();

// filepath → timeout handle
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleReindex(filePath: string) {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing);

  pending.set(
    filePath,
    setTimeout(async () => {
      pending.delete(filePath);

      if (!existsSync(filePath)) {
        // File was deleted — remove from index and clear any recorded failure
        const db = getDb();
        const doc = db
          .query<{ id: number }, string>(
            "SELECT id FROM documents WHERE path = ?"
          )
          .get(filePath);
        if (doc) {
          db.run("DELETE FROM documents WHERE id = ?", [doc.id]);
          console.log(`[watcher] removed deleted file: ${filePath}`);
        }
        db.run("DELETE FROM failed_files WHERE path = ?", [filePath]);
        return;
      }

      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) return;
      } catch {
        return;
      }

      if (!isSupportedFile(filePath)) return;

      console.log(`[watcher] re-indexing: ${filePath}`);
      const result = await ingestFile(filePath);
      console.log(
        `[watcher] ${result.status}: ${filePath}` +
        `${result.chunks ? ` (${result.chunks} chunks)` : ""}` +
        `${result.error ? ` — ${result.error}` : ""}`
      );
    }, DEBOUNCE_MS)
  );
}

/**
 * Start an FS watcher on a directory (recursive). Does NOT persist to the DB.
 * Safe to call multiple times — duplicates ignored.
 * Internal use only; callers that want persistence should use registerDir().
 */
export function watchDir(dir: string) {
  if (watchers.has(dir)) return;
  if (!existsSync(dir)) return;

  try {
    const w = watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const filePath = `${dir}/${filename}`;
      scheduleReindex(filePath);
    });

    w.on("error", (err) => {
      console.warn(`[watcher] error watching ${dir}: ${err.message}`);
      watchers.delete(dir);
    });

    watchers.set(dir, w);
    console.log(`[watcher] watching: ${dir}`);
  } catch (err) {
    console.warn(`[watcher] could not watch ${dir}: ${String(err)}`);
  }
}

/**
 * Register a root directory: persist it to watched_dirs (so it survives
 * restarts) and start watching it. Only the root is stored — subdirectories
 * are covered by the recursive watcher and discovered at scan time.
 * Safe to call multiple times — duplicates ignored.
 */
export function registerDir(dir: string) {
  if (!existsSync(dir)) return;
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO watched_dirs (path, added_at) VALUES (?, ?)",
    [dir, Date.now()]
  );
  watchDir(dir);
}

/**
 * Stop watching a directory and remove it from watched_dirs.
 * Also stops any child watchers that were started for subdirectories.
 */
export function unwatchDir(dir: string) {
  // Stop the watcher for this dir and any child dirs that were individually registered
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  for (const key of Array.from(watchers.keys())) {
    if (key === dir || key.startsWith(prefix)) {
      watchers.get(key)?.close();
      watchers.delete(key);
    }
  }
  const db = getDb();
  // Remove this entry and any subdir entries that were accumulated previously
  db.run("DELETE FROM watched_dirs WHERE path = ? OR path LIKE ? || '/%'", [dir, dir]);
  console.log(`[watcher] unwatched: ${dir}`);
}

/** Returns the list of currently active watched directories. */
export function getWatchedDirs(): string[] {
  return Array.from(watchers.keys());
}

/**
 * On API startup: restore watched dirs from the DB and start watchers.
 * Only the stored root paths are watched — subdirs are covered recursively.
 */
export function startWatchingIndexedPaths() {
  const db = getDb();

  // Primary source: persisted watched_dirs table
  const saved = db
    .query<{ path: string }, []>("SELECT path FROM watched_dirs ORDER BY added_at")
    .all();

  // Fallback: derive dirs from document paths (handles DB migrated without watched_dirs)
  if (saved.length === 0) {
    const docs = db
      .query<{ path: string }, []>("SELECT DISTINCT path FROM documents")
      .all();
    const seen = new Set<string>();
    for (const row of docs as { path: string }[]) {
      const { dirname } = require("path") as typeof import("path");
      seen.add(dirname(row.path));
    }
    for (const dir of Array.from(seen)) {
      registerDir(dir);
    }
    const migDirs = Array.from(seen);
    console.log(`[watcher] started watching ${migDirs.length} director${migDirs.length === 1 ? "y" : "ies"} (migrated)`);
    scanForMissedFiles(migDirs).catch((e: unknown) =>
      console.error("[startup-scan] unexpected error:", e)
    );
    return;
  }

  // Start a watcher for each stored root (recursive — covers all subdirs)
  const roots = (saved as { path: string }[]).map((r) => r.path);
  for (const dir of roots) {
    watchDir(dir); // watchDir only, not registerDir — already in DB
  }
  console.log(`[watcher] started watching ${roots.length} root director${roots.length === 1 ? "y" : "ies"}`);

  // Fire-and-forget background scan for files added/changed/deleted while offline
  scanForMissedFiles(roots).catch((e: unknown) =>
    console.error("[startup-scan] unexpected error:", e)
  );
}

/** Recursively walk a directory and return all supported file paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full));
      } else if (entry.isFile() && isSupportedFile(full)) {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results;
}

export interface ScanResult {
  newCount: number;
  updatedCount: number;
  removedCount: number;
  skippedCount: number;
  failed: { path: string; error: string }[];
}

export interface ScanProgress {
  current: number;
  total: number;
}

/**
 * Scan a set of directories for new, modified, and deleted files.
 * Safe to call at any time — exported so the API can trigger on-demand rescans.
 * Runs sequentially to avoid hammering Ollama.
 *
 * @param onProgress Optional callback invoked after each file is processed.
 */
export async function scanForMissedFiles(
  dirs: string[],
  onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
  console.log(`[scan] scanning ${dirs.length} director${dirs.length === 1 ? "y" : "ies"}…`);

  const db = getDb();
  let newCount = 0, updatedCount = 0, removedCount = 0, skippedCount = 0;
  const failed: { path: string; error: string }[] = [];

  // Pre-count all files so we can report meaningful progress totals
  const allDiskFiles: string[] = [];
  for (const dir of dirs) {
    if (existsSync(dir)) allDiskFiles.push(...walkDir(dir));
  }
  const total = allDiskFiles.length;
  let current = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    // --- 1. Find files on disk that are new or modified ---
    const diskFiles = walkDir(dir);

    for (const filePath of diskFiles) {
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
      } catch {
        current++;
        onProgress?.({ current, total });
        continue;
      }

      const row = db
        .query<{ mtime: number }, string>(
          "SELECT mtime FROM documents WHERE path = ?"
        )
        .get(filePath);

      if (!row || stat.mtimeMs > row.mtime) {
        console.log(`[scan] processing (${current + 1}/${total}): ${filePath}`);
        let result: Awaited<ReturnType<typeof ingestFile>>;
        try {
          result = await Promise.race([
            ingestFile(filePath),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("ingest timed out after 60s")), 60_000)
            ),
          ]);
        } catch (e) {
          const error = String(e);
          console.warn(`[scan] timeout/error: ${filePath} — ${error}`);
          failed.push({ path: filePath, error });
          current++;
          onProgress?.({ current, total });
          continue;
        }
        if (!row) {
          if (result.status === "indexed") {
            newCount++;
          } else if (result.status === "error") {
            console.warn(`[scan] error: ${filePath} — ${result.error}`);
            failed.push({ path: filePath, error: result.error ?? "Unknown error" });
          }
        } else {
          if (result.status === "indexed") updatedCount++;
          else if (result.status === "error") {
            failed.push({ path: filePath, error: result.error ?? "Unknown error" });
          } else {
            skippedCount++;
          }
        }
      } else {
        skippedCount++;
      }

      current++;
      onProgress?.({ current, total });
    }

    // --- 2. Find DB docs under this dir that no longer exist on disk ---
    const dbDocs = db
      .query<{ id: number; path: string }, string>(
        "SELECT id, path FROM documents WHERE path LIKE ? || '%'"
      )
      .all(dir);

    for (const doc of dbDocs) {
      if (!existsSync(doc.path)) {
        db.run("DELETE FROM documents WHERE id = ?", [doc.id]);
        db.run("DELETE FROM failed_files WHERE path = ?", [doc.path]);
        console.log(`[scan] removed deleted file: ${doc.path}`);
        removedCount++;
      }
    }
  }

  console.log(
    `[scan] done — ${newCount} new, ${updatedCount} updated, ${removedCount} removed, ${skippedCount} skipped, ${failed.length} failed`
  );

  return { newCount, updatedCount, removedCount, skippedCount, failed };
}

export function stopAllWatchers() {
  watchers.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
