import { Elysia, t } from "elysia";
import { getDb } from "@localsearch/core";

export const docsRoute = new Elysia({ prefix: "/docs" }).get(
  "/",
  ({ query }) => {
    const db = getDb();
    const { page = 1, limit = 50, search } = query;
    const offset = (page - 1) * limit;
    const term = search?.trim();

    let total: number;
    let docs: {
      id: number;
      path: string;
      title: string;
      hash: string;
      mtime: number;
      indexed_at: number;
      chunk_count: number;
    }[];

    if (term) {
      const like = `%${term}%`;
      total = db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM documents WHERE path LIKE ? OR title LIKE ?"
        )
        .get(like, like)!.count;

      docs = db
        .query<
          {
            id: number;
            path: string;
            title: string;
            hash: string;
            mtime: number;
            indexed_at: number;
            chunk_count: number;
          },
          [string, string, number, number]
        >(
          `SELECT d.id, d.path, d.title, d.hash, d.mtime, d.indexed_at,
                  COUNT(c.id) AS chunk_count
           FROM documents d
           LEFT JOIN chunks c ON c.doc_id = d.id
           WHERE d.path LIKE ? OR d.title LIKE ?
           GROUP BY d.id
           ORDER BY d.indexed_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(like, like, limit, offset);
    } else {
      total = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents")
        .get()!.count;

      docs = db
        .query<
          {
            id: number;
            path: string;
            title: string;
            hash: string;
            mtime: number;
            indexed_at: number;
            chunk_count: number;
          },
          [number, number]
        >(
          `SELECT d.id, d.path, d.title, d.hash, d.mtime, d.indexed_at,
                  COUNT(c.id) AS chunk_count
           FROM documents d
           LEFT JOIN chunks c ON c.doc_id = d.id
           GROUP BY d.id
           ORDER BY d.indexed_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(limit, offset);
    }

    return {
      total,
      page,
      limit,
      search: term ?? null,
      documents: docs.map((d) => ({
        id: d.id,
        path: d.path,
        title: d.title,
        chunkCount: d.chunk_count,
        indexedAt: new Date(d.indexed_at).toISOString(),
        modifiedAt: new Date(d.mtime).toISOString(),
      })),
    };
  },
  {
    query: t.Object({
      page: t.Optional(t.Numeric({ minimum: 1 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 1000 })),
      search: t.Optional(t.String({ description: "Filter by path or title (case-insensitive substring)" })),
    }),
    detail: { tags: ["index"], summary: "List all indexed documents" },
  }
);
