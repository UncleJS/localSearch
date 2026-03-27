import * as XLSX from "xlsx";
import type { PagedText } from "../chunk";

export async function parseXlsx(filePath: string): Promise<PagedText[]> {
  const workbook = XLSX.readFile(filePath);
  const pages: PagedText[] = [];

  workbook.SheetNames.forEach((sheetName: string, idx: number) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    const text = csv.replace(/,+/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      pages.push({ text: `[Sheet: ${sheetName}] ${text}`, page: idx + 1 });
    }
  });

  return pages;
}
