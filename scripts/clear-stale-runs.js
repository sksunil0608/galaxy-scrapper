// Mark long-"running" VendorRun rows as failed.
//
// A run row only flips to completed/failed when its own process gets to write
// the result, so a killed scraper leaves the row stuck at "running" forever.
// Anything that waits on "no active runs" — the deck sweep does — then blocks
// indefinitely on a run whose process is long gone.
//
//   node scripts/clear-stale-runs.js [olderThanMinutes]   (default 40)

import prisma from "../config/prisma.js";

const minutes = Number(process.argv[2] ?? 40);
const cutoff = new Date(Date.now() - minutes * 60000);

const stale = await prisma.vendorRun.findMany({
  where: { status: "running", startedAt: { lt: cutoff } },
  include: { vendor: { select: { slug: true } } }
});

if (stale.length === 0) {
  console.log(`no runs older than ${minutes}m stuck in "running"`);
} else {
  for (const r of stale) {
    const mins = Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60000);
    console.log(`marking run ${r.id} (${r.vendor.slug}, running ${mins}m) as failed`);
  }
  const { count } = await prisma.vendorRun.updateMany({
    where: { id: { in: stale.map(r => r.id) } },
    data: { status: "failed", finishedAt: new Date(), notes: `stale: no progress for >${minutes}m, process gone` }
  });
  console.log(`cleared ${count}`);
}

await prisma.$disconnect();
