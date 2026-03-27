import JSZip from "jszip";
import { readFileSync } from "fs";
import type { PagedText } from "../chunk";

// Extracts text from ODF files (ODT, ODP, ODS) by parsing content.xml
export async function parseOdf(filePath: string): Promise<PagedText[]> {
  const data = readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const contentXml = await zip.file("content.xml")?.async("string");
  if (!contentXml) return [];

  // Strip XML tags and collapse whitespace
  const text = contentXml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return [];
  return [{ text }];
}
