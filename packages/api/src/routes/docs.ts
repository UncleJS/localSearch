import { Elysia, t } from "elysia";
import { getDb } from "@localsearch/core";

export const docsRoute = new Elysia({ prefix: "/docs" }).get(
  "/",
  ({ query }) => {
    const db = getDb();
    const { page = 1, limit = 50 } = query;
    const offset = (page - 1) * limit;

    const total = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents")
      .get([])!.count;

    const docs = db
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

    return {
      total,
      page,
      limit,
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
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
    }),
    detail: { tags: ["index"], summary: "List all indexed documents" },
  }
);
