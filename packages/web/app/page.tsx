"use client";

import { useState, useRef, useEffect } from "react";

interface Citation {
  path: string;
  title: string;
  page: number | null;
  excerpt: string;
  score: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  status?: string;
}

type QueryMode = "fast" | "balanced" | "accurate";
const QUERY_MODE_STORAGE_KEY = "localsearch.queryMode";

const MODE_MAX_TOPK: Record<QueryMode, number> = {
  fast: 4,
  balanced: 6,
  accurate: 8,
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<QueryMode>("accurate");
  const [topK, setTopK] = useState(4);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(QUERY_MODE_STORAGE_KEY);
      if (saved === "fast" || saved === "balanced" || saved === "accurate") {
        setMode(saved);
      }
    } catch {
      // ignore storage access errors
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(QUERY_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore storage access errors
    }
  }, [mode]);

  useEffect(() => {
    const maxForMode = MODE_MAX_TOPK[mode];
    setTopK((prev) => Math.min(prev, maxForMode));
  }, [mode]);

  function applyStreamEvent(event: {
    type: "token" | "citations" | "error" | "status";
    content?: string;
    citations?: Citation[];
    message?: string;
  }) {
    if (event.type === "token" && event.content) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: updated[updated.length - 1].content + event.content,
          status: undefined,
        };
        return updated;
      });
    } else if (event.type === "citations" && event.citations) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          citations: event.citations,
        };
        return updated;
      });
    } else if (event.type === "status") {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          status: event.message ?? "Working...",
        };
        return updated;
      });
    } else if (event.type === "error") {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: event.message ?? "An error occurred.",
          status: undefined,
        };
        return updated;
      });
    }
  }

  async function sendMessage() {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setLoading(true);

    const userMsg: Message = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);

    // Create assistant message placeholder
    const assistantMsg: Message = { role: "assistant", content: "", status: "Starting..." };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, topK, mode }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`API error: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;

          try {
            const event = JSON.parse(data) as {
              type: "token" | "citations" | "error" | "status";
              content?: string;
              citations?: Citation[];
              message?: string;
            };
            applyStreamEvent(event);
          } catch {
            // skip malformed
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().startsWith("data: ")) {
        const data = buffer.trim().slice(6);
        if (data !== "[DONE]") {
          try {
            const event = JSON.parse(data) as {
              type: "token" | "citations" | "error" | "status";
              content?: string;
              citations?: Citation[];
              message?: string;
            };
            applyStreamEvent(event);
          } catch {
            // skip malformed trailing chunk
          }
        }
      }
    } catch (e) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: `Error: ${String(e)}`,
          status: undefined,
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Chat history */}
      <div className="flex-1 overflow-y-auto space-y-6 pb-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-foreground-muted">
            <div className="text-5xl mb-4">🔍</div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Ask anything about your documents
            </h2>
            <p className="text-sm max-w-md">
              Index your documents first via the CLI or{" "}
              <a href="/docs" className="text-accent hover:underline">
                Documents
              </a>{" "}
              page, then ask natural language questions.
            </p>
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm max-w-xl w-full">
              {[
                "What are the key findings in my reports?",
                "Summarize the main topics across all documents",
                "Find information about budget and costs",
                "What decisions were made in recent meetings?",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="text-left px-4 py-3 bg-surface border border-border rounded-lg hover:border-accent transition-colors text-foreground-muted hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">
                AI
              </div>
            )}
            <div className={`max-w-3xl ${msg.role === "user" ? "order-first" : ""}`}>
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-accent text-white rounded-tr-sm"
                    : "bg-surface text-foreground rounded-tl-sm border border-border"
                }`}
              >
                {msg.content || msg.status}
                {loading && i === messages.length - 1 && msg.role === "assistant" && (
                  <span className="inline-block w-2 h-4 bg-foreground-muted ml-1 animate-pulse rounded-sm" />
                )}
              </div>

              {/* Citations */}
              {msg.citations && msg.citations.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-foreground-muted font-medium">Sources:</p>
                  {msg.citations.map((c, ci) => (
                    <div
                      key={ci}
                      className="text-xs bg-surface border border-border rounded-lg px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-accent font-mono">[{ci + 1}]</span>
                        <span className="font-medium text-foreground">{c.title}</span>
                        {c.page && (
                          <span className="text-foreground-muted">· page {c.page}</span>
                        )}
                      </div>
                      <p className="text-foreground-muted mt-1 truncate" title={c.path}>
                        {c.path}
                      </p>
                      <p className="text-foreground-muted mt-1 line-clamp-2">{c.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="w-8 h-8 rounded-full bg-border flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">
                U
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center gap-2 mb-2">
          <label className="text-xs text-foreground-muted">Mode:</label>
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {([
              ["fast", "Fast"],
              ["balanced", "Balanced"],
              ["accurate", "Accurate"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                disabled={loading}
                className={`px-3 py-1 text-xs transition-colors ${
                  mode === value
                    ? "bg-accent text-white"
                    : "bg-surface text-foreground-muted hover:text-foreground"
                } ${loading ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <label className="text-xs text-foreground-muted">Sources:</label>
          <input
            type="range"
            min={1}
            max={MODE_MAX_TOPK[mode]}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            className="w-24 accent-accent"
          />
          <span className="text-xs text-foreground-muted w-4">{topK}</span>
        </div>
        <div className="flex gap-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your documents… (Enter to send, Shift+Enter for newline)"
            rows={3}
            disabled={loading}
            className="flex-1 bg-surface border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder-foreground-muted resize-none focus:outline-none focus:border-accent transition-colors disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-5 py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed self-end"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
