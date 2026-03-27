import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PagedText } from "../chunk";

export async function parsePdf(filePath: string): Promise<PagedText[]> {
  const data = new Uint8Array(await Bun.file(filePath).arrayBuffer());

  const doc = await pdfjsLib
    .getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    })
    .promise;

  const pages: PagedText[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((item: any) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > 0) {
      pages.push({ text, page: i });
    }
  }

  return pages;
}
