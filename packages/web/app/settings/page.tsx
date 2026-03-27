"use client";

import { useState, useEffect } from "react";

interface Config {
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

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => setConfig(d as Config))
      .catch(() => setError("Could not load configuration. Is the API running?"));
  }, []);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function field(
    label: string,
    key: keyof Config,
    description?: string,
    type: "text" | "number" = "text"
  ) {
    if (!config) return null;
    return (
      <div className="space-y-1">
        <label className="block text-sm font-medium text-foreground">{label}</label>
        {description && <p className="text-xs text-foreground-muted">{description}</p>}
        <input
          type={type}
          value={String(config[key])}
          onChange={(e) =>
            setConfig({
              ...config,
              [key]: type === "number" ? Number(e.target.value) : e.target.value,
            })
          }
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
        />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center py-12 text-foreground-muted">
        {error ?? "Loading…"}
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-foreground-muted text-sm mt-1">
          Configuration is saved to{" "}
          <code className="text-xs bg-surface px-1 py-0.5 rounded">
            ~/.config/localsearch/config.json
          </code>
        </p>
      </div>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Paths</h2>
        {field("Default document path", "defaultPath", "Used by 'reindex' command and the Index button without a path.")}
        {field("Database path", "dbPath", "Where the SQLite database is stored.")}
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Ollama</h2>
        {field("Ollama URL", "ollamaUrl", "Base URL of your Ollama instance.")}
        {field("Embedding model", "embeddingModel", "Used to create document embeddings. Recommended: nomic-embed-text")}
        {field("Chat model", "chatModel", "Used for Q&A generation. Recommended: llama3.2:3b")}
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Chunking</h2>
        {field("Chunk size (tokens)", "chunkSize", "Max tokens per text chunk. Range: 64–2048.", "number")}
        {field("Chunk overlap (tokens)", "chunkOverlap", "Token overlap between consecutive chunks. Range: 0–256.", "number")}
        {field("Top-K results", "topK", "Number of chunks retrieved per query. Range: 1–20.", "number")}
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Ports</h2>
        {field("API port", "apiPort", "Elysia API server port.", "number")}
        {field("Web port", "webPort", "Next.js web UI port.", "number")}
      </section>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/30 border border-red-800 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
      >
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save settings"}
      </button>
    </div>
  );
}
