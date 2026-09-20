// Assign static itineraries to all cruises that have no ItineraryStop rows.
// Usage: node scripts/backfill-static-itineraries.js [--dry]
//   --dry  report what would match without writing anything

import { PrismaClient } from "@prisma/client";
import {
  loadStaticCache,
  loadPortAliasCache,
  matchStaticItinerary,
  shipKeyForCruise,
  assignStaticItinerary,
} from "../services/staticItineraryService.js";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

const cruises = await prisma.cruise.findMany({
  where: { itineraryStops: { none: {} } },
  select: { id: true, code: true, ship: true, vendorId: true, portFrom: true, portTo: true, nights: true },
});
console.log(`${cruises.length} cruises without itinerary stops`);

await loadPortAliasCache();
const cache = await loadStaticCache();
const vendors = Object.fromEntries((await prisma.vendor.findMany()).map(v => [v.id, v.name]));

let matched = 0, noShip = 0, noRoute = 0, written = 0;
const byVendor = {};
for (const c of cruises) {
  const candidates = cache.get(shipKeyForCruise(c.ship));
  const v = vendors[c.vendorId] ?? c.vendorId;
  byVendor[v] = byVendor[v] ?? { total: 0, matched: 0, noShip: 0, noRoute: 0 };
  byVendor[v].total++;
  if (!candidates) { noShip++; byVendor[v].noShip++; continue; }
  const m = matchStaticItinerary(c, candidates);
  if (!m) { noRoute++; byVendor[v].noRoute++; continue; }
  matched++; byVendor[v].matched++;
  if (DRY) {
    if (byVendor[v].matched <= 3) {
      console.log(`  [${v}] ${c.code} ${c.ship} ${c.portFrom}->${c.portTo} (${c.nights}N) => "${m.shipName}" ${m.portFrom}->${m.portTo} (${m.nights}N, ${m.stops.length} stops)`);
    }
  } else {
    written += await assignStaticItinerary(c);
  }
}

console.log(`\nmatched ${matched}/${cruises.length} | ship not in static data: ${noShip} | ship ok but route unmatched: ${noRoute}`);
console.log("\nper vendor:");
for (const [v, s] of Object.entries(byVendor)) {
  console.log(`  ${v}: ${s.matched}/${s.total} matched (no-ship ${s.noShip}, no-route ${s.noRoute})`);
}
if (!DRY) console.log(`\nwrote ${written} itinerary stops`);
await prisma.$disconnect();
process.exit(0); // staticItineraryService holds its own PrismaClient open
