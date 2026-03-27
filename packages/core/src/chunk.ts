import type { Tiktoken } from "tiktoken";

// Lazy-load tiktoken to avoid startup cost
let enc: Tiktoken | null = null;
async function getEncoder(): Promise<Tiktoken> {
  if (!enc) {
    const { get_encoding } = await import("tiktoken");
    enc = get_encoding("cl100k_base");
  }
  return enc;
}

export interface Chunk {
  text: string;
  seq: number;
  page?: number;
}

export interface PagedText {
  text: string;
  page?: number;
}

/**
 * Split an array of paged-text segments into token-bounded chunks.
 * Splits on sentence boundaries where possible.
 */
export async function chunkPagedTexts(
  segments: PagedText[],
  chunkSize = 512,
  overlap = 64
): Promise<Chunk[]> {
  const encoder = await getEncoder();
  const chunks: Chunk[] = [];
  let seq = 0;

  for (const seg of segments) {
    const sentences = seg.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let buffer: string[] = [];
    let bufTokens = 0;

    for (const sentence of sentences) {
      const tokens = encoder.encode(sentence).length;

      if (bufTokens + tokens > chunkSize && buffer.length > 0) {
        chunks.push({ text: buffer.join(" "), seq: seq++, page: seg.page });

        // Keep overlap: drop sentences from the front until within overlap budget
        while (bufTokens > overlap && buffer.length > 0) {
          const dropped = buffer.shift()!;
          bufTokens -= encoder.encode(dropped).length;
        }
      }

      buffer.push(sentence);
      bufTokens += tokens;
    }

    if (buffer.length > 0) {
      chunks.push({ text: buffer.join(" "), seq: seq++, page: seg.page });
    }
  }

  return chunks;
}

export async function chunkText(
  text: string,
  chunkSize = 512,
  overlap = 64
): Promise<Chunk[]> {
  return chunkPagedTexts([{ text }], chunkSize, overlap);
}
