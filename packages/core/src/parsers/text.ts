import { readFileSync } from "fs";
import type { PagedText } from "../chunk";

export async function parseText(filePath: string): Promise<PagedText[]> {
  const text = readFileSync(filePath, "utf-8")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return [];
  return [{ text }];
}
