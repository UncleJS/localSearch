import { getDb } from "./db";
import { embed } from "./embed";

export interface RetrievedChunk {
  chunkId: number;
  docId: number;
  path: string;
  title: string;
  page: number | null;
  text: string;
  score: number;
}

interface VecRow { chunk_id: number; distance: number }
interface FtsRow { id: number; rank: number }
interface ChunkRow {
  id: number;
  doc_id: number;
  path: string;
  title: string;
  page: number | null;
  text: string;
}

/**
 * Hybrid retrieval: KNN vector search + BM25 FTS5, fused via Reciprocal Rank Fusion.
 */
export async function retrieve(
  question: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  const db = getDb();
  const queryVec = await embed(question);

  // 1. KNN vector search (cosine similarity via sqlite-vec)
  const vecResults = db
    .query<VecRow, [string, number]>(
      `SELECT chunk_id, distance
       FROM vec_chunks
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(JSON.stringify(queryVec), topK * 4);

  // 2. BM25 full-text search
  const ftsResults = db
    .query<FtsRow, [string, number]>(
      `SELECT rowid AS id, rank
       FROM chunks_fts
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(sanitizeFtsQuery(question), topK * 4);

  // 3. Reciprocal Rank Fusion
  const k = 60;
  const scores = new Map<number, number>();

  vecResults.forEach((r: VecRow, rank: number) => {
    scores.set(r.chunk_id, (scores.get(r.chunk_id) ?? 0) + 1 / (k + rank + 1));
  });

  ftsResults.forEach((r: FtsRow, rank: number) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
  });

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  if (sorted.length === 0) return [];

  // 4. Fetch full chunk data
  const placeholders = sorted.map(() => "?").join(",");
  const ids = sorted.map(([id]) => id);

  const rows = db
    .query<ChunkRow, number[]>(
      `SELECT c.id, c.doc_id, d.path, d.title, c.page, c.text
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id
       WHERE c.id IN (${placeholders})`
    )
    .all(...ids);

  // Preserve RRF order
  const idToRow = new Map<number, ChunkRow>(rows.map((r: ChunkRow) => [r.id, r] as [number, ChunkRow]));

  return sorted
    .map(([id, score]) => {
      const row = idToRow.get(id);
      if (!row) return null;
      return {
        chunkId: row.id,
        docId: row.doc_id,
        path: row.path,
        title: row.title,
        page: row.page,
        text: row.text,
        score,
      };
    })
    .filter((x): x is RetrievedChunk => x !== null);
}

/** Escape special FTS5 chars to avoid query parse errors */
function sanitizeFtsQuery(q: string): string {
  return q.replace(/[^a-zA-Z0-9 ]/g, " ").trim() + "*";
}
