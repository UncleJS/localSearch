import { Elysia, t } from "elysia";
import { loadConfig, saveConfig } from "@localsearch/core";

export const configRoute = new Elysia({ prefix: "/config" })
  .get(
    "/",
    () => loadConfig(),
    { detail: { tags: ["config"], summary: "Get current configuration" } }
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
          defaultPath: t.String(),
          ollamaUrl: t.String(),
          embeddingModel: t.String(),
          chatModel: t.String(),
          chunkSize: t.Number({ minimum: 64, maximum: 2048 }),
          chunkOverlap: t.Number({ minimum: 0, maximum: 256 }),
          topK: t.Number({ minimum: 1, maximum: 20 }),
        })
      ),
      detail: { tags: ["config"], summary: "Update configuration" },
    }
  );
