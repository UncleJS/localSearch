import { loadConfig } from "./config";

const EMBED_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function embed(text: string): Promise<number[]> {
  const cfg = loadConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${cfg.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.embeddingModel, prompt: text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await withTimeout(
    res.text(),
    EMBED_TIMEOUT_MS,
    "Ollama embed body read"
  );

  if (!res.ok) {
    throw new Error(`Ollama embed error ${res.status}: ${rawText.slice(0, 200)}`);
  }

  let data: { embedding: number[] };
  try {
    data = JSON.parse(rawText) as { embedding: number[] };
  } catch {
    throw new Error(`Ollama embed: invalid JSON response (status ${res.status}): ${rawText.slice(0, 200)}`);
  }

  if (!Array.isArray(data.embedding)) {
    throw new Error(`Ollama embed: missing embedding field in response: ${rawText.slice(0, 200)}`);
  }

  return data.embedding;
}

export async function* chat(
  systemPrompt: string,
  userMessage: string,
  model?: string,
  options?: {
    numPredict?: number;
    temperature?: number;
  }
): AsyncGenerator<string> {
  const cfg = loadConfig();
  let res: Response;
  try {
    const ollamaOptions: Record<string, number> = {};
    if (typeof options?.numPredict === "number") {
      ollamaOptions.num_predict = options.numPredict;
    }
    if (typeof options?.temperature === "number") {
      ollamaOptions.temperature = options.temperature;
    }

    res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model ?? cfg.chatModel,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Ollama chat timed out after ${CHAT_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!res.ok) {
    throw new Error(`Ollama chat error ${res.status}: ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error("Ollama chat returned no response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          if (json.message?.content) {
            yield json.message.content;
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer) as {
          message?: { content?: string };
        };
        if (json.message?.content) {
          yield json.message.content;
        }
      } catch {
        // skip malformed trailing line
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Ollama chat timed out after ${CHAT_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

export async function checkOllama(): Promise<boolean> {
  const cfg = loadConfig();
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
