import { Elysia, t } from "elysia";
import { retrieve, chat } from "@localsearch/core";

const SYSTEM_PROMPT = `You are a helpful assistant. Answer questions based ONLY on the provided document excerpts.
For each claim you make, cite the source document and page number if available.
If the answer cannot be found in the excerpts, say "I don't have enough information in the indexed documents to answer that."
Be concise and accurate.`;

export const queryRoute = new Elysia({ prefix: "/query" }).post(
  "/",
  async ({ body, set }) => {
    const { question, topK = 5 } = body;

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const chunks = await retrieve(question, topK);

    if (chunks.length === 0) {
      return new Response(
        `data: ${JSON.stringify({ type: "error", message: "No relevant documents found. Please index some documents first." })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const context = chunks
      .map((c, i) => {
        const pageRef = c.page ? ` (page ${c.page})` : "";
        return `[${i + 1}] Source: ${c.title}${pageRef}\n${c.text}`;
      })
      .join("\n\n---\n\n");

    const userMessage = `Document excerpts:\n\n${context}\n\nQuestion: ${question}`;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Stream tokens
        for await (const token of chat(SYSTEM_PROMPT, userMessage)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "token", content: token })}\n\n`)
          );
        }

        // Send citations
        const citations = chunks.map((c) => ({
          path: c.path,
          title: c.title,
          page: c.page,
          excerpt: c.text.slice(0, 200),
          score: c.score,
        }));
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "citations", citations })}\n\n`
          )
        );
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
  {
    body: t.Object({
      question: t.String({ minLength: 1, description: "Natural language question" }),
      topK: t.Optional(t.Number({ minimum: 1, maximum: 20, description: "Number of chunks to retrieve" })),
    }),
    detail: { tags: ["rag"], summary: "Ask a question (RAG, streaming SSE)" },
  }
);
