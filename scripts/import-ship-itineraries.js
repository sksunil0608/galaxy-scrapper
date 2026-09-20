import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = path.resolve(__dirname, "../../Book1.xlsx");

function parseNightsFromLink(link) {
  const m = String(link ?? "").match(/_(\d+)_nights?_/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  const wb = XLSX.readFile(BOOK_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }).slice(1);

  const records = rows
    .filter((r) => r[1])
    .map((r) => ({
      shipName: String(r[1]).trim(),
      route: r[2] ? String(r[2]).trim() : null,
      itinerary: r[3] ? String(r[3]).trim() : null,
      dealsLink: r[7] ? String(r[7]).trim() : null,
      price: typeof r[8] === "number" ? r[8] : null,
      nights: parseNightsFromLink(r[7]),
    }));

  console.log(`[import] parsed ${records.length} itinerary rows from Book1.xlsx`);

  const existing = await prisma.shipItineraryReference.count();
  if (existing > 0) {
    console.log(`[import] table already has ${existing} rows — skipping (delete existing rows first if you want to re-import)`);
    return;
  }

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    await prisma.shipItineraryReference.createMany({ data: batch });
    inserted += batch.length;
    console.log(`[import] inserted ${inserted}/${records.length}`);
  }

  console.log(`[import] done — ${inserted} rows imported`);
}

main()
  .catch((err) => {
    console.error("[import] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
