import cron from "node-cron";
import { triggerVendorScrape } from "../services/vendorScrapeService.js";

// ── Date helpers ──────────────────────────────────────────────────────────────

const MON_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// YYYY-MM-DD (seawebagents startDate, azamara, cruisingpower)
function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// DD/MM/YYYY (celestyal)
function toCelestyalDate(d) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

// DDMonYY (gohal / POLAR / completecruisesolution)
function toGohalDate(d) {
  const dd  = String(d.getUTCDate()).padStart(2, "0");
  const mon = MON_ABBR[d.getUTCMonth()];
  const yy  = String(d.getUTCFullYear()).slice(-2);
  return `${dd}${mon}${yy}`;
}

// ── Cron helpers ──────────────────────────────────────────────────────────────

function cronExpression(intervalDays, startHour, startMin = 0) {
  const dayPart = intervalDays === 1 ? "*" : `*/${intervalDays}`;
  return `${startMin} ${startHour} ${dayPart} * *`;
}

// ── Per-vendor option resolution ──────────────────────────────────────────────
//
// Each vendor expects different date param names/formats.
// horizonDays is scheduler-internal — transform it at fire time.
// startOffsetDays shifts the window start: from = today + offset.

function resolveOptions(tier) {
  const opts       = { ...tier.options };
  const offsetDays = tier.startOffsetDays ?? 0;
  const horizon    = opts.horizonDays;   // may be undefined for some vendors

  const from = new Date();
  from.setUTCDate(from.getUTCDate() + offsetDays);

  switch (tier.key) {

    case "seawebagents":
      // startDate YYYY-MM-DD, horizonDays stays (scraper uses it natively)
      opts.startDate = toISODate(from);
      break;

    case "celestyal": {
      // fromDate / toDate in DD/MM/YYYY
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + (horizon ?? 60));
      delete opts.horizonDays;
      opts.fromDate = toCelestyalDate(from);
      opts.toDate   = toCelestyalDate(to);
      break;
    }

    case "azamara":
    case "cruisingpower": {
      // fromDate / toDate in YYYY-MM-DD
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + (horizon ?? 60));
      delete opts.horizonDays;
      opts.fromDate = toISODate(from);
      opts.toDate   = toISODate(to);
      break;
    }

    case "msc": {
      // monthsAhead drives buildMonthlyRanges(), which sweeps whole CALENDAR
      // months from the start month — so it has to be the number of distinct
      // months the window touches. horizon/30 undercounts whenever the window
      // starts late in a month (a 30-day tier fired on the 31st resolved to
      // 1 month, i.e. only the month that was already over).
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + (horizon ?? 60));
      delete opts.horizonDays;
      opts.startDate   = from;
      opts.monthsAhead = Math.max(
        1,
        (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1
      );
      break;
    }

    case "goccl":
      // The search REQUIRES a month range (sailingDateFrom/To), so dropping
      // horizonDays didn't mean "no filter" — it left start and end in the same
      // month, and once that month is nearly over the search returns nothing
      // (a run on the 31st asked for 072026-072026 and got 0 sailings). Keep
      // whatever horizon the tier asked for, defaulting to a wide one.
      opts.horizonDays = opts.horizonDays ?? 180;
      // normalizeDateOptions (vendorScrapeService) only turns horizonDays into the
      // sailingDateFrom/To month range when a startDate is present — without one
      // it returns the options untouched and runGocclScraper falls back to the
      // CURRENT month alone. Every scheduled goccl run therefore searched one
      // month (12 sailings on 25 Sep) no matter what horizon the tier asked for.
      opts.startDate = from;
      break;

    case "firstmates":
      // No date param — the bulk search uses whatever default window the
      // app's own "Search Voyages" click applies; runFirstMatesScraper only
      // takes listOnly/maxDeckCruises.
      delete opts.horizonDays;
      break;

    case "gohal":
    case "completecruisesolutionA":
    case "completecruisesolutionB":
      // sailDate in DDMonYY (POLAR system)
      delete opts.horizonDays;
      opts.sailDate = toGohalDate(from);
      break;
  }

  return opts;
}

async function runScheduledScrape(tier) {
  const opts = resolveOptions(tier);
  console.log(`[scheduler] ${tier.label} — triggering ${tier.key}`, opts);
  try {
    const result = await triggerVendorScrape(tier.key, opts);
    console.log(`[scheduler] ${tier.label} queued — runId: ${result.runId}`);
  } catch (err) {
    if (err.statusCode === 409) {
      console.log(`[scheduler] ${tier.label} already running — skipping this tick`);
    } else {
      console.error(`[scheduler] ${tier.label} failed to queue:`, err.message);
    }
  }
}

// ── Tiered booking-window schedule ───────────────────────────────────────────
//
// intervalDays     : how often this tier fires
// startHour        : UTC hour (staggered so vendors don't all run at once)
// startMin         : UTC minute within the hour
// startOffsetDays  : shift window start N days from today (computed at fire time)
//                    omit / 0 = start from today
// options.horizonDays : window width in days (transformed per-vendor in resolveOptions)
// enabled          : false = pause without deleting
//
const TIERS = [

  // ── seawebagents (6 tiers, full detail, rolling windows) ─────────────
  // startDate = today + offset, end = startDate + horizonDays
  { label: "seawebagents 0-30d",    key: "seawebagents", intervalDays: 1,  startHour: 2, startMin: 0,  startOffsetDays: 0,   options: { horizonDays: 30,  chunkDays: 15, listOnly: false }, enabled: true },
  { label: "seawebagents 30-90d",   key: "seawebagents", intervalDays: 2,  startHour: 2, startMin: 30, startOffsetDays: 30,  options: { horizonDays: 60,  chunkDays: 15, listOnly: false }, enabled: true },
  { label: "seawebagents 90-180d",  key: "seawebagents", intervalDays: 3,  startHour: 3, startMin: 0,  startOffsetDays: 90,  options: { horizonDays: 90,  chunkDays: 15, listOnly: false }, enabled: true },
  { label: "seawebagents 180-365d", key: "seawebagents", intervalDays: 5,  startHour: 3, startMin: 30, startOffsetDays: 180, options: { horizonDays: 185, chunkDays: 15, listOnly: false }, enabled: true },
  { label: "seawebagents 365-540d", key: "seawebagents", intervalDays: 7,  startHour: 4, startMin: 0,  startOffsetDays: 365, options: { horizonDays: 175, chunkDays: 15, listOnly: false }, enabled: true },
  { label: "seawebagents 540-730d", key: "seawebagents", intervalDays: 14, startHour: 4, startMin: 30, startOffsetDays: 540, options: { horizonDays: 190, chunkDays: 15, listOnly: false }, enabled: true },

  // ── celestyal (3 list tiers + 1 detail tier, fromDate/toDate DD/MM/YYYY) ──
  // Daily for 60d (changes frequently), less often for longer windows.
  { label: "celestyal 0-60d",   key: "celestyal", intervalDays: 1, startHour: 5, startMin: 0,  options: { horizonDays: 60  }, enabled: true },
  { label: "celestyal 0-180d",  key: "celestyal", intervalDays: 3, startHour: 5, startMin: 30, options: { horizonDays: 180 }, enabled: true },
  { label: "celestyal 0-365d",  key: "celestyal", intervalDays: 7, startHour: 6, startMin: 0,  options: { horizonDays: 365 }, enabled: true },
  // Full cabin/deck detail — each cruise takes ~1.5-3 min (per-category direct
  // fetch), so cap maxDeckCruises to bound runtime like firstmates does.
  { label: "celestyal detail",  key: "celestyal", intervalDays: 2, startHour: 6, startMin: 30, options: { horizonDays: 180, listOnly: false, maxDeckCruises: 120 }, enabled: true },

  // ── MSC (2 tiers, startDate + monthsAhead) ────────────────────────────
  { label: "msc 0-30d",   key: "msc", intervalDays: 1, startHour: 6, startMin: 30, options: { horizonDays: 30  }, enabled: true },
  { label: "msc 0-180d",  key: "msc", intervalDays: 3, startHour: 7, startMin: 0,  options: { horizonDays: 180 }, enabled: true },

  // ── goccl (2 list tiers + 1 detail tier, no date filter — varies maxCruises) ──
  { label: "goccl daily",  key: "goccl", intervalDays: 1, startHour: 7, startMin: 30, options: { horizonDays: 180, maxCruises: 50,  enrichRates: true }, enabled: true },
  { label: "goccl weekly", key: "goccl", intervalDays: 7, startHour: 8, startMin: 0,  options: { horizonDays: 365, maxCruises: 200, enrichRates: true }, enabled: true },
  // runGocclScraper defaults to withDecks:false, so neither tier above ever
  // fetched a cabin — the stored deck data all came from one manual run and
  // would decay as new sailings arrived. Deck fetch is ~20s/cruise (355 took
  // ~2h), so cap maxDeckCruises to keep this tier's runtime bounded.
  { label: "goccl detail", key: "goccl", intervalDays: 2, startHour: 8, startMin: 30, options: { horizonDays: 180, maxCruises: 250, enrichRates: true, withDecks: true, maxDeckCruises: 250 }, enabled: true },

  // ── cruisingpower (fromDate/toDate YYYY-MM-DD) ────────────────────────
  // runCruisingPowerScraper takes ONE brand per run and defaults to "C"
  // (Celebrity). Every tier here used to pass "C", so Royal Caribbean — the
  // other brand this portal serves, and the majority of its voyage catalogue —
  // was never scraped at all. Each brand therefore needs its own tiers.
  // PAUSED (2026-09-24): secure.cruisingpower.com rejects the credentials in .env ("Your attempt to sign in was unsuccessful"), and every tier below performs a login — retrying a wrong password risks locking the account. Fix CRUISINGPOWER_USER/CRUISINGPOWER_PASS, then set enabled back to true.
  { label: "cruisingpower C 0-30d",   key: "cruisingpower", intervalDays: 1, startHour: 8,  startMin: 30, options: { horizonDays: 30,  brand: "C", maxDeckCruises: 6 }, enabled: false },
  { label: "cruisingpower C 0-180d",  key: "cruisingpower", intervalDays: 3, startHour: 9,  startMin: 0,  options: { horizonDays: 180, brand: "C", maxDeckCruises: 8 }, enabled: false },
  { label: "cruisingpower C 0-365d",  key: "cruisingpower", intervalDays: 7, startHour: 9,  startMin: 30, options: { horizonDays: 365, brand: "C", maxDeckCruises: 10 }, enabled: false },
  { label: "cruisingpower R 0-30d",   key: "cruisingpower", intervalDays: 1, startHour: 15, startMin: 30, options: { horizonDays: 30,  brand: "R", maxDeckCruises: 6 }, enabled: false },
  { label: "cruisingpower R 0-180d",  key: "cruisingpower", intervalDays: 3, startHour: 16, startMin: 0,  options: { horizonDays: 180, brand: "R", maxDeckCruises: 8 }, enabled: false },
  { label: "cruisingpower R 0-365d",  key: "cruisingpower", intervalDays: 7, startHour: 16, startMin: 30, options: { horizonDays: 365, brand: "R", maxDeckCruises: 10 }, enabled: false },

  // ── azamara (2 list tiers + 1 detail tier, fromDate/toDate YYYY-MM-DD) ─
  { label: "azamara 0-30d",   key: "azamara", intervalDays: 2, startHour: 10, startMin: 0,  options: { horizonDays: 30,  occupancy: 2 }, enabled: true },
  { label: "azamara 0-180d",  key: "azamara", intervalDays: 5, startHour: 10, startMin: 30, options: { horizonDays: 180, occupancy: 2 }, enabled: true },
  // runAzamaraScraper defaults to listOnly:true, so without this tier the
  // vendor never fetched a single cabin — only 1 of 10 stored cruises had
  // cabin data, and that one came from a manual run. Same shape as the
  // celestyal/firstmates detail tiers: capped so runtime stays bounded.
  { label: "azamara detail",  key: "azamara", intervalDays: 2, startHour: 11, startMin: 0,  options: { horizonDays: 180, occupancy: 2, listOnly: false, maxDeckCruises: 60 }, enabled: true },

  // ── completecruisesolutionA (2 tiers, POLAR sailDate DDMonYY) ─────────
  // brands: same POLAR backend serves P&O (default), Cunard and Princess
  { label: "ccsA near",  key: "completecruisesolutionA", intervalDays: 3,  startHour: 11, startMin: 0,  startOffsetDays: 30,  options: { maxPages: 5, brands: ["PO", "CUNARD", "PRINCESS"] }, enabled: true },
  { label: "ccsA far",   key: "completecruisesolutionA", intervalDays: 7,  startHour: 11, startMin: 30, startOffsetDays: 180, options: { maxPages: 5, brands: ["PO", "CUNARD", "PRINCESS"] }, enabled: true },

  // ── completecruisesolutionB (2 tiers, POLAR sailDate DDMonYY) ─────────
  { label: "ccsB near",  key: "completecruisesolutionB", intervalDays: 3,  startHour: 12, startMin: 0,  startOffsetDays: 30,  options: { maxPages: 5, brands: ["PO", "CUNARD", "PRINCESS"] }, enabled: true },
  { label: "ccsB far",   key: "completecruisesolutionB", intervalDays: 7,  startHour: 12, startMin: 30, startOffsetDays: 180, options: { maxPages: 5, brands: ["PO", "CUNARD", "PRINCESS"] }, enabled: true },

  // ── gohal (2 tiers, sailDate DDMonYY) ─────────────────────────────────
  { label: "gohal near",  key: "gohal", intervalDays: 3,  startHour: 13, startMin: 0,  startOffsetDays: 30,  options: { maxPages: 5 }, enabled: true },
  { label: "gohal far",   key: "gohal", intervalDays: 14, startHour: 13, startMin: 30, startOffsetDays: 180, options: { maxPages: 5 }, enabled: true },

  // ── firstmates (2 tiers: fast list-only + capped full-detail) ────────
  // Full-detail cabin fetch takes ~2 min per voyage (per-category direct
  // fetch via the SwToken auth header) — cap maxDeckCruises to bound runtime.
  { label: "firstmates list",   key: "firstmates", intervalDays: 1, startHour: 14, startMin: 0,  options: { listOnly: true }, enabled: true },
  { label: "firstmates detail", key: "firstmates", intervalDays: 3, startHour: 14, startMin: 30, options: { listOnly: false, maxDeckCruises: 40, monthsAhead: 9 }, enabled: true },
];

// ── Public API ────────────────────────────────────────────────────────────────

export function startScheduler() {
  for (const tier of TIERS) {
    if (!tier.enabled) continue;
    const expr = cronExpression(tier.intervalDays, tier.startHour, tier.startMin ?? 0);
    cron.schedule(expr, () => runScheduledScrape(tier), { timezone: "UTC" });
    console.log(`[scheduler] registered "${tier.label}": ${expr}`);
  }
}

export function getScheduleConfig() {
  return TIERS.map(tier => ({
    label:           tier.label,
    vendorKey:       tier.key,
    intervalDays:    tier.intervalDays,
    startHour:       tier.startHour,
    startMin:        tier.startMin ?? 0,
    startOffsetDays: tier.startOffsetDays ?? 0,
    options:         tier.options,
    enabled:         tier.enabled,
    cronExpr:        cronExpression(tier.intervalDays, tier.startHour, tier.startMin ?? 0),
  }));
}
