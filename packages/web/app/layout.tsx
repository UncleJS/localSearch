import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "localSearch",
  description: "Local RAG document search engine",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased min-h-screen">
        <nav className="border-b border-border px-6 py-3 flex items-center gap-6">
          <span className="font-bold text-lg tracking-tight text-foreground">
            🔍 localSearch
          </span>
          <a href="/" className="text-sm text-foreground-muted hover:text-foreground transition-colors">
            Chat
          </a>
          <a href="/docs" className="text-sm text-foreground-muted hover:text-foreground transition-colors">
            Documents
          </a>
          <a href="/settings" className="text-sm text-foreground-muted hover:text-foreground transition-colors">
            Settings
          </a>
          <a
            href="http://localhost:5003/swagger"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs text-foreground-muted hover:text-accent transition-colors"
          >
            API Docs ↗
          </a>
        </nav>
        <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
