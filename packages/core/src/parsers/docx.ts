import mammoth from "mammoth";
import type { PagedText } from "../chunk";

export async function parseDocx(filePath: string): Promise<PagedText[]> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value.replace(/\s+/g, " ").trim();
  if (!text) return [];
  return [{ text }];
}
