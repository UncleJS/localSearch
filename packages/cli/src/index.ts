#!/usr/bin/env bun
import { readdirSync, statSync } from "fs";
import { join, extname } from "path";
import {
  ingestFile,
  isSupportedFile,
  retrieve,
  chat,
  checkOllama,
  loadConfig,
  saveConfig,
  getDb,
} from "@localsearch/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function help() {
  console.log(`
${BOLD}localSearch${RESET} — Local RAG document search engine

${BOLD}USAGE${RESET}
  bun run cli <command> [options]

${BOLD}COMMANDS${RESET}
  ${CYAN}index${RESET} <path>         Index a file or directory (recursive)
  ${CYAN}query${RESET} <question>     Ask a question (RAG with streaming answer)
  ${CYAN}search${RESET} <query>       Semantic search — returns top chunks, no LLM
  ${CYAN}list${RESET}                 List all indexed documents
  ${CYAN}reindex${RESET}              Re-process all modified/new files in defaultPath
  ${CYAN}config get${RESET}           Show current configuration
  ${CYAN}config set${RESET} <key> <value>  Update a config key

${BOLD}EXAMPLES${RESET}
  bun run cli index ~/Documents
  bun run cli index ./report.pdf
  bun run cli query "What are the key findings in the Q3 report?"
  bun run cli search "machine learning pipeline"
  bun run cli list
  bun run cli reindex
  bun run cli config set defaultPath ~/Notes
  bun run cli config set chatModel llama3.1:8b
`);
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(full));
      } else if (entry.isFile() && isSupportedFile(full)) {
        files.push(full);
      }
    }
  } catch {
    // skip unreadable
  }
  return files;
}

async function cmdIndex(targetPath: string) {
  const ok = await checkOllama();
  if (!ok) {
    console.error(`${RED}✗ Ollama is not running. Start it with: ollama serve${RESET}`);
    process.exit(1);
  }

  let files: string[];
  try {
    const stat = statSync(targetPath);
    files = stat.isDirectory() ? walkDir(targetPath) : [targetPath];
  } catch {
    console.error(`${RED}✗ Cannot access: ${targetPath}${RESET}`);
    process.exit(1);
  }

  files = files.filter(isSupportedFile);
  if (files.length === 0) {
    console.log(`${YELLOW}No supported files found at: ${targetPath}${RESET}`);
    return;
  }

  console.log(`\n${BOLD}Indexing ${files.length} file(s)...${RESET}\n`);

  let indexed = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const result = await ingestFile(file);
    const rel = file.replace(process.env.HOME ?? "", "~");
    if (result.status === "indexed") {
      console.log(`  ${GREEN}✓${RESET} ${rel} ${DIM}(${result.chunks} chunks)${RESET}`);
      indexed++;
    } else if (result.status === "skipped") {
      console.log(`  ${DIM}– ${rel} (unchanged, skipped)${RESET}`);
      skipped++;
    } else {
      console.log(`  ${RED}✗ ${rel}: ${result.error}${RESET}`);
      errors++;
    }
  }

  console.log(
    `\n${BOLD}Done:${RESET} ${GREEN}${indexed} indexed${RESET}, ${DIM}${skipped} skipped${RESET}, ${errors > 0 ? RED : ""}${errors} errors${RESET}\n`
  );
}

async function cmdQuery(question: string) {
  const ok = await checkOllama();
  if (!ok) {
    console.error(`${RED}✗ Ollama is not running. Start it with: ollama serve${RESET}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const chunks = await retrieve(question, cfg.topK);

  if (chunks.length === 0) {
    console.log(`\n${YELLOW}No relevant documents found. Try indexing some documents first.${RESET}\n`);
    return;
  }

  const SYSTEM_PROMPT = `You are a helpful assistant. Answer questions based ONLY on the provided document excerpts.
For each claim, cite the source document and page number if available.
If the answer cannot be found in the excerpts, say so clearly.`;

  const context = chunks
    .map((c, i) => {
      const pageRef = c.page ? ` (page ${c.page})` : "";
      return `[${i + 1}] ${c.title}${pageRef}\n${c.text}`;
    })
    .join("\n\n---\n\n");

  const userMessage = `Document excerpts:\n\n${context}\n\nQuestion: ${question}`;

  console.log(`\n${BOLD}Answer:${RESET}\n`);

  for await (const token of chat(SYSTEM_PROMPT, userMessage)) {
    process.stdout.write(token);
  }

  console.log(`\n\n${BOLD}${DIM}Sources:${RESET}`);
  chunks.forEach((c, i) => {
    const pageRef = c.page ? `:${c.page}` : "";
    console.log(`  ${DIM}[${i + 1}] ${c.path}${pageRef}${RESET}`);
  });
  console.log();
}

async function cmdSearch(query: string) {
  const ok = await checkOllama();
  if (!ok) {
    console.error(`${RED}✗ Ollama is not running. Start it with: ollama serve${RESET}`);
    process.exit(1);
  }

  const chunks = await retrieve(query, 10);

  if (chunks.length === 0) {
    console.log(`\n${YELLOW}No results found for: "${query}"${RESET}\n`);
    return;
  }

  console.log(`\n${BOLD}Top ${chunks.length} results for: "${query}"${RESET}\n`);

  chunks.forEach((c, i) => {
    const pageRef = c.page ? ` — page ${c.page}` : "";
    const score = (c.score * 1000).toFixed(1);
    console.log(`${BOLD}${i + 1}. ${c.title}${pageRef}${RESET} ${DIM}(score: ${score})${RESET}`);
    console.log(`   ${DIM}${c.path}${RESET}`);
    console.log(`   ${c.text.slice(0, 200).replace(/\n/g, " ")}...`);
    console.log();
  });
}

function cmdList() {
  const db = getDb();
  const docs = db
    .query<
      { id: number; path: string; title: string; indexed_at: number; chunk_count: number },
      []
    >(
      `SELECT d.id, d.path, d.title, d.indexed_at, COUNT(c.id) AS chunk_count
       FROM documents d
       LEFT JOIN chunks c ON c.doc_id = d.id
       GROUP BY d.id
       ORDER BY d.indexed_at DESC`
    )
    .all([]);

  if (docs.length === 0) {
    console.log(`\n${YELLOW}No documents indexed yet. Run: bun run cli index <path>${RESET}\n`);
    return;
  }

  console.log(`\n${BOLD}Indexed documents (${docs.length}):${RESET}\n`);
  docs.forEach((d) => {
    const date = new Date(d.indexed_at).toISOString().slice(0, 10);
    console.log(`  ${GREEN}[${d.id}]${RESET} ${d.title} ${DIM}(${d.chunk_count} chunks, ${date})${RESET}`);
    console.log(`      ${DIM}${d.path}${RESET}`);
  });
  console.log();
}

async function cmdReindex() {
  const cfg = loadConfig();
  console.log(`\n${BOLD}Re-indexing: ${cfg.defaultPath}${RESET}\n`);
  await cmdIndex(cfg.defaultPath);
}

function cmdConfigGet() {
  const cfg = loadConfig();
  console.log(`\n${BOLD}Configuration:${RESET}\n`);
  for (const [key, val] of Object.entries(cfg)) {
    console.log(`  ${CYAN}${key}${RESET}: ${val}`);
  }
  console.log();
}

function cmdConfigSet(key: string, value: string) {
  // Parse numeric values
  const numericKeys = ["chunkSize", "chunkOverlap", "topK", "apiPort", "webPort"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = numericKeys.includes(key) ? Number(value) : value;

  saveConfig({ [key]: parsed });
  console.log(`\n${GREEN}✓ Set ${key} = ${parsed}${RESET}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case "index":
    if (!args[1]) { console.error(`${RED}Usage: localsearch index <path>${RESET}`); process.exit(1); }
    await cmdIndex(args[1]);
    break;

  case "query":
    if (!args[1]) { console.error(`${RED}Usage: localsearch query "<question>"${RESET}`); process.exit(1); }
    await cmdQuery(args.slice(1).join(" "));
    break;

  case "search":
    if (!args[1]) { console.error(`${RED}Usage: localsearch search "<query>"${RESET}`); process.exit(1); }
    await cmdSearch(args.slice(1).join(" "));
    break;

  case "list":
    cmdList();
    break;

  case "reindex":
    await cmdReindex();
    break;

  case "config":
    if (args[1] === "get" || !args[1]) cmdConfigGet();
    else if (args[1] === "set" && args[2] && args[3]) cmdConfigSet(args[2], args[3]);
    else { console.error(`${RED}Usage: localsearch config get | set <key> <value>${RESET}`); process.exit(1); }
    break;

  default:
    help();
}
