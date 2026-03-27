import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  defaultPath: string;
  dbPath: string;
  ollamaUrl: string;
  embeddingModel: string;
  chatModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  apiPort: number;
  webPort: number;
}

const CONFIG_DIR = join(homedir(), ".config", "localsearch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_CONFIG: Config = {
  defaultPath: join(homedir(), "Documents"),
  dbPath: join(CONFIG_DIR, "localsearch.db"),
  ollamaUrl: "http://localhost:11434",
  embeddingModel: "nomic-embed-text",
  chatModel: "llama3.2:3b",
  chunkSize: 512,
  chunkOverlap: 64,
  topK: 5,
  apiPort: 5003,
  webPort: 5002,
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = existsSync(CONFIG_FILE)
    ? JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    : DEFAULT_CONFIG;
  const merged = { ...current, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
