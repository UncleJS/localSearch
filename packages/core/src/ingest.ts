import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { extname, basename } from "path";
import { getDb } from "./db";
import { embed } from "./embed";
import { chunkPagedTexts } from "./chunk";
import { loadConfig } from "./config";
import type { PagedText } from "./chunk";

// Parsers
import { parsePdf } from "./parsers/pdf";
import { parseDocx } from "./parsers/docx";
import { parseXlsx } from "./parsers/xlsx";
import { parseOdf } from "./parsers/odf";
import { parseText } from "./parsers/text";

export interface IngestResult {
  path: string;
  status: "indexed" | "skipped" | "error";
  chunks?: number;
  error?: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".odt", ".odp", ".ods",
  ".md", ".txt", ".csv", ".json",
]);

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function ingestFile(filePath: string): Promise<IngestResult> {
  try {
    return await _ingestFile(filePath);
  } catch (e) {
    return { path: filePath, status: "error", error: String(e) };
  }
}

async function _ingestFile(filePath: string): Promise<IngestResult> {
  const cfg = loadConfig();
  const db = getDb();

  // Hash check: skip if unchanged
  const stat = statSync(filePath);
  const content = readFileSync(filePath);
  const hash = createHash("sha256").update(content).digest("hex");

  const existing = db
    .query<{ hash: string; id: number }, string>(
      "SELECT hash, id FROM documents WHERE path = ?"
    )
    .get(filePath);

  if (existing && existing.hash === hash) {
    return { path: filePath, status: "skipped" };
  }

  // Parse document into paged text segments
  let segments: PagedText[];
  const ext = extname(filePath).toLowerCase();

  try {
    switch (ext) {
      case ".pdf":
        segments = await parsePdf(filePath);
        break;
      case ".docx":
        segments = await parseDocx(filePath);
        break;
      case ".xlsx":
        segments = await parseXlsx(filePath);
        break;
      case ".odt":
      case ".odp":
      case ".ods":
        segments = await parseOdf(filePath);
        break;
      default:
        segments = await parseText(filePath);
    }
  } catch (e) {
    return { path: filePath, status: "error", error: String(e) };
  }

  // Chunk
  const chunks = await chunkPagedTexts(segments, cfg.chunkSize, cfg.chunkOverlap);
  if (chunks.length === 0) {
    return { path: filePath, status: "error", error: "No text extracted" };
  }

  // Embed all chunks — truncate to 6000 chars if too long for the model context
  const MAX_EMBED_CHARS = 6000;
  const embeddings: number[][] = [];
  for (const chunk of chunks) {
    const text = chunk.text.length > MAX_EMBED_CHARS
      ? chunk.text.slice(0, MAX_EMBED_CHARS)
      : chunk.text;
    try {
      const vec = await embed(text);
      embeddings.push(vec);
    } catch (e) {
      // If embedding still fails (e.g. Ollama overloaded), skip this chunk
      console.warn(`  [embed] skipped chunk (${text.length} chars): ${String(e).slice(0, 80)}`);
      // push a zero vector as placeholder so indices stay aligned; chunk will be stored but won't match in KNN
      embeddings.push(new Array(768).fill(0));
    }
  }

  // Upsert into DB (transaction)
  db.transaction(() => {
    // Remove old document if re-indexing
    if (existing) {
      db.run("DELETE FROM documents WHERE id = ?", [existing.id]);
    }

    // Insert document record
    db.run(
      `INSERT INTO documents (path, title, hash, mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [filePath, basename(filePath), hash, stat.mtimeMs, Date.now()]
    );

    const docId = db
      .query<{ id: number }, string>(
        "SELECT id FROM documents WHERE path = ?"
      )
      .get(filePath)!.id;

    // Insert chunks + vectors
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      db.run(
        "INSERT INTO chunks (doc_id, seq, text, page) VALUES (?, ?, ?, ?)",
        [docId, chunk.seq, chunk.text, chunk.page ?? null]
      );
      const chunkId = db
        .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
        .get([])!.id;

      // Store embedding as JSON array (sqlite-vec expects BLOB or JSON)
      db.run(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        [chunkId, JSON.stringify(embeddings[i])]
      );
    }
  })();

  return { path: filePath, status: "indexed", chunks: chunks.length };
}
