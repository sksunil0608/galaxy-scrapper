// Fill in cabin/deck data for every cruise that still lacks it.
//
// Deck data isn't part of any vendor's search response — cabin numbers live
// behind the booking flow, one cruise at a time (~1-1.5 min each). A single
// scheduled run can only ever cover a slice, so coverage never catches up on
// its own. This walks every vendor and repeats its detail pass, batch after
// batch, until that vendor's gap is empty (or a safety cap of rounds is hit).
//
// Sequential by design: each vendor drives a real browser session, so running
// several at once starves them all.
//
//   node scripts/sweep-deck-data.js [--dry]

import prisma from "../config/prisma.js";

const SCRAPER = process.env.SCRAPER_URL ?? "http://localhost:3001";
const DRY = process.argv.includes("--dry");

// 3 months, per explicit instruction after the 2026-08-02 full Cabin wipe —
// every vendor should re-cover this whole window, not just a quick sample.
const HORIZON_DAYS = 90;

// Order matters: vendors run one after another, so a slow or wedged vendor
// delays everything behind it. CruisingPower used to be first and hung on
// cruise 26 of 111 while holding the slot for 3.5 hours — msc and celestyal
// never got a turn at all. Proven-fast vendors go first now, and the ones that
// habitually stall go last where they can only cost themselves.
//
// Each entry is a single batch's options — the same batch is repeated (see the
// round loop below) until that vendor's gap is empty, rather than a fixed
// count of batches, since a full wipe means the true gap size isn't known
// ahead of time. Option shapes are copied from jobs/scheduler.js's own
// "detail" tiers, which are the proven-working shape for each vendor.
const PLANS = {
  msc:        [{ withDecks: true, maxDeckCruises: 50, horizonDays: HORIZON_DAYS }],
  celestyal:  [{ listOnly: false, maxDeckCruises: 40, horizonDays: HORIZON_DAYS }],
  goccl:      [{ withDecks: true, maxDeckCruises: 250, maxCruises: 300, enrichRates: false, horizonDays: HORIZON_DAYS }],
  gohal:      [{ maxPages: 10, horizonDays: HORIZON_DAYS }],
  completecruisesolutionA: [{ maxPages: 10, horizonDays: HORIZON_DAYS, brands: ["PO", "CUNARD", "PRINCESS"] }],
  completecruisesolutionB: [{ maxPages: 10, horizonDays: HORIZON_DAYS, brands: ["PO", "CUNARD", "PRINCESS"] }],
  seawebagents: [{ listOnly: false, horizonDays: HORIZON_DAYS, chunkDays: 15 }],
  azamara:    [{ listOnly: false, maxDeckCruises: 60, horizonDays: HORIZON_DAYS, occupancy: 2 }],
  // firstmates: coverage is near-zero (its search frame was down ~4 days), so
  // every sailing in the window needs a first detail pass.
  firstmates: [{ listOnly: false, maxDeckCruises: 60, horizonDays: HORIZON_DAYS }],
  cruisingpower: [
    { brand: "C", withDecks: true, maxDeckCruises: 150, horizonDays: HORIZON_DAYS },
    { brand: "R", withDecks: true, maxDeckCruises: 150, horizonDays: HORIZON_DAYS }
  ]
};

// Repeating a vendor's batch forever would spin if some remainder can never
// get cabins for a reason outside our "OK category" filter (e.g. a vendor-side
// quirk) — cap rounds so the sweep always moves on to the next vendor instead
// of stalling here permanently. 3 months at ~50-150 cruises/batch should not
// need more than this for any one vendor.
const MAX_ROUNDS_PER_PLAN = 12;

// No vendor gets to hold the queue indefinitely. A wedged espresso session kept
// one run "in flight" for 3.5 hours; past this the sweep stops waiting and
// moves on rather than stranding every vendor behind it.
const RUN_TIMEOUT_MS = 75 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gapsByVendor() {
  const vendors = await prisma.vendor.findMany({ select: { id: true, slug: true } });
  const out = {};
  for (const v of vendors) {
    // Only count sailings that actually report availability — a sold-out
    // cruise legitimately has no cabins to fetch.
    out[v.slug] = await prisma.cruise.count({
      where: {
        vendorId: v.id,
        cabinCategories: { some: { avlResult: "OK" } },
        NOT: { cabinCategories: { some: { cabins: { some: {} } } } }
      }
    });
  }
  return out;
}

// The scheduler runs vendors back-to-back all day, so waiting for a completely
// idle server means never starting at all — this waited 90 minutes straight
// without a turn. The server itself happily runs two vendors at once, so match
// that: hold below a concurrency cap instead of demanding zero, and never queue
// a vendor that already has a run in flight.
const MAX_CONCURRENT = 2;

/** Straight from the DB — an endpoint's payload shape could drift. */
async function activeRunVendors() {
  const runs = await prisma.vendorRun.findMany({
    where: { status: "running" },
    include: { vendor: { select: { slug: true } } }
  });
  return runs.map(r => r.vendor.slug);
}

async function waitForSlot(vendor) {
  for (;;) {
    const active = await activeRunVendors();
    if (active.length < MAX_CONCURRENT && !active.includes(vendor)) return;
    console.log(`[sweep] waiting for a slot (${active.length} active: ${active.join(", ") || "none"})`);
    await sleep(60000);
  }
}

async function trigger(vendor, options) {
  const res = await fetch(`${SCRAPER}/api/scrapers/${vendor}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: new Date().toISOString().slice(0, 10), ...options })
  });
  const body = await res.json().catch(() => ({}));
  return body?.result?.runId ?? null;
}

// A run is created as "queued" and only later flips to "running", so anything
// that isn't yet finished counts as in-flight. Checking for "running" alone
// reads a freshly-queued run as already over.
const IN_FLIGHT = new Set(["queued", "running", "pending", "starting"]);

async function waitForRun(runId) {
  // A trigger can come back with an id that is already finished — the server
  // hands back its in-memory "active run" for the vendor, which survives a
  // killed scraper as a stale row. Treat that as a no-op rather than reporting
  // it as this sweep's result.
  const initial = await prisma.vendorRun.findUnique({ where: { id: runId } });
  if (initial && !IN_FLIGHT.has(initial.status)) {
    return `stale (${initial.status} before we started)`;
  }

  // Detail passes are long; poll slowly rather than hammering the DB.
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    await sleep(30000);
    const run = await prisma.vendorRun.findUnique({ where: { id: runId } });
    if (!run) return "missing";
    if (!IN_FLIGHT.has(run.status)) return run.status;
    if (Date.now() > deadline) return `abandoned (still ${run.status} after ${RUN_TIMEOUT_MS / 60000}m)`;
  }
}

(async () => {
  const before = await gapsByVendor();
  console.log("=== gaps before (availability present, no cabins) ===");
  for (const [k, n] of Object.entries(before)) if (n > 0) console.log(`  ${k.padEnd(24)} ${n}`);

  if (DRY) { await prisma.$disconnect(); return; }

  for (const [vendor, plans] of Object.entries(PLANS)) {
    for (const plan of plans) {
      // Repeat this same batch config until the gap stops shrinking (either
      // it hits 0, or a round makes no further progress — everything left is
      // presumably unfetchable for a reason outside our OK-category filter).
      let round = 0;
      let lastGap = null;
      for (;;) {
        const gap = (await gapsByVendor())[vendor] ?? 0;
        if (gap === 0) { console.log(`[sweep] ${vendor}: gap closed, moving on`); break; }
        if (round >= MAX_ROUNDS_PER_PLAN) { console.log(`[sweep] ${vendor}: hit ${MAX_ROUNDS_PER_PLAN}-round cap with ${gap} still missing — moving on`); break; }
        if (lastGap != null && gap >= lastGap) {
          console.log(`[sweep] ${vendor}: no progress last round (${lastGap} -> ${gap}) — remainder likely unfetchable, moving on`);
          break;
        }
        lastGap = gap;
        round++;

        await waitForSlot(vendor);
        console.log(`\n[sweep] ${vendor} round ${round}: ${gap} cruises missing cabins — triggering`, plan);
        const runId = await trigger(vendor, plan);
        if (!runId) { console.log(`[sweep] ${vendor}: trigger failed, moving on`); break; }

        const status = await waitForRun(runId);
        const after = (await gapsByVendor())[vendor] ?? 0;
        console.log(`[sweep] ${vendor}: run ${runId} ${status} — gap ${gap} -> ${after}`);
      }
    }
  }

  const after = await gapsByVendor();
  console.log("\n=== gaps after ===");
  for (const [k, n] of Object.entries(after)) console.log(`  ${k.padEnd(24)} ${before[k] ?? 0} -> ${n}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error("[sweep] failed:", e.message);
  process.exit(1);
});
