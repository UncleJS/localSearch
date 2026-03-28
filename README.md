# localSearch

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
![Bun](https://img.shields.io/badge/Bun-1.3%2B-black)
![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-5A67D8)
![Privacy](https://img.shields.io/badge/Privacy-Local%20Only-success)

A fully local, privacy-first RAG (Retrieval-Augmented Generation) document search engine. Ask natural language questions over your own documents — nothing leaves your machine.

<a id="toc"></a>

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick Start (development, 5 steps)](#quick-start-development-5-steps)
- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Usage](#cli-usage)
- [Web UI](#web-ui)
- [API Reference](#api-reference)
- [Query modes (speed vs accuracy)](#query-modes-speed-vs-accuracy)
- [Runtime environment variables](#runtime-environment-variables)
- [How it works](#how-it-works)
- [Supported file formats](#supported-file-formats)
- [Running as a service](#running-as-a-service)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [License](#license)

---

## Features

- **Fully offline** — Ollama runs locally, no cloud API keys needed
- **Hybrid search** — Vector similarity (KNN) + BM25 keyword search, fused with Reciprocal Rank Fusion
- **Streaming answers** — Token-by-token response with source citations
- **Query modes** — Fast / Balanced / Accurate tradeoff per question
- **Multi-format support** — PDF, DOCX, XLSX, ODT, ODP, ODS, Markdown, TXT, CSV
- **Smart re-indexing** — SHA-256 hash check skips unchanged files
- **Three interfaces** — Web UI, REST API, CLI
- **Single-file database** — `sqlite-vec` embedded in SQLite, zero infrastructure
- **AMD GPU support** — ROCm override for Radeon 780M / RDNA3 iGPU

[⬆ Go to TOC](#toc)

---

## Requirements

| Requirement | Version |
|---|---|
| Linux | Any modern distro |
| [Bun](https://bun.sh) | ≥ 1.3 |
| [Ollama](https://ollama.com) | Latest |
| Disk space | ~5 GB (models) + DB |
| RAM | 8 GB minimum, 16 GB+ recommended |

[⬆ Go to TOC](#toc)

---

## Quick Start (development, 5 steps)

```bash
# 1. Clone and install everything (Ollama + models + dependencies)
git clone <repo> localSearch && cd localSearch
bash install.sh

# 2. Index your documents
bun run cli index ~/Documents

# 3. Start the API server (keep running)
bun run api

# 4. Start the web UI (new terminal)
bun run web

# 5. Open browser
open http://localhost:5002
```

[⬆ Go to TOC](#toc)

---

## Installation

The `install.sh` script handles everything:

1. Checks for Linux
2. Installs Bun (if missing)
3. Installs Ollama (if missing)
4. Sets `HSA_OVERRIDE_GFX_VERSION=11.0.0` for AMD RDNA3 iGPU support
5. Starts the Ollama service
6. Pulls `nomic-embed-text` (embeddings) and `llama3.2:3b` (chat)
7. Runs `bun install` for all packages
8. Creates default config at `~/.config/localsearch/config.json`

```bash
bash install.sh
```

### AMD 780M / RDNA3 GPU note

The Radeon 780M is an integrated GPU (iGPU) using RDNA3 architecture (`gfx1103`). Ollama's ROCm build requires a version hint to recognize it:

```bash
export HSA_OVERRIDE_GFX_VERSION=11.0.0
```

The install script writes this to `/etc/profile.d/ollama-amd.sh` (system-wide) and `~/.bashrc` (user). If Ollama falls back to CPU, verify:

```bash
echo $HSA_OVERRIDE_GFX_VERSION   # should print: 11.0.0
ls /dev/kfd                       # should exist
```

[⬆ Go to TOC](#toc)

---

## Configuration

Config is stored at `~/.config/localsearch/config.json`:

```json
{
  "defaultPath": "~/Documents",
  "dbPath": "~/.config/localsearch/localsearch.db",
  "ollamaUrl": "http://localhost:11434",
  "embeddingModel": "nomic-embed-text",
  "chatModel": "llama3.2:3b",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "topK": 4,
  "apiPort": 5003,
  "webPort": 5002
}
```

### Configuration options

| Key | Default | Description |
|---|---|---|
| `defaultPath` | `~/Documents` | Directory used by `reindex` and the web UI index button |
| `dbPath` | `~/.config/localsearch/localsearch.db` | SQLite database location |
| `ollamaUrl` | `http://localhost:11434` | Ollama API base URL |
| `embeddingModel` | `nomic-embed-text` | Embedding model (768-dim, 8K context) |
| `chatModel` | `llama3.2:3b` | LLM for Q&A generation |
| `chunkSize` | `512` | Max tokens per chunk |
| `chunkOverlap` | `64` | Token overlap between chunks |
| `topK` | `4` | Default chunks retrieved per query |
| `apiPort` | `5003` | API server port |
| `webPort` | `5002` | Web UI port |

Change via CLI:
```bash
bun run cli config set defaultPath ~/Notes
bun run cli config set chatModel llama3.1:8b
```

Or via the web UI **Settings** page at `http://localhost:5002/settings`.

[⬆ Go to TOC](#toc)

---

## CLI Usage

```bash
# Index a directory (recursive, skips unchanged files)
bun run cli index ~/Documents
bun run cli index ~/Desktop/reports

# Index a single file
bun run cli index ./quarterly-report.pdf

# Ask a question (streaming answer + citations)
bun run cli query "What are the key findings in the Q3 report?"
bun run cli query "Summarize all meeting notes from last month"

# Semantic search (no LLM, returns top matching chunks)
bun run cli search "machine learning pipeline"
bun run cli search "budget 2024"

# List all indexed documents
bun run cli list

# Re-index the defaultPath (only processes new/modified files)
bun run cli reindex

# Configuration
bun run cli config get
bun run cli config set defaultPath ~/Notes
bun run cli config set chatModel llama3.1:8b
bun run cli config set topK 10
```

[⬆ Go to TOC](#toc)

---

## Web UI

Start with:
```bash
bun run web        # http://localhost:5002
```

### Chat page (`/`)

- Type a natural language question and press **Enter** or click **Send**
- Shift+Enter for multi-line questions
- Use **Mode** to choose speed/accuracy per query:
  - **Fast**: shortest latency, least context
  - **Balanced**: mid-point
  - **Accurate**: highest recall/context, slower
- Use the **Sources** slider to control chunks per query
  - Fast: 1–4
  - Balanced: 1–6
  - Accurate: 1–8
- Answers stream token-by-token
- Each answer shows **source citations**: file path, page number, and excerpt

The selected mode is remembered in your browser (`localStorage`) across page reloads.

### Documents page (`/docs`)

- Lists all indexed documents with chunk counts and index dates
- Enter a path and click **Index** to add new documents
- Hover a document row and click **Remove** to delete it from the index

### Settings page (`/settings`)

- Edit all configuration options visually
- Changes are saved to `~/.config/localsearch/config.json`

[⬆ Go to TOC](#toc)

---

## API Reference

API runs on port `5003`. Interactive docs: `http://localhost:5003/swagger`.

```bash
bun run api
```

### Endpoint map (current)

| Method | Path | Purpose |
|---|---|---|
| POST | `/query` | Streaming RAG answer (SSE) |
| GET | `/search` | Hybrid retrieval only (no LLM answer) |
| GET | `/index/status` | Background index/rescan progress |
| POST | `/index` | Start indexing file/directory |
| POST | `/index/rescan` | Drift scan watched roots |
| DELETE | `/index/:docId` | Remove indexed document |
| GET | `/docs` | Paginated indexed documents |
| GET | `/dirs` | Watched roots + counts |
| DELETE | `/dirs` | Remove watched root and its docs |
| GET | `/index/failures` | List failed file ingests |
| DELETE | `/index/failures` | Clear failure records |
| POST | `/index/failures/retry` | Retry all failed files |
| POST | `/index/failures/retry/:encodedPath` | Retry one failed file |
| GET | `/config` | Read runtime config |
| PUT | `/config` | Update config |
| GET | `/health` | Liveness check |

### Common examples

```bash
# Streaming RAG query (mode-aware)
curl -X POST http://localhost:5003/query \
  -H "Content-Type: application/json" \
  -d '{"question":"What changed this week?","mode":"balanced","topK":4}'

# Semantic search only
curl "http://localhost:5003/search?q=budget+variance&limit=10"

# Start indexing a root directory
curl -X POST http://localhost:5003/index \
  -H "Content-Type: application/json" \
  -d '{"path":"/home/user/Documents","recursive":true}'

# Watch/index status and failures
curl http://localhost:5003/index/status
curl "http://localhost:5003/index/failures?search=timeout"

# Read/update config
curl http://localhost:5003/config
curl -X PUT http://localhost:5003/config \
  -H "Content-Type: application/json" \
  -d '{"topK":6,"chunkSize":768}'
```

[⬆ Go to TOC](#toc)

---

## Query modes (speed vs accuracy)

Mode profiles are enforced server-side and applied to both API and Web queries:

| Mode | Default topK | Max topK | Context budget | Generation budget |
|---|---:|---:|---|---|
| `fast` | 2 | 4 | small | shortest answers |
| `balanced` | 3 | 6 | medium | medium answers |
| `accurate` | 4 | 8 | largest | longest answers |

`topK` in requests is still respected, but clamped to mode limits.

[⬆ Go to TOC](#toc)

---

## Runtime environment variables

These are not persisted to config; they affect the current process only:

| Variable | Default | Effect |
|---|---:|---|
| `LOCALSEARCH_INDEX_CONCURRENCY` | `4` | Concurrent embedding workers during ingest (max `8`) |
| `LOCALSEARCH_INDEX_PROFILE` | `default` | `fast` profile uses larger chunks + lower overlap for ingest |
| `LOCALSEARCH_STARTUP_RESCAN` | `0` (off) | Set to `1` to run startup drift scan of watched roots |

Examples:

```bash
LOCALSEARCH_INDEX_PROFILE=fast LOCALSEARCH_INDEX_CONCURRENCY=6 bun run cli index /path/to/large.pdf
LOCALSEARCH_STARTUP_RESCAN=1 bun run api
```

[⬆ Go to TOC](#toc)

---

## How it works

```
Documents (PDF/DOCX/XLSX/ODT/MD/TXT/CSV)
         │
         ▼ parse
   Extract text (per-page for PDFs)
         │
         ▼ chunk
   Split into 512-token windows
   with 64-token overlap at sentence boundaries
         │
         ▼ embed
   Ollama: nomic-embed-text → 768-dim float vector
         │
         ▼ store
   SQLite:  chunks table  +  chunks_fts (BM25)
   sqlite-vec: vec_chunks (KNN cosine similarity)
         │
    ─────┼──────────────────────────────
         │
   User question
         │
         ▼ embed question
   Ollama: nomic-embed-text
         │
         ├──► KNN candidates (cosine similarity, sqlite-vec)
         ├──► BM25 candidates (FTS5 keyword match)
         │
         ▼ RRF fusion
   Reciprocal Rank Fusion → top-K chunks (mode-dependent)
         │
         ▼ build prompt
   System: mode profile (fast/balanced/accurate)
   User:   bounded excerpts + question
         │
         ▼ chat (streaming)
   Ollama: llama3.2:3b → SSE token stream
         │
         ▼
   Answer + citations shown in UI / CLI
```

[⬆ Go to TOC](#toc)

---

## Supported file formats

| Extension | Parser |
|---|---|
| `.pdf` | `pdfjs-dist` (page-aware) |
| `.docx` | `mammoth` |
| `.xlsx` | `xlsx` |
| `.odt`, `.odp`, `.ods` | `jszip` + XML extraction |
| `.md`, `.txt`, `.csv` | Native string processing |
| `.json` | Native string processing |

[⬆ Go to TOC](#toc)

---

## Running as a service

To keep the API running after logout, create a systemd user service:

```bash
# Create service file
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/localsearch-api.service << EOF
[Unit]
Description=localSearch API
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/localSearch
ExecStart=/home/$USER/.bun/bin/bun run packages/api/src/index.ts
Restart=on-failure
Environment=HSA_OVERRIDE_GFX_VERSION=11.0.0

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now localsearch-api
```

[⬆ Go to TOC](#toc)

---

## Troubleshooting

### Ollama is not responding

```bash
# Check if running
pgrep ollama || ollama serve &

# Check API
curl http://localhost:11434/api/tags
```

### AMD 780M not using GPU (slow inference)

```bash
# Verify KFD device exists
ls -la /dev/kfd

# Verify override is set
echo $HSA_OVERRIDE_GFX_VERSION   # should be 11.0.0

# Set it manually and restart Ollama
export HSA_OVERRIDE_GFX_VERSION=11.0.0
pkill ollama && ollama serve &
```

### sqlite-vec extension not loading

```bash
# Re-install dependencies
bun install

# Check extension path
node -e "const {getVecExtensionPath} = require('sqlite-vec'); console.log(getVecExtensionPath())"
```

### Re-indexing not picking up changes

Files are identified by SHA-256 hash. If a file's content hasn't changed, it will be skipped even if renamed. To force re-index, remove the document first:

```bash
bun run cli list            # find document ID
# via API:
curl -X DELETE http://localhost:5003/index/<id>
# then re-index:
bun run cli index <path>
```

### API starts quickly but doesn’t rescan all watched files

Startup full-rescan is disabled by default for responsiveness.

Enable it explicitly when needed:

```bash
LOCALSEARCH_STARTUP_RESCAN=1 bun run api
```

### Out of memory during indexing

Reduce chunk size or index smaller batches:

```bash
bun run cli config set chunkSize 256
bun run cli index ~/Documents/subfolder
```

### Indexing is slow on large files (e.g. big PDFs)

Indexing now embeds chunks concurrently. You can tune worker concurrency (default `4`, max `8`):

```bash
# Faster indexing on capable hardware
LOCALSEARCH_INDEX_CONCURRENCY=6 bun run cli index /path/to/large-file.pdf

# Or for API-based indexing
LOCALSEARCH_INDEX_CONCURRENCY=6 bun run api
```

If Ollama becomes unstable, lower concurrency (e.g. `2` or `3`).

You can also enable a **fast indexing profile** (ingest only) that uses larger chunks and lower overlap
to reduce total chunk count for big files:

```bash
# CLI one-off indexing with fast profile
LOCALSEARCH_INDEX_PROFILE=fast bun run cli index /path/to/large-file.pdf

# Combine profile + concurrency for max ingest throughput
LOCALSEARCH_INDEX_PROFILE=fast LOCALSEARCH_INDEX_CONCURRENCY=6 bun run cli index /path/to/large-file.pdf

# API mode
LOCALSEARCH_INDEX_PROFILE=fast bun run api
```

Profile behavior:
- `default`: uses config values (`chunkSize`, `chunkOverlap`)
- `fast`: `chunkSize = max(config.chunkSize, 1024)`, `chunkOverlap = min(config.chunkOverlap, 32)`

`LOCALSEARCH_INDEX_PROFILE` affects indexing/ingest only; it does not change your saved config file.

[⬆ Go to TOC](#toc)

---

## Project structure

```
localSearch/
├── install.sh                  # One-shot installer
├── package.json                # Bun workspace root
├── scripts/
│   └── ollama-setup.sh         # Pull Ollama models
└── packages/
    ├── core/                   # Shared library
    │   └── src/
    │       ├── config.ts       # Config read/write
    │       ├── db.ts           # SQLite + sqlite-vec
    │       ├── embed.ts        # Ollama embedding + chat
    │       ├── chunk.ts        # Text chunking
    │       ├── ingest.ts       # Ingest pipeline
    │       ├── retrieve.ts     # Hybrid KNN + BM25 + RRF
    │       └── parsers/        # PDF, DOCX, XLSX, ODF, text
    ├── api/                    # Elysia REST API (port 5003)
    │   └── src/
    │       ├── index.ts        # Server entrypoint
    │       └── routes/         # query, search, index, docs, config
    ├── web/                    # Next.js web UI (port 5002)
    │   └── app/
    │       ├── page.tsx        # Chat interface
    │       ├── docs/           # Document list
    │       └── settings/       # Configuration
    └── cli/                    # Bun CLI
        └── src/index.ts        # index | query | search | list | reindex | config
```

[⬆ Go to TOC](#toc)

---

## License

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International** license.

- License file: [`LICENSE.md`](./LICENSE.md)
- Human-readable summary: https://creativecommons.org/licenses/by-nc-sa/4.0/
- Legal code: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode

[⬆ Go to TOC](#toc)

---

<div align="center">localSearch Documentation · Licensed under CC BY-NC-SA 4.0 · <a href="#toc">Go to TOC</a></div>
