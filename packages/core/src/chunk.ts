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

function splitOversizedSentence(
  sentence: string,
  encoder: Tiktoken,
  chunkSize: number
): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const parts: string[] = [];
  let buffer: string[] = [];
  let bufTokens = 0;

  for (const word of words) {
    const wordTokens = encoder.encode(word).length;

    // Extremely long single token-like strings: hard-split by characters.
    if (wordTokens > chunkSize) {
      if (buffer.length > 0) {
        parts.push(buffer.join(" "));
        buffer = [];
        bufTokens = 0;
      }
      for (let i = 0; i < word.length; i += 500) {
        parts.push(word.slice(i, i + 500));
      }
      continue;
    }

    const extra = buffer.length === 0
      ? wordTokens
      : encoder.encode(` ${word}`).length;

    if (bufTokens + extra > chunkSize && buffer.length > 0) {
      parts.push(buffer.join(" "));
      buffer = [word];
      bufTokens = wordTokens;
      continue;
    }

    buffer.push(word);
    bufTokens += extra;
  }

  if (buffer.length > 0) {
    parts.push(buffer.join(" "));
  }

  return parts;
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

      if (tokens > chunkSize) {
        if (buffer.length > 0) {
          chunks.push({ text: buffer.join(" "), seq: seq++, page: seg.page });
          buffer = [];
          bufTokens = 0;
        }

        const parts = splitOversizedSentence(sentence, encoder, chunkSize);
        for (const part of parts) {
          chunks.push({ text: part, seq: seq++, page: seg.page });
        }
        continue;
      }

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
