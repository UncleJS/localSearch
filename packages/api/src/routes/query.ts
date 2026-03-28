import { Elysia, t } from "elysia";
import { retrieve, chat } from "@localsearch/core";

type QueryMode = "fast" | "balanced" | "accurate";

interface QueryProfile {
  defaultTopK: number;
  maxTopK: number;
  maxCharsPerChunk: number;
  maxTotalContextChars: number;
  numPredict: number;
  temperature: number;
  systemPrompt: string;
}

const GLOBAL_MAX_TOP_K = 8;
const DEFAULT_MODE: QueryMode = "accurate";

const QUERY_PROFILES: Record<QueryMode, QueryProfile> = {
  fast: {
    defaultTopK: 2,
    maxTopK: 4,
    maxCharsPerChunk: 350,
    maxTotalContextChars: 1200,
    numPredict: 48,
    temperature: 0.1,
    systemPrompt: `Answer using ONLY the provided excerpts.
Keep the answer very short (max 2 short sentences).
If the answer is not in the excerpts, say you do not have enough information.`,
  },
  balanced: {
    defaultTopK: 3,
    maxTopK: 6,
    maxCharsPerChunk: 550,
    maxTotalContextChars: 1900,
    numPredict: 72,
    temperature: 0.1,
    systemPrompt: `Answer using ONLY the provided excerpts.
Be concise but include key facts when evidence is present.
If the answer is not in the excerpts, say you do not have enough information.`,
  },
  accurate: {
    defaultTopK: 4,
    maxTopK: 8,
    maxCharsPerChunk: 700,
    maxTotalContextChars: 2600,
    numPredict: 96,
    temperature: 0.1,
    systemPrompt: `Answer using ONLY the provided excerpts.
Prioritize factual accuracy and completeness over brevity.
When enough evidence exists, provide a clear answer in up to 5 short sentences.
If the answer is not in the excerpts, say you do not have enough information.`,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function buildPromptContext(
  chunks: Array<{ title: string; page: number | null; text: string }>,
  profile: Pick<QueryProfile, "maxCharsPerChunk" | "maxTotalContextChars">
): string {
  let remaining = profile.maxTotalContextChars;
  const parts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (remaining <= 0) break;
    const c = chunks[i];
    const limit = Math.min(profile.maxCharsPerChunk, remaining);
    const clipped = c.text.slice(0, limit).trim();
    if (!clipped) continue;

    const pageRef = c.page ? ` (page ${c.page})` : "";
    parts.push(`[${i + 1}] Source: ${c.title}${pageRef}\n${clipped}`);
    remaining -= clipped.length;
  }

  return parts.join("\n\n---\n\n");
}

export const queryRoute = new Elysia({ prefix: "/query" }).post(
  "/",
  async ({ body }) => {
    const { question, topK, mode = DEFAULT_MODE } = body;
    const profile = QUERY_PROFILES[mode];
    const requestedTopK = topK ?? profile.defaultTopK;
    const effectiveTopK = clamp(requestedTopK, 1, profile.maxTopK);

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const send = async (payload: unknown) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };

    const sendDoneAndClose = async () => {
      try {
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch {
        // client disconnected
      }
      try {
        await writer.close();
      } catch {
        // already closed
      }
    };

    (async () => {
      try {
        await send({ type: "status", message: "Searching documents..." });

        const chunks = await retrieve(question, effectiveTopK, profile.maxCharsPerChunk);

        if (chunks.length === 0) {
          await send({
            type: "error",
            message: "No relevant documents found. Please index some documents first.",
          });
          await sendDoneAndClose();
          return;
        }

        const context = buildPromptContext(chunks, profile);
        if (!context) {
          await send({ type: "error", message: "No usable text found in retrieved chunks." });
          await sendDoneAndClose();
          return;
        }

        const userMessage = `Document excerpts:\n\n${context}\n\nQuestion: ${question}`;

        await send({ type: "status", message: "Generating answer..." });

        for await (const token of chat(profile.systemPrompt, userMessage, undefined, {
          numPredict: profile.numPredict,
          temperature: profile.temperature,
        })) {
          await send({ type: "token", content: token });
        }

        const citations = chunks.map((c) => ({
          path: c.path,
          title: c.title,
          page: c.page,
          excerpt: c.text.slice(0, 200),
          score: c.score,
        }));

        await send({ type: "citations", citations });
      } catch (error) {
        try {
          await send({
            type: "error",
            message: error instanceof Error ? error.message : "Query failed.",
          });
        } catch {
          // client disconnected
        }
      } finally {
        await sendDoneAndClose();
      }
    })();

    return new Response(readable, {
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
      mode: t.Optional(
        t.Union([
          t.Literal("fast"),
          t.Literal("balanced"),
          t.Literal("accurate"),
        ], { description: "Accuracy/speed mode" })
      ),
      topK: t.Optional(t.Number({ minimum: 1, maximum: GLOBAL_MAX_TOP_K, description: "Number of chunks to retrieve" })),
    }),
    detail: { tags: ["rag"], summary: "Ask a question (RAG, streaming SSE)" },
  }
);
