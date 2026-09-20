// One-shot import of Book1.xlsx into the StaticItinerary table.
// Usage: node scripts/import-static-itineraries.js [path-to-xlsx]
// Re-running wipes and re-imports (reference data, safe to replace).

import { PrismaClient } from "@prisma/client";
import XLSX from "xlsx";
import { normalizeShip, routeKey } from "../services/staticItineraryService.js";

const prisma = new PrismaClient();
const FILE = process.argv[2] ?? "C:/Users/admin/Desktop/Galaxy/Book1.xlsx";

function parseNights(link) {
  const m = String(link ?? "").match(/_(\d+)_nights?_/i);
  return m ? parseInt(m[1], 10) : null;
}

function splitRoute(route) {
  const parts = String(route ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return [null, null];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [parts[0], parts[parts.length - 1]];
}

const wb = XLSX.readFile(FILE);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });

const records = [];
let skipped = 0;
for (const r of rows.slice(1)) {
  const shipName = String(r[1] ?? "").trim();
  const route = String(r[2] ?? "").trim();
  const itinerary = String(r[3] ?? "").trim();
  if (!shipName || !itinerary) { skipped++; continue; }

  const stops = itinerary.split(",").map(s => s.trim()).filter(Boolean);
  if (stops.length < 2) { skipped++; continue; }

  const [portFrom, portTo] = splitRoute(route);
  const price = Number(r[8]);

  records.push({
    shipName,
    shipKey: normalizeShip(shipName),
    portFrom,
    portTo,
    routeKey: routeKey(portFrom, portTo),
    stops,
    nights: parseNights(r[7]),
    dealsLink: String(r[7] ?? "").trim() || null,
    price: Number.isFinite(price) ? price : null,
  });
}

console.log(`parsed ${records.length} records (${skipped} skipped)`);

await prisma.staticItinerary.deleteMany({});
// createMany in chunks — MySQL placeholder limits
for (let i = 0; i < records.length; i += 200) {
  await prisma.staticItinerary.createMany({ data: records.slice(i, i + 200) });
}
const count = await prisma.staticItinerary.count();
console.log(`imported ${count} static itineraries`);
await prisma.$disconnect();
process.exit(0); // staticItineraryService holds its own PrismaClient open
