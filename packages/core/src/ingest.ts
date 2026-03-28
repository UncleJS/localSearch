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

const DEFAULT_INDEX_CONCURRENCY = 4;
const MAX_INDEX_CONCURRENCY = 8;
const DEFAULT_INDEX_PROFILE = "default";
const FAST_INDEX_PROFILE_CHUNK_SIZE = 1024;
const FAST_INDEX_PROFILE_CHUNK_OVERLAP = 32;

type IndexProfile = "default" | "fast";

interface IngestChunking {
  chunkSize: number;
  chunkOverlap: number;
}

function getIndexConcurrency(): number {
  const raw = Number(process.env.LOCALSEARCH_INDEX_CONCURRENCY ?? DEFAULT_INDEX_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_INDEX_CONCURRENCY;
  return Math.min(Math.floor(raw), MAX_INDEX_CONCURRENCY);
}

function getIndexProfile(): IndexProfile {
  const raw = (process.env.LOCALSEARCH_INDEX_PROFILE ?? DEFAULT_INDEX_PROFILE).toLowerCase();
  return raw === "fast" ? "fast" : "default";
}

function getIngestChunking(cfg: { chunkSize: number; chunkOverlap: number }): IngestChunking {
  const profile = getIndexProfile();

  if (profile === "fast") {
    const chunkSize = Math.max(cfg.chunkSize, FAST_INDEX_PROFILE_CHUNK_SIZE);
    const chunkOverlap = Math.max(
      0,
      Math.min(Math.min(cfg.chunkOverlap, FAST_INDEX_PROFILE_CHUNK_OVERLAP), chunkSize - 1)
    );

    return { chunkSize, chunkOverlap };
  }

  return {
    chunkSize: Math.max(1, cfg.chunkSize),
    chunkOverlap: Math.max(0, Math.min(cfg.chunkOverlap, Math.max(0, cfg.chunkSize - 1))),
  };
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
    const result = await _ingestFile(filePath);
    // Persist failure / clear it — single authoritative place for all callers
    const db = getDb();
    if (result.status === "error") {
      db.run(
        "INSERT OR REPLACE INTO failed_files (path, error, failed_at) VALUES (?, ?, ?)",
        [filePath, result.error ?? "Unknown error", Date.now()]
      );
    } else {
      // "indexed" or "skipped" — either way the file is clean; remove any stale failure record
      db.run("DELETE FROM failed_files WHERE path = ?", [filePath]);
    }
    return result;
  } catch (e) {
    const error = String(e);
    try {
      const db = getDb();
      db.run(
        "INSERT OR REPLACE INTO failed_files (path, error, failed_at) VALUES (?, ?, ?)",
        [filePath, error, Date.now()]
      );
    } catch { /* DB not available — ignore */ }
    return { path: filePath, status: "error", error };
  }
}

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB hard limit
const MAX_EMBED_CHARS = 6000;

async function embedChunks(chunks: { text: string }[]): Promise<number[][]> {
  if (chunks.length === 0) return [];

  const concurrency = Math.min(getIndexConcurrency(), chunks.length);
  const embeddings = new Array<number[]>(chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= chunks.length) return;

      const text = chunks[i].text.length > MAX_EMBED_CHARS
        ? chunks[i].text.slice(0, MAX_EMBED_CHARS)
        : chunks[i].text;

      try {
        embeddings[i] = await embed(text);
      } catch (e) {
        // If embedding fails (e.g. Ollama overloaded), keep indices aligned with a zero vector.
        console.warn(
          `  [embed] skipped chunk ${i + 1}/${chunks.length} (${text.length} chars): ${String(e).slice(0, 120)}`
        );
        embeddings[i] = new Array(768).fill(0);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return embeddings;
}

async function _ingestFile(filePath: string): Promise<IngestResult> {
  const cfg = loadConfig();
  const db = getDb();
  const chunking = getIngestChunking(cfg);

  // Size guard — skip files that are too large to process safely
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return {
      path: filePath,
      status: "error",
      error: `File too large to index (${(stat.size / 1024 / 1024).toFixed(1)} MB > 50 MB limit)`,
    };
  }

  // Hash check: skip if unchanged
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

  // Chunk (profile-controlled; "fast" increases chunk size and reduces overlap)
  const chunks = await chunkPagedTexts(segments, chunking.chunkSize, chunking.chunkOverlap);
  if (chunks.length === 0) {
    return { path: filePath, status: "error", error: "No text extracted" };
  }

  // Embed all chunks concurrently (bounded), preserving chunk order.
  const embeddings = await embedChunks(chunks);

  // Upsert into DB (transaction)
  db.transaction(() => {
    // Remove any existing rows for this path (handles duplicates from prior crashes)
    db.run("DELETE FROM documents WHERE path = ?", [filePath]);

    // Insert document record
    db.run(
      `INSERT INTO documents (path, title, hash, mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [filePath, basename(filePath), hash, Math.floor(stat.mtimeMs), Date.now()]
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
        .get()!.id;

      // Store embedding as JSON array (sqlite-vec expects BLOB or JSON)
      db.run(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        [chunkId, JSON.stringify(embeddings[i])]
      );
    }
  })();

  return { path: filePath, status: "indexed", chunks: chunks.length };
}
