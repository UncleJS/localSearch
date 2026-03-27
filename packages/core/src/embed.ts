import { loadConfig } from "./config";

export async function embed(text: string): Promise<number[]> {
  const cfg = loadConfig();
  const res = await fetch(`${cfg.ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.embeddingModel, prompt: text }),
  });

  const rawText = await res.text();

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
  model?: string
): AsyncGenerator<string> {
  const cfg = loadConfig();
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model ?? cfg.chatModel,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama chat error ${res.status}: ${await res.text()}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
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
