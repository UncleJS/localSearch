import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { loadConfig } from "./config";
import { getLoadablePath } from "sqlite-vec";

// sqlite-vec is loaded as a native extension via the sqlite-vec npm package
let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const cfg = loadConfig();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });

  const db = new Database(cfg.dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  db.run("PRAGMA synchronous=NORMAL");

  // Load sqlite-vec extension — hard fail so the user gets a clear error
  db.loadExtension(getLoadablePath());

  migrate(db);
  _db = db;
  return db;
}

function migrate(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT UNIQUE NOT NULL,
      title       TEXT,
      hash        TEXT NOT NULL,
      mtime       INTEGER NOT NULL,
      indexed_at  INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      seq     INTEGER NOT NULL,
      text    TEXT NOT NULL,
      page    INTEGER
    )
  `);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, content=chunks, content_rowid=id)
  `);

  // sqlite-vec virtual table for cosine similarity KNN
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
      USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[768]
      )
  `);

  // Watched directories — persisted so they survive API restarts
  db.run(`
    CREATE TABLE IF NOT EXISTS watched_dirs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      path     TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    )
  `);

  // Failed files — persisted so failures survive restarts and are queryable
  db.run(`
    CREATE TABLE IF NOT EXISTS failed_files (
      path       TEXT PRIMARY KEY,
      error      TEXT NOT NULL,
      failed_at  INTEGER NOT NULL
    )
  `);

  // Migration: collapse any accumulated subdir entries down to their roots.
  // Any row whose path starts with another row's path + '/' is redundant —
  // the parent's recursive watcher already covers it.
  db.run(`
    DELETE FROM watched_dirs
    WHERE EXISTS (
      SELECT 1 FROM watched_dirs AS parent
      WHERE parent.path != watched_dirs.path
        AND watched_dirs.path LIKE parent.path || '/%'
    )
  `);

  // Triggers to keep FTS in sync
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert
      AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete
      AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
      END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_update
      AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END
  `);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
