import { Elysia, t } from "elysia";
import { retrieve } from "@localsearch/core";

export const searchRoute = new Elysia({ prefix: "/search" }).get(
  "/",
  async ({ query }) => {
    const { q, limit = 10 } = query;
    if (!q || q.trim().length === 0) {
      return { results: [] };
    }

    const chunks = await retrieve(q.trim(), Math.min(limit, 50));

    return {
      query: q,
      count: chunks.length,
      results: chunks.map((c) => ({
        chunkId: c.chunkId,
        docId: c.docId,
        path: c.path,
        title: c.title,
        page: c.page,
        excerpt: c.text.slice(0, 500),
        score: c.score,
      })),
    };
  },
  {
    query: t.Object({
      q: t.String({ description: "Search query" }),
      limit: t.Optional(
        t.Numeric({ minimum: 1, maximum: 50, description: "Max results" })
      ),
    }),
    detail: {
      tags: ["rag"],
      summary: "Semantic search (no LLM, returns chunks)",
      description: `Runs hybrid retrieval (vector + BM25 fusion) and returns matching chunk metadata and excerpts without generating an LLM answer.

Example request:
GET /search?q=budget+variance&limit=5

Example response:
{"query":"budget variance","count":2,"results":[{"chunkId":123,"docId":7,"path":"/docs/report.pdf","title":"report.pdf","page":4,"excerpt":"...","score":0.03}]}`,
    },
  }
);
