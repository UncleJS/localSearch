"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, Trash2, RefreshCw,
  AlertTriangle, Loader2, XCircle, ChevronLeft, RotateCcw, Search, X,
} from "lucide-react";

const PAGE_SIZE = 50;

interface Doc {
  id: number;
  path: string;
  title: string;
  chunkCount: number;
  indexedAt: string;
  modifiedAt: string;
}

interface WatchedDir {
  id: number;
  path: string;
  docCount: number;
  chunkCount: number;
  addedAt: string;
}

interface FailedFile {
  path: string;
  error: string;
  failedAt: string;
}

interface IndexStatus {
  running: boolean;
  startedAt: string | null;
  operation: "index" | "rescan" | null;
  lastResult: string | null;
  progress: { current: number; total: number } | null;
  failureCount: number;
}

type Tab = "indexed" | "failed";

interface FailureGroup {
  key: string;
  label: string;
  files: FailedFile[];
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(999, Math.round(value)));
}

function getFailureGroupMeta(error: string): Pick<FailureGroup, "key" | "label"> {
  const raw = error.replace(/^Error:\s*/i, "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();

  if (lower.includes("timed out")) {
    return { key: "timeout", label: "Timed out" };
  }

  if (
    lower.includes("no extractable text") ||
    lower.includes("image-only pdf") ||
    lower.includes("ocr is not supported")
  ) {
    return { key: "scanned-pdf", label: "Scanned / image-only PDF" };
  }

  if (lower.includes("unsupported file type")) {
    return { key: "unsupported-file-type", label: "Unsupported file type" };
  }

  const label = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw || "Unknown error";
  return { key: `error:${label.toLowerCase()}`, label };
}

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("indexed");

  // ── Indexed docs ───────────────────────────────────────────────────────────
  const [dirs, setDirs] = useState<WatchedDir[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsPage, setDocsPage] = useState(1);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsSearch, setDocsSearch] = useState("");
  const [docsSearchInput, setDocsSearchInput] = useState("");
  const docsSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Failed files ──────────────────────────────────────────────────────────
  const [failures, setFailures] = useState<FailedFile[]>([]);
  const [failuresSearch, setFailuresSearch] = useState("");
  const [failuresSearchInput, setFailuresSearchInput] = useState("");
  const failuresSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryingPath, setRetryingPath] = useState<string | null>(null);
  const [retryingGroupKey, setRetryingGroupKey] = useState<string | null>(null);
  const [retryingGroupProgress, setRetryingGroupProgress] = useState<{ key: string; current: number; total: number } | null>(null);
  // Global timeout (minutes) applied to Retry all and per-row Retry
  const [retryTimeoutMins, setRetryTimeoutMins] = useState(5);
  const [retryGroupTimeouts, setRetryGroupTimeouts] = useState<Record<string, number>>({});
  // Per-row timeout overrides (path → minutes); falls back to retryTimeoutMins
  const [retryTimeouts, setRetryTimeouts] = useState<Record<string, number>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedFailureGroupFilter, setSelectedFailureGroupFilter] = useState<string>("all");

  // ── Shared ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [indexPath, setIndexPath] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [indexResult, setIndexResult] = useState<string | null>(null);
  const [removingDir, setRemovingDir] = useState<string | null>(null);
  const [removingDoc, setRemovingDoc] = useState<number | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>({
    running: false, startedAt: null, operation: null, lastResult: null, progress: null, failureCount: 0,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPollingRef = useRef(false);

  // ── Fetch helpers ─────────────────────────────────────────────────────────
  const fetchDocs = useCallback(async (page: number, search?: string) => {
    try {
      const q = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search?.trim()) q.set("search", search.trim());
      const res = await fetch(`/api/docs?${q}`);
      const data = await res.json() as { documents: Doc[]; total: number };
      setDocs(data.documents ?? []);
      setDocsTotal(data.total ?? 0);
      setDocsPage(page);
    } catch {
      setDocs([]);
      setDocsTotal(0);
    }
  }, []);

  const fetchFailures = useCallback(async (search?: string) => {
    try {
      const q = new URLSearchParams();
      if (search?.trim()) q.set("search", search.trim());
      const res = await fetch(`/api/index/failures${q.toString() ? `?${q}` : ""}`);
      const data = await res.json() as { failures: FailedFile[] };
      setFailures(data.failures ?? []);
    } catch {
      setFailures([]);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [dirsRes, docsRes, failuresRes] = await Promise.all([
        fetch("/api/dirs"),
        fetch(`/api/docs?page=1&limit=${PAGE_SIZE}`),
        fetch("/api/index/failures"),
      ]);
      const dirsData = await dirsRes.json() as { dirs: WatchedDir[] };
      const docsData = await docsRes.json() as { documents: Doc[]; total: number };
      const failuresData = await failuresRes.json() as { failures: FailedFile[] };
      setDirs(dirsData.dirs ?? []);
      setDocs(docsData.documents ?? []);
      setDocsTotal(docsData.total ?? 0);
      setDocsPage(1);
      setFailures(failuresData.failures ?? []);
      if ((dirsData.dirs ?? []).length === 1) {
        setExpanded(new Set([dirsData.dirs[0].path]));
      }
    } catch {
      setDirs([]);
      setDocs([]);
      setDocsTotal(0);
      setFailures([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Polling ───────────────────────────────────────────────────────────────
  const pollTickRef = useRef<() => Promise<void>>(async () => {});
  pollTickRef.current = async () => {
    try {
      const res = await fetch("/api/index/status");
      const status = await res.json() as IndexStatus;
      setIndexStatus(status);
      if (!status.running && isPollingRef.current) {
        stopPolling();
        if (status.lastResult) setIndexResult(status.lastResult);
        await fetchAll();
        setIndexing(false);
        setRescanning(false);
      }
    } catch { /* ignore */ }
  };

  function startPolling() {
    if (pollRef.current) return;
    isPollingRef.current = true;
    pollTickRef.current();
    pollRef.current = setInterval(() => pollTickRef.current(), 1000);
  }

  function stopPolling() {
    isPollingRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  useEffect(() => {
    fetchAll();
    fetch("/api/index/status")
      .then((r) => r.json())
      .then((s: IndexStatus) => { setIndexStatus(s); if (s.running) startPolling(); })
      .catch(() => {});
    return () => stopPolling();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced search handlers ──────────────────────────────────────────────
  function handleDocsSearchChange(val: string) {
    setDocsSearchInput(val);
    if (docsSearchDebounce.current) clearTimeout(docsSearchDebounce.current);
    docsSearchDebounce.current = setTimeout(() => {
      setDocsSearch(val);
      fetchDocs(1, val);
    }, 300);
  }

  function clearDocsSearch() {
    setDocsSearchInput("");
    setDocsSearch("");
    if (docsSearchDebounce.current) clearTimeout(docsSearchDebounce.current);
    fetchDocs(1, "");
  }

  function handleFailuresSearchChange(val: string) {
    setFailuresSearchInput(val);
    if (failuresSearchDebounce.current) clearTimeout(failuresSearchDebounce.current);
    failuresSearchDebounce.current = setTimeout(() => {
      setFailuresSearch(val);
      fetchFailures(val);
    }, 300);
  }

  function clearFailuresSearch() {
    setFailuresSearchInput("");
    setFailuresSearch("");
    if (failuresSearchDebounce.current) clearTimeout(failuresSearchDebounce.current);
    fetchFailures("");
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  async function handleIndex() {
    if (!indexPath.trim() || indexing || rescanning || indexStatus.running) return;
    setIndexing(true);
    setIndexResult(null);
    startPolling();
    try {
      const res = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: indexPath.trim(), recursive: true }),
      });
      const data = await res.json() as { started?: boolean; total?: number; error?: string };
      if (data.error) { setIndexResult(data.error); stopPolling(); setIndexing(false); }
      else { setIndexPath(""); }
    } catch (e) { setIndexResult(`Error: ${String(e)}`); stopPolling(); setIndexing(false); }
  }

  async function handleRescan() {
    if (rescanning || indexing || indexStatus.running) return;
    setRescanning(true);
    setIndexResult(null);
    startPolling();
    try {
      const res = await fetch("/api/index/rescan", { method: "POST" });
      const data = await res.json() as { started?: boolean; error?: string };
      if (data.error) { setIndexResult(data.error); stopPolling(); setRescanning(false); }
    } catch (e) { setIndexResult(`Error: ${String(e)}`); stopPolling(); setRescanning(false); }
  }

  async function handleRemoveDir(path: string) {
    setRemovingDir(path);
    try {
      await fetch("/api/dirs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      await fetchAll();
    } finally { setRemovingDir(null); }
  }

  async function handleRemoveDoc(id: number) {
    setRemovingDoc(id);
    try { await fetch(`/api/index/${id}`, { method: "DELETE" }); await fetchAll(); }
    finally { setRemovingDoc(null); }
  }

  async function handleRetryFile(path: string, groupKey?: string) {
    if (anyBusy || retryingPath || retryingGroupKey) return;
    setRetryingPath(path);
    const mins = retryTimeouts[path] ?? (groupKey ? retryGroupTimeouts[groupKey] : undefined) ?? retryTimeoutMins;
    const timeoutSeconds = Math.max(1, Math.round(mins * 60));
    try {
      await fetch(`/api/index/failures/retry/${encodeURIComponent(path)}?timeoutSeconds=${timeoutSeconds}`, { method: "POST" });
      await fetchFailures(failuresSearch);
      // Reset per-row timeout back to default after retry
      setRetryTimeouts((prev) => { const next = { ...prev }; delete next[path]; return next; });
    } finally { setRetryingPath(null); }
  }

  async function handleRetryGroup(groupKey: string, paths: string[]) {
    if (paths.length === 0 || anyBusy || retryingPath || retryingGroupKey) return;
    setRetryingGroupKey(groupKey);
    setRetryingGroupProgress({ key: groupKey, current: 0, total: paths.length });
    const mins = retryGroupTimeouts[groupKey] ?? retryTimeoutMins;
    const timeoutSeconds = Math.max(1, Math.round(mins * 60));

    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        await fetch(`/api/index/failures/retry/${encodeURIComponent(path)}?timeoutSeconds=${timeoutSeconds}`, { method: "POST" });
        setRetryingGroupProgress({ key: groupKey, current: i + 1, total: paths.length });
      }
      await fetchFailures(failuresSearch);
    } finally {
      setRetryingGroupKey(null);
      setRetryingGroupProgress(null);
    }
  }

  async function handleRetryAll() {
    if (anyBusy) return;
    setRescanning(true);
    setIndexResult(null);
    startPolling();
    const timeoutSeconds = Math.max(1, Math.round(retryTimeoutMins * 60));
    try {
      const res = await fetch(`/api/index/failures/retry?timeoutSeconds=${timeoutSeconds}`, { method: "POST" });
      const data = await res.json() as { started?: boolean; error?: string; message?: string };
      if (data.error) { setIndexResult(data.error); stopPolling(); setRescanning(false); }
      else if (data.message) { setIndexResult(data.message); stopPolling(); setRescanning(false); await fetchAll(); }
    } catch (e) { setIndexResult(`Error: ${String(e)}`); stopPolling(); setRescanning(false); }
  }

  async function handleClearFailures() {
    await fetch("/api/index/failures", { method: "DELETE" });
    await fetchAll();
  }

  function toggleDir(path: string) {
    setExpanded((prev) => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next; });
  }

  function toggleFailureGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function expandVisibleFailureGroups() {
    setExpandedGroups(new Set(visibleFailureGroups.map((group) => group.key)));
  }

  function collapseAllFailureGroups() {
    setExpandedGroups(new Set());
  }

  function docsForDir(dirPath: string): Doc[] {
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    return docs.filter((d) => d.path === dirPath || d.path.startsWith(prefix));
  }

  function timeoutForGroup(groupKey: string): number {
    return retryGroupTimeouts[groupKey] ?? retryTimeoutMins;
  }

  function timeoutForFile(path: string, groupKey: string): number {
    return retryTimeouts[path] ?? retryGroupTimeouts[groupKey] ?? retryTimeoutMins;
  }

  const groupedFailures = Array.from(
    failures.reduce((map, failure) => {
      const meta = getFailureGroupMeta(failure.error);
      const existing = map.get(meta.key);
      if (existing) {
        existing.files.push(failure);
      } else {
        map.set(meta.key, { ...meta, files: [failure] });
      }
      return map;
    }, new Map<string, FailureGroup>()).values()
  ).sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));

  const visibleFailureGroups = selectedFailureGroupFilter === "all"
    ? groupedFailures
    : groupedFailures.filter((group) => group.key === selectedFailureGroupFilter);

  useEffect(() => {
    if (selectedFailureGroupFilter !== "all" && !groupedFailures.some((group) => group.key === selectedFailureGroupFilter)) {
      setSelectedFailureGroupFilter("all");
    }

    setExpandedGroups((prev) => {
      const validKeys = new Set(groupedFailures.map((group) => group.key));
      const next = new Set(Array.from(prev).filter((key) => validKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [groupedFailures, selectedFailureGroupFilter]);

  function renderFailureRow(f: FailedFile, groupKey: string, nested = false) {
    const isRetrying = retryingPath === f.path;

    return (
      <div
        key={f.path}
        className={`flex items-start gap-3 ${nested ? "px-6" : "px-4"} py-3 bg-background hover:bg-amber-500/5 transition-colors group/failure`}
      >
        <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground font-mono truncate" title={f.path}>{f.path}</p>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-xs text-amber-400">{f.error}</span>
            <span className="text-xs text-foreground-muted/50">
              {new Date(f.failedAt).toLocaleDateString("sv-SE")} {new Date(f.failedAt).toLocaleTimeString("sv-SE")}
            </span>
          </div>
        </div>
        <div className={`flex items-center gap-1 shrink-0 transition-all ${isRetrying ? "opacity-100" : "opacity-0 group-hover/failure:opacity-100"}`}>
          <input
            type="number"
            min={1}
            max={999}
            value={timeoutForFile(f.path, groupKey)}
            onChange={(e) => setRetryTimeouts((prev) => ({
              ...prev,
              [f.path]: clampMinutes(Number(e.target.value) || 1),
            }))}
            disabled={isRetrying || anyBusy || !!retryingPath || !!retryingGroupKey}
            title="Timeout in minutes for this file"
            className="w-12 bg-background border border-amber-500/30 rounded px-1.5 py-1 text-xs text-foreground text-center focus:outline-none focus:border-amber-500/60 disabled:opacity-40"
          />
          <span className="text-xs text-foreground-muted/60">min</span>
          <button
            onClick={() => handleRetryFile(f.path, groupKey)}
            disabled={isRetrying || anyBusy || !!retryingPath || !!retryingGroupKey}
            title="Retry this file"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isRetrying ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            Retry
          </button>
        </div>
      </div>
    );
  }

  const totalDocs = dirs.reduce((s, d) => s + d.docCount, 0);
  const totalChunks = dirs.reduce((s, d) => s + d.chunkCount, 0);
  const anyBusy = indexing || rescanning || indexStatus.running;
  const failureActionsBusy = anyBusy || !!retryingPath || !!retryingGroupKey;
  const totalPages = Math.max(1, Math.ceil(docsTotal / PAGE_SIZE));

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Documents</h1>
          <p className="text-foreground-muted text-sm mt-1">
            {totalDocs.toLocaleString()} document{totalDocs !== 1 ? "s" : ""} · {totalChunks.toLocaleString()} chunks · {dirs.length} director{dirs.length !== 1 ? "ies" : "y"}
            {failures.length > 0 && (
              <span className="text-amber-400"> · {failures.length} failed</span>
            )}
          </p>
        </div>
        {anyBusy && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs font-medium shrink-0">
            <Loader2 size={13} className="animate-spin" />
            {indexStatus.operation === "rescan" || rescanning ? "Rescanning…" : "Indexing…"}
            {indexStatus.progress && (
              <span className="tabular-nums">
                {indexStatus.progress.current.toLocaleString()} / {indexStatus.progress.total.toLocaleString()}
              </span>
            )}
            {indexStatus.startedAt && (
              <span className="text-accent/60 font-normal">since {new Date(indexStatus.startedAt).toLocaleTimeString("sv-SE")}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Add directory + rescan ───────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground">Add directory</h2>
          <button
            onClick={handleRescan}
            disabled={anyBusy || dirs.length === 0}
            title="Re-scan all watched directories for new, changed, and deleted files"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground-muted border border-border rounded-lg hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} className={rescanning ? "animate-spin" : ""} />
            {rescanning ? "Scanning…" : "Re-scan all"}
          </button>
        </div>
        <div className="flex gap-3" suppressHydrationWarning>
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
            disabled={anyBusy || !indexPath.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {indexing ? "Indexing…" : "Index"}
          </button>
        </div>
        {indexResult && (
          <p className="text-sm text-foreground-muted bg-background border border-border rounded-lg px-3 py-2">{indexResult}</p>
        )}
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div>
        {/* Tab bar */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab("indexed")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "indexed"
                ? "border-accent text-accent"
                : "border-transparent text-foreground-muted hover:text-foreground"
            }`}
          >
            Indexed
            <span className={`text-xs px-1.5 py-0.5 rounded-full tabular-nums ${
              activeTab === "indexed" ? "bg-accent/15 text-accent" : "bg-border text-foreground-muted"
            }`}>
              {docsSearch ? docsTotal.toLocaleString() : totalDocs.toLocaleString()}
            </span>
          </button>

          <button
            onClick={() => setActiveTab("failed")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "failed"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-foreground-muted hover:text-foreground"
            }`}
          >
            Failed
            {failures.length > 0 ? (
              <span className={`text-xs px-1.5 py-0.5 rounded-full tabular-nums ${
                activeTab === "failed" ? "bg-amber-500/20 text-amber-300" : "bg-amber-500/15 text-amber-400"
              }`}>
                {failures.length.toLocaleString()}
              </span>
            ) : (
              <span className="text-xs px-1.5 py-0.5 rounded-full tabular-nums bg-border text-foreground-muted">0</span>
            )}
          </button>
        </div>

        {/* ── Indexed tab ──────────────────────────────────────────────────── */}
        {activeTab === "indexed" && (
          <div className="pt-4 space-y-4">
            {/* Search bar */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted pointer-events-none" />
              <input
                type="text"
                value={docsSearchInput}
                onChange={(e) => handleDocsSearchChange(e.target.value)}
                placeholder="Search by filename or title…"
                className="w-full bg-background border border-border rounded-lg pl-9 pr-8 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-accent"
              />
              {docsSearchInput && (
                <button
                  onClick={clearDocsSearch}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground transition-colors"
                  title="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {docsSearch && (
              <p className="text-xs text-foreground-muted">
                {docsTotal.toLocaleString()} result{docsTotal !== 1 ? "s" : ""} for{" "}
                <span className="text-foreground font-medium">"{docsSearch}"</span>
              </p>
            )}

            {/* Directory tree */}
            <div className="space-y-2">
              {loading ? (
                <div className="text-center text-foreground-muted py-12">Loading…</div>
              ) : docsSearch ? (
                /* ── Flat list when searching ── */
                docs.length === 0 ? (
                  <div className="text-center text-foreground-muted py-12">
                    <p className="text-3xl mb-3">🔍</p>
                    <p>No documents match <span className="font-medium text-foreground">"{docsSearch}"</span></p>
                  </div>
                ) : (
                  <div className="border border-border rounded-xl divide-y divide-border overflow-hidden">
                    {docs.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-3 px-4 py-2.5 bg-background hover:bg-surface/50 transition-colors group/doc"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-foreground text-sm truncate">{doc.title}</p>
                          <p className="text-xs text-foreground-muted font-mono truncate mt-0.5">{doc.path}</p>
                          <div className="flex gap-3 mt-0.5">
                            <span className="text-xs text-foreground-muted">{doc.chunkCount} chunks</span>
                            <span className="text-xs text-foreground-muted">
                              indexed {new Date(doc.indexedAt).toLocaleDateString("sv-SE")}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveDoc(doc.id)}
                          disabled={removingDoc === doc.id}
                          title="Remove this file from index"
                          className="opacity-0 group-hover/doc:opacity-100 p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-400/10 transition-all disabled:opacity-50 shrink-0"
                        >
                          {removingDoc === doc.id ? <span className="text-xs">…</span> : <Trash2 size={12} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )
              ) : dirs.length === 0 ? (
                <div className="text-center text-foreground-muted py-12">
                  <p className="text-4xl mb-3">📂</p>
                  <p>No directories indexed yet.</p>
                  <p className="text-sm mt-1">Enter a path above and click Index.</p>
                </div>
              ) : (
                dirs.map((dir) => {
                  const isOpen = expanded.has(dir.path);
                  const dirDocs = docsForDir(dir.path);
                  const isRemoving = removingDir === dir.path;

                  return (
                    <div key={dir.path} className="border border-border rounded-xl overflow-hidden">
                      <div
                        className="flex items-center gap-3 px-4 py-3 bg-surface hover:bg-surface/80 cursor-pointer select-none group"
                        onClick={() => toggleDir(dir.path)}
                      >
                        <span className="text-foreground-muted">
                          {isOpen ? <FolderOpen size={16} className="text-accent" /> : <Folder size={16} className="text-foreground-muted" />}
                        </span>
                        <span className="text-foreground-muted">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>
                        <span className="flex-1 font-medium text-sm text-foreground truncate">{dir.path}</span>
                        <span className="text-xs text-foreground-muted shrink-0">
                          {dir.docCount} doc{dir.docCount !== 1 ? "s" : ""} · {dir.chunkCount.toLocaleString()} chunks
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRemoveDir(dir.path); }}
                          disabled={isRemoving}
                          title="Remove directory and all its documents from index"
                          className="opacity-0 group-hover:opacity-100 ml-2 p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-400/10 transition-all disabled:opacity-50 shrink-0"
                        >
                          {isRemoving ? <span className="text-xs">…</span> : <Trash2 size={14} />}
                        </button>
                      </div>

                      {isOpen && (
                        <div className="divide-y divide-border border-t border-border">
                          {dirDocs.length === 0 ? (
                            <p className="px-6 py-3 text-xs text-foreground-muted italic">
                              No documents on this page for this directory.{dir.docCount > 0 ? " Use the page controls below to browse all files." : ""}
                            </p>
                          ) : (
                            dirDocs.map((doc) => (
                              <div
                                key={doc.id}
                                className="flex items-center gap-3 px-6 py-2.5 bg-background hover:bg-surface/50 transition-colors group/doc"
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-foreground text-sm truncate">{doc.title}</p>
                                  <p className="text-xs text-foreground-muted truncate mt-0.5">
                                    {doc.path.replace(dir.path, "").replace(/^\//, "")}
                                  </p>
                                  <div className="flex gap-3 mt-0.5">
                                    <span className="text-xs text-foreground-muted">{doc.chunkCount} chunks</span>
                                    <span className="text-xs text-foreground-muted">
                                      indexed {new Date(doc.indexedAt).toLocaleDateString("sv-SE")}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  onClick={() => handleRemoveDoc(doc.id)}
                                  disabled={removingDoc === doc.id}
                                  title="Remove this file from index"
                                  className="opacity-0 group-hover/doc:opacity-100 p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-400/10 transition-all disabled:opacity-50 shrink-0"
                                >
                                  {removingDoc === doc.id ? <span className="text-xs">…</span> : <Trash2 size={12} />}
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={() => fetchDocs(docsPage - 1, docsSearch)}
                  disabled={docsPage <= 1 || loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground-muted border border-border rounded-lg hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={13} />
                  Prev
                </button>
                <span className="text-xs text-foreground-muted tabular-nums">
                  Page {docsPage} of {totalPages}
                  <span className="text-foreground-muted/50 ml-1">({docsTotal.toLocaleString()} files)</span>
                </span>
                <button
                  onClick={() => fetchDocs(docsPage + 1, docsSearch)}
                  disabled={docsPage >= totalPages || loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground-muted border border-border rounded-lg hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Failed tab ───────────────────────────────────────────────────── */}
        {activeTab === "failed" && (
          <div className="pt-4 space-y-4">
            {/* Toolbar: search + actions */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted pointer-events-none" />
                <input
                  type="text"
                  value={failuresSearchInput}
                  onChange={(e) => handleFailuresSearchChange(e.target.value)}
                  placeholder="Search by filename or error…"
                  className="w-full bg-background border border-border rounded-lg pl-9 pr-8 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-amber-500/60"
                />
                {failuresSearchInput && (
                  <button
                    onClick={clearFailuresSearch}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground transition-colors"
                    title="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <button
                onClick={handleRetryAll}
                disabled={failureActionsBusy || failures.length === 0}
                title="Retry all failed files"
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-300 border border-amber-500/40 rounded-lg hover:bg-amber-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <RotateCcw size={12} />
                Retry all
              </button>
              {/* Global timeout input */}
              <div className="flex items-center gap-1 shrink-0" title="Timeout per file in minutes (applies to Retry all and per-row Retry)">
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={retryTimeoutMins}
                  onChange={(e) => setRetryTimeoutMins(clampMinutes(Number(e.target.value) || 1))}
                  disabled={failureActionsBusy}
                  className="w-14 bg-background border border-border rounded-lg px-2 py-2 text-xs text-foreground text-center focus:outline-none focus:border-amber-500/60 disabled:opacity-40"
                />
                <span className="text-xs text-foreground-muted">min</span>
              </div>
              <button
                onClick={handleClearFailures}
                disabled={failureActionsBusy || failures.length === 0}
                title="Clear all failed file records"
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-foreground-muted border border-border rounded-lg hover:border-red-400/50 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <XCircle size={12} />
                Clear all
              </button>
            </div>

            {failuresSearch && (
              <p className="text-xs text-foreground-muted">
                {failures.length.toLocaleString()} result{failures.length !== 1 ? "s" : ""} for{" "}
                <span className="text-foreground font-medium">"{failuresSearch}"</span>
              </p>
            )}

            {retryingGroupProgress && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
                <Loader2 size={12} className="animate-spin" />
                Retrying group…
                <span className="tabular-nums">{retryingGroupProgress.current} / {retryingGroupProgress.total}</span>
              </div>
            )}

            {!failuresSearch && groupedFailures.length > 0 && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setSelectedFailureGroupFilter("all")}
                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedFailureGroupFilter === "all"
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                      : "border-border text-foreground-muted hover:border-amber-500/30 hover:text-foreground"}`}
                  >
                    All <span className="tabular-nums">({failures.length})</span>
                  </button>
                  {groupedFailures.map((group) => (
                    <button
                      key={`filter-${group.key}`}
                      onClick={() => setSelectedFailureGroupFilter(group.key)}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedFailureGroupFilter === group.key
                        ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                        : "border-border text-foreground-muted hover:border-amber-500/30 hover:text-foreground"}`}
                    >
                      {group.label} <span className="tabular-nums">({group.files.length})</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={expandVisibleFailureGroups}
                    disabled={visibleFailureGroups.length === 0}
                    className="px-2.5 py-1 text-xs rounded-lg border border-border text-foreground-muted hover:border-amber-500/30 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Expand all
                  </button>
                  <button
                    onClick={collapseAllFailureGroups}
                    disabled={visibleFailureGroups.length === 0}
                    className="px-2.5 py-1 text-xs rounded-lg border border-border text-foreground-muted hover:border-amber-500/30 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Collapse all
                  </button>
                </div>
              </div>
            )}

            {/* Failure rows */}
            {failures.length === 0 ? (
              failuresSearch ? (
                <div className="text-center text-foreground-muted py-12">
                  <p className="text-3xl mb-3">🔍</p>
                  <p>No failures match <span className="font-medium text-foreground">"{failuresSearch}"</span></p>
                </div>
              ) : (
                <div className="text-center text-foreground-muted py-12">
                  <p className="text-3xl mb-3">✅</p>
                  <p>No failed files.</p>
                </div>
              )
            ) : failuresSearch ? (
              <div className="border border-amber-500/30 rounded-xl divide-y divide-amber-500/10 overflow-hidden">
                {failures.map((f) => renderFailureRow(f, getFailureGroupMeta(f.error).key))}
              </div>
            ) : (
              <div className="space-y-3">
                {visibleFailureGroups.map((group) => {
                  const isOpen = expandedGroups.has(group.key);
                  const groupBusy = retryingGroupKey === group.key;
                  const groupTimeout = timeoutForGroup(group.key);

                  return (
                    <div key={group.key} className="border border-amber-500/30 rounded-xl overflow-hidden">
                      <div
                        className="flex items-center gap-3 px-4 py-3 bg-background hover:bg-amber-500/5 transition-colors cursor-pointer"
                        onClick={() => toggleFailureGroup(group.key)}
                      >
                        <span className="text-foreground-muted shrink-0">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>
                        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-foreground">{group.label}</p>
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 tabular-nums">
                              {group.files.length.toLocaleString()}
                            </span>
                            {groupBusy && retryingGroupProgress?.key === group.key && (
                              <span className="text-xs text-amber-300 tabular-nums">
                                {retryingGroupProgress.current} / {retryingGroupProgress.total}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-foreground-muted">
                            {group.files.length} file{group.files.length !== 1 ? "s" : ""} with a similar error
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="number"
                            min={1}
                            max={999}
                            value={groupTimeout}
                            onChange={(e) => setRetryGroupTimeouts((prev) => ({
                              ...prev,
                              [group.key]: clampMinutes(Number(e.target.value) || 1),
                            }))}
                            disabled={failureActionsBusy}
                            title="Timeout in minutes for this error group"
                            className="w-12 bg-background border border-amber-500/30 rounded px-1.5 py-1 text-xs text-foreground text-center focus:outline-none focus:border-amber-500/60 disabled:opacity-40"
                          />
                          <span className="text-xs text-foreground-muted/60">min</span>
                          <button
                            onClick={() => handleRetryGroup(group.key, group.files.map((f) => f.path))}
                            disabled={failureActionsBusy}
                            title="Retry all files in this group"
                            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {groupBusy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                            Retry group
                          </button>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="divide-y divide-amber-500/10 border-t border-amber-500/10">
                          {group.files.map((f) => renderFailureRow(f, group.key, true))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
