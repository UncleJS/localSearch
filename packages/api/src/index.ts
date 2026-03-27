import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { loadConfig } from "@localsearch/core";
import { queryRoute } from "./routes/query";
import { searchRoute } from "./routes/search";
import { indexRoute } from "./routes/index";
import { docsRoute } from "./routes/docs";
import { configRoute } from "./routes/config";

const cfg = loadConfig();

const app = new Elysia()
  .use(cors({ origin: `http://localhost:${cfg.webPort}` }))
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "localSearch API",
          version: "0.1.0",
          description:
            "Local RAG document search engine — powered by Ollama + sqlite-vec",
        },
        tags: [
          { name: "rag", description: "RAG query & semantic search" },
          { name: "index", description: "Document ingestion" },
          { name: "config", description: "Configuration" },
        ],
      },
    })
  )
  .use(queryRoute)
  .use(searchRoute)
  .use(indexRoute)
  .use(docsRoute)
  .use(configRoute)
  .get("/health", () => ({ status: "ok", ts: Date.now() }))
  .listen(cfg.apiPort);

console.log(
  `\n🔍 localSearch API running at http://localhost:${cfg.apiPort}`
);
console.log(`📖 Swagger UI at http://localhost:${cfg.apiPort}/swagger\n`);

export type App = typeof app;
