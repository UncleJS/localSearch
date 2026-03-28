import { Elysia, t } from "elysia";
import { getDb, unwatchDir } from "@localsearch/core";

export const dirsRoute = new Elysia({ prefix: "/dirs" })
  .get(
    "/",
    () => {
      const db = getDb();

      const dirs = db
        .query<
          { id: number; path: string; added_at: number; doc_count: number; chunk_count: number },
          []
        >(
          `SELECT
             wd.id,
             wd.path,
             wd.added_at,
             COUNT(DISTINCT d.id)  AS doc_count,
             COUNT(c.id)           AS chunk_count
           FROM watched_dirs wd
           LEFT JOIN documents d  ON d.path LIKE wd.path || '%'
           LEFT JOIN chunks c     ON c.doc_id = d.id
           GROUP BY wd.id
           ORDER BY wd.added_at ASC`
        )
        .all();

      return {
        total: dirs.length,
        dirs: dirs.map((r) => ({
          id: r.id,
          path: r.path,
          docCount: r.doc_count,
          chunkCount: r.chunk_count,
          addedAt: new Date(r.added_at).toISOString(),
        })),
      };
    },
    {
      detail: { tags: ["index"], summary: "List all watched directories" },
    }
  )
  .delete(
    "/",
    ({ body }) => {
      const { path } = body;
      const db = getDb();

      // Check it exists
      const row = db
        .query<{ id: number }, string>("SELECT id FROM watched_dirs WHERE path = ?")
        .get(path);

      if (!row) {
        return { error: "Directory not found in watched list" };
      }

      // Delete all documents whose path starts with this directory
      const deleted = db
        .query<{ count: number }, string>(
          "SELECT COUNT(*) AS count FROM documents WHERE path LIKE ? || '%'"
        )
        .get(path)!.count;

      db.run("DELETE FROM documents WHERE path LIKE ? || '%'", [path]);

      // Stop watcher + remove from watched_dirs
      unwatchDir(path);

      return {
        message: `Removed directory from index`,
        path,
        documentsRemoved: deleted,
      };
    },
    {
      body: t.Object({
        path: t.String({ description: "Directory path to remove from index" }),
      }),
      detail: { tags: ["index"], summary: "Remove a watched directory and all its documents" },
    }
  );
