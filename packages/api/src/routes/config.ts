import { Elysia, t } from "elysia";
import { loadConfig, saveConfig } from "@localsearch/core";

export const configRoute = new Elysia({ prefix: "/config" })
  .get(
    "/",
    () => loadConfig(),
    {
      detail: {
        tags: ["config"],
        summary: "Get current configuration",
        description: `Returns the effective runtime configuration loaded from ~/.config/localsearch/config.json (merged with defaults).

Example response:
{"defaultPath":"/home/user/Documents","ollamaUrl":"http://localhost:11434","embeddingModel":"nomic-embed-text","chatModel":"llama3.2:3b","chunkSize":512,"chunkOverlap":64,"topK":4,"apiPort":5003,"webPort":5002}`,
      },
    }
  )
  .put(
    "/",
    ({ body }) => {
      const updated = saveConfig(body);
      return { message: "Configuration updated", config: updated };
    },
    {
      body: t.Partial(
        t.Object({
          defaultPath: t.String({ description: "Default directory for reindex operations" }),
          ollamaUrl: t.String({ description: "Base URL for Ollama API" }),
          embeddingModel: t.String({ description: "Embedding model name for indexing/retrieval" }),
          chatModel: t.String({ description: "Chat model name for answer generation" }),
          chunkSize: t.Number({ minimum: 64, maximum: 2048, description: "Chunk size in tokens for ingest" }),
          chunkOverlap: t.Number({ minimum: 0, maximum: 256, description: "Token overlap between adjacent chunks" }),
          topK: t.Number({ minimum: 1, maximum: 20, description: "Default retrieval chunk count" }),
        })
      ),
      detail: {
        tags: ["config"],
        summary: "Update configuration",
        description: `Persists provided config fields and returns the updated configuration object. Unspecified fields remain unchanged.

Example request body:
{"chatModel":"llama3.2:3b","topK":6,"chunkSize":768}

Example response:
{"message":"Configuration updated","config":{...}}`,
      },
    }
  );
