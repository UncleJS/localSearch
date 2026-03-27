import { Elysia, t } from "elysia";
import { readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { ingestFile, isSupportedFile, getDb } from "@localsearch/core";

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
  .post(
    "/index",
    async ({ body }) => {
      const { path, recursive = true } = body;
      const results: { path: string; status: string; chunks?: number; error?: string }[] = [];

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

      for (const file of files) {
        const result = await ingestFile(file);
        results.push(result);
      }

      const indexed = results.filter((r) => r.status === "indexed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const errors = results.filter((r) => r.status === "error").length;

      return {
        message: `Indexing complete: ${indexed} indexed, ${skipped} skipped, ${errors} errors`,
        total: files.length,
        indexed,
        skipped,
        errors,
        results,
      };
    },
    {
      body: t.Object({
        path: t.String({ description: "File or directory path to index" }),
        recursive: t.Optional(t.Boolean({ description: "Recurse into subdirectories (default: true)" })),
      }),
      detail: { tags: ["index"], summary: "Index a file or directory" },
    }
  )
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
      detail: { tags: ["index"], summary: "Remove a document from the index" },
    }
  );
