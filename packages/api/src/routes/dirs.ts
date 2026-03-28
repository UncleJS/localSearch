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
      detail: {
        tags: ["index"],
        summary: "List all watched directories",
        description: `Returns all watched root directories with aggregate document and chunk counts for each root.

Example response:
{"total":1,"dirs":[{"id":1,"path":"/home/user/Documents","docCount":423,"chunkCount":11234,"addedAt":"2026-03-28T10:00:00.000Z"}]}`,
      },
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
      detail: {
        tags: ["index"],
        summary: "Remove a watched directory and all its documents",
        description: `Stops watching the directory, removes its watched entry, and deletes all indexed documents/chunks under that path prefix.

Example request body:
{"path":"/home/user/Documents/old-archive"}

Example response:
{"message":"Removed directory from index","path":"/home/user/Documents/old-archive","documentsRemoved":128}`,
      },
    }
  );
