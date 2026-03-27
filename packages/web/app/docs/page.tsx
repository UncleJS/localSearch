"use client";

import { useState, useEffect, useCallback } from "react";

interface Doc {
  id: number;
  path: string;
  title: string;
  chunkCount: number;
  indexedAt: string;
  modifiedAt: string;
}

export default function DocsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [indexPath, setIndexPath] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [indexResult, setIndexResult] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/docs?limit=100");
      const data = await res.json() as { total: number; documents: Doc[] };
      setDocs(data.documents ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  async function handleIndex() {
    if (!indexPath.trim() || indexing) return;
    setIndexing(true);
    setIndexResult(null);
    try {
      const res = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: indexPath.trim(), recursive: true }),
      });
      const data = await res.json() as { message?: string; error?: string };
      setIndexResult(data.message ?? data.error ?? "Done");
      await fetchDocs();
    } catch (e) {
      setIndexResult(`Error: ${String(e)}`);
    } finally {
      setIndexing(false);
    }
  }

  async function handleDelete(id: number) {
    setDeleting(id);
    try {
      await fetch(`/api/index/${id}`, { method: "DELETE" });
      await fetchDocs();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Documents</h1>
        <p className="text-foreground-muted text-sm mt-1">
          {total} document{total !== 1 ? "s" : ""} indexed
        </p>
      </div>

      {/* Index new path */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="font-semibold text-foreground">Index documents</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={indexPath}
            onChange={(e) => setIndexPath(e.target.value)}
            placeholder="/path/to/documents  or  ~/Documents"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-accent"
            onKeyDown={(e) => e.key === "Enter" && handleIndex()}
          />
          <button
            onClick={handleIndex}
            disabled={indexing || !indexPath.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {indexing ? "Indexing…" : "Index"}
          </button>
        </div>
        {indexResult && (
          <p className="text-sm text-foreground-muted bg-background border border-border rounded-lg px-3 py-2">
            {indexResult}
          </p>
        )}
      </div>

      {/* Documents list */}
      <div className="space-y-2">
        {loading ? (
          <div className="text-center text-foreground-muted py-12">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="text-center text-foreground-muted py-12">
            <p className="text-4xl mb-3">📂</p>
            <p>No documents indexed yet.</p>
            <p className="text-sm mt-1">Enter a path above and click Index.</p>
          </div>
        ) : (
          docs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-4 bg-surface border border-border rounded-lg px-4 py-3 hover:border-accent/50 transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground text-sm truncate">{doc.title}</p>
                <p className="text-xs text-foreground-muted truncate mt-0.5">{doc.path}</p>
                <div className="flex gap-3 mt-1">
                  <span className="text-xs text-foreground-muted">{doc.chunkCount} chunks</span>
                  <span className="text-xs text-foreground-muted">
                    indexed {new Date(doc.indexedAt).toLocaleDateString("sv-SE")}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleDelete(doc.id)}
                disabled={deleting === doc.id}
                className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-300 transition-all disabled:opacity-50 px-2 py-1 rounded"
              >
                {deleting === doc.id ? "…" : "Remove"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
