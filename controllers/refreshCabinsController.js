import dotenv from "dotenv";
import prisma from "../config/prisma.js";
import { refreshCabinCategories } from "../services/cruiseIngestionService.js";
import { fetchCelestyalCruiseByCode } from "../scrapers/celestyal/celestyal.js";
import { fetchSeawebVoyageByPackageId } from "../scrapers/seawebagents/seawebagents.js";
import { fetchVoyageByCode } from "../scrapers/completecruisesolution/completecruisesolutionA.js";
import { fetchGohalVoyageByCode } from "../scrapers/gohal/gohal.js";
import { fetchMscVoyageDetails } from "../scrapers/msc/msc.js";
import { fetchAzamaraVoyageByCode } from "../scrapers/azamara/azamara.js";
import { fetchCruisingPowerCategoryDecks, buildCruisingPowerPackageKey } from "../scrapers/cruisingpower/cruisingpower.js";
import { fetchFirstMatesVoyageByCode } from "../scrapers/firstmates/firstmates.js";
import { fetchGocclVoyageByCode } from "../scrapers/goccl/goccl.js";
import { createScraperSession } from "../scrapers/runtime.js";

dotenv.config();

// ── Constants ────────────────────────────────────────────────────────────────
const COOLDOWN_MS        = 2 * 60 * 1000;  // 2 min cooldown after success
const RATE_LIMIT_WINDOW  = 5 * 60 * 1000;  // 5-min rolling window
const RATE_LIMIT_MAX     = 5;              // max 5 fetches per window

const VENDOR_ESTIMATE_MS = {
  celestyal:               60_000,
  seawebagents:            60_000,
  completecruisesolutionA: 120_000,
  completecruisesolutionB: 120_000,
  gohal:                   60_000,
  msc:                     90_000,
  azamara:                 90_000,
  cruisingpower:           600_000,
  firstmates:              150_000,
  goccl:                   60_000,
};

// ── In-memory state (single-instance; resets on restart) ─────────────────────
// code → { startedAt, estimatedMs, vendorSlug }
const activeJobs = new Map();

// code → { completedAt, success, count, error }
const completedJobs = new Map();

// array of timestamps for rate-limit window
const recentRequests = [];

// ── Persistent CCS browser sessions ───────────────────────────────────────────
// Kept open across requests — Chromium drops session-only cookies on browser
// close even with a persistent profile dir, so closing after every refresh
// forces a fresh login every time. Reusing one long-lived session per account
// avoids that. Keyed by "ccs-a" / "ccs-b".
const ccsSessions = new Map();
const ccsQueues   = new Map();

async function getOrCreateCcsSession(key) {
  const existing = ccsSessions.get(key);
  if (existing) {
    const alive = await existing.page.evaluate(() => true).catch(() => false);
    if (alive) return existing;
    await existing.close().catch(() => {});
    ccsSessions.delete(key);
  }
  const session = await createScraperSession({
    userDataDir:      `./sessions/${key}-user-data`,
    storageStatePath: `./sessions/.auth/${key}-storage.json`,
    headless: false, slowMo: 0
  });
  ccsSessions.set(key, session);
  return session;
}

function runExclusiveCcs(key, fn) {
  const queue  = ccsQueues.get(key) ?? Promise.resolve();
  const result = queue.then(fn);
  ccsQueues.set(key, result.catch(() => {}));
  return result;
}

// ── Date helpers ─────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function toDDMMYYYY(d) {
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}
function toMMDDYYYY(d) {
  return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
}
function toDDMmmYY(d) {
  return `${String(d.getDate()).padStart(2,"0")}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
}

// ── Vendor fetch dispatcher ───────────────────────────────────────────────────
async function fetchFreshCategories(vendorSlug, cruiseCode, startDate, shipCode = null, cruiseLine = null) {
  const base = new Date(startDate);

  if (vendorSlug === "celestyal") {
    const fromDate = toDDMMYYYY(new Date(base.getTime() - 3 * 86400000));
    const toDate   = toDDMMYYYY(new Date(base.getTime() + 14 * 86400000));
    const result = await fetchCelestyalCruiseByCode(cruiseCode, { fromDate, toDate });
    return result?.cabinCategories ?? null;
  }

  if (vendorSlug === "seawebagents") {
    // DB code is "seawebagents:{packageId}" — strip the vendor prefix
    const packageId = cruiseCode.replace(/^seawebagents:/, "");
    const fromDate  = toMMDDYYYY(new Date(base.getTime() - 3 * 86400000));
    const toDate    = toMMDDYYYY(new Date(base.getTime() + 3 * 86400000));
    const result = await fetchSeawebVoyageByPackageId(packageId, { fromDate, toDate, shipCode });
    return result?.categories ?? null;
  }

  const isCCS = vendorSlug === "completecruisesolutionA" || vendorSlug === "completecruisesolutionB";
  if (isCCS) {
    const isB  = vendorSlug === "completecruisesolutionB";
    const key  = isB ? "ccs-b" : "ccs-a";
    const creds = isB
      ? { user: process.env.CCS_B_USER, pass: process.env.CCS_B_PASS }
      : { user: process.env.CCS_USER,   pass: process.env.CCS_PASS };
    // POLAR must be switched to the cruise's brand or the voyage won't be found.
    // Cruises carry either the brand key ("PO"/"CUNARD"/"PRINCESS") or, as ingestion
    // stores them now, the display name — the display names used to fall through to
    // null, i.e. the default P&O brand, so Cunard/Princess refreshes never found their voyage.
    const CCS_BRAND_BY_LINE = {
      PO: "PO", CUNARD: "CUNARD", PRINCESS: "PRINCESS",
      "P&O Cruises": "PO", "Cunard Line": "CUNARD", "Cunard": "CUNARD", "Princess Cruises": "PRINCESS",
    };
    const ccsBrand = CCS_BRAND_BY_LINE[cruiseLine] ?? null;
    return runExclusiveCcs(key, async () => {
      const session = await getOrCreateCcsSession(key);
      const result = await fetchVoyageByCode(session, creds, cruiseCode, toDDMmmYY(base), ccsBrand);
      return result?.cabinCategories ?? null;
    });
  }

  if (vendorSlug === "gohal") {
    const CRUISE_LINE_TO_CODE = { "Holland America": "HA", "Cunard": "CU", "Seabourn": "SB" };
    const companyCode = CRUISE_LINE_TO_CODE[cruiseLine] ?? "HA";
    const result = await fetchGohalVoyageByCode(cruiseCode, toDDMmmYY(base), companyCode);
    return result?.cabinCategories ?? null;
  }

  if (vendorSlug === "msc") {
    return fetchMscVoyageDetails({ cruiseCode, shipCode, sailDate: base });
  }

  if (vendorSlug === "azamara") {
    return fetchAzamaraVoyageByCode(cruiseCode, base);
  }

  if (vendorSlug === "firstmates") {
    return fetchFirstMatesVoyageByCode(cruiseCode, base);
  }

  if (vendorSlug === "goccl") {
    return fetchGocclVoyageByCode(cruiseCode, base);
  }

  if (vendorSlug === "cruisingpower") {
    // cruise.code format: CP{packageCode}{YYYYMMDD}  e.g. CPCS10M38520260619
    const noPrefix = cruiseCode.replace(/^CP/, "");
    if (noPrefix.length <= 8) throw new Error(`Cannot extract packageCode from cruise code: ${cruiseCode}`);
    const rawDate    = noPrefix.slice(-8);      // "20260619"
    const packageCode = noPrefix.slice(0, -8);  // "CS10M385"
    const packageKey  = buildCruisingPowerPackageKey(packageCode, rawDate);
    if (!packageKey) throw new Error(`buildCruisingPowerPackageKey failed for ${cruiseCode}`);

    console.log(`[refresh-cabins] cruisingpower packageKey=${packageKey}`);
    const result = await fetchCruisingPowerCategoryDecks({ packageKey });
    if (!result?.categories?.length) return null;

    // Patch ship name onto the cruise record if we extracted it from the page
    if (result.ship) {
      await prisma.cruise.updateMany({
        where: { code: cruiseCode, ship: null },
        data:  { ship: result.ship }
      }).catch(() => {});
    }

    return result.categories.map((cat) => {
      const cabins = (cat.decks ?? []).flatMap((deck) =>
        (deck.cabins ?? []).map((c) => ({
          cabinNumber: String(c.number),
          deckNumber:  deck.deckNumber ?? null,
          deckName:    deck.deckName ?? null,
          capacity:    c.maxOccupancy ?? null,
          status:      c.status ?? null,
        }))
      );
      const priceNum = cat.price ? Number(String(cat.price).replace(/[^0-9.]/g, "")) || null : null;
      // cat.count comes from scraping a `.available.count` cell that's empty
      // for "Prime"/IGT-tier categories, parsing to 0 even with real inventory
      // (confirmed live: Celebrity Beyond's C1/E1/E2 showed avail=0 with 22/11/31
      // real cabins). `cat.count ?? cabins.length` never caught this because 0
      // is not nullish — `0 ?? X` is 0, not X. Once we've actually enumerated
      // cabins that's ground truth and should win. Same bug, same fix already
      // applied in cruisingpower.js's bulk deck pass; this is the separate
      // per-cruise refresh path and was never touched by that fix.
      const realAvail = cabins.length > 0 ? cabins.length : (cat.count ?? 0);
      return {
        code:           cat.code,
        name:           cat.name ?? cat.code,
        group:          null,
        status:         cat.status === "WLT" ? "Waitlist" : "Available",
        avlResult:      cat.status !== "WLT" ? "OK" : null,
        avail:          realAvail,
        cabinPrice:     priceNum,
        perPersonPrice: priceNum,
        confidence:     cabins.length > 0 ? "Medium" : "Low",
        promos:         [],
        cabins,
      };
    });
  }

  return null;
}

// ── Background job runner ─────────────────────────────────────────────────────
function runJob(code, vendorSlug, startDate, shipCode = null, cruiseLine = null) {
  (async () => {
    try {
      console.log(`[refresh-cabins] job started: ${code} via ${vendorSlug}`);
      const cats = await fetchFreshCategories(vendorSlug, code, startDate, shipCode, cruiseLine);
      if (!cats || cats.length === 0) throw new Error("Voyage not found or no categories returned from vendor");
      // Categories existing isn't enough — those can come back priced but with
      // an empty cabins[] (a partial/failed deck-fetch, e.g. the vendor wizard
      // stalling before reaching the stateroom list). Only that survives past
      // here used to still count as "success", overwrite any real cabin data
      // already on file with empty categories, and stamp a fresh timestamp —
      // reporting success while actually erasing good data. If deck data
      // didn't come through, this must fail, not silently "succeed" empty.
      const gotRealCabins = cats.some((c) => (c.cabins ?? []).length > 0);
      if (!gotRealCabins) throw new Error("Categories found but no cabin/deck data returned from vendor — not overwriting existing data");
      await refreshCabinCategories(code, cats, vendorSlug);
      console.log(`[refresh-cabins] job done: ${code} — ${cats.length} categories`);
      completedJobs.set(code, { completedAt: Date.now(), success: true, count: cats.length });
    } catch (err) {
      console.error(`[refresh-cabins] job failed: ${code} —`, err.message);
      completedJobs.set(code, { completedAt: Date.now(), success: false, error: err.message });
      // A dead POLAR SSO inside the cached CCS browser can't self-heal (lands on
      // the logged-out OneSource page forever) — drop it so the next attempt
      // starts a fresh session and login.
      const ccsKey = vendorSlug === "completecruisesolutionB" ? "ccs-b"
                   : vendorSlug === "completecruisesolutionA" ? "ccs-a" : null;
      if (ccsKey && ccsSessions.has(ccsKey)) {
        await ccsSessions.get(ccsKey).close().catch(() => {});
        ccsSessions.delete(ccsKey);
        console.log(`[refresh-cabins] dropped stale ${ccsKey} session after failure`);
      }
    } finally {
      activeJobs.delete(code);
    }
  })();
}

// ── POST /api/cruises/:code/refresh-cabins ────────────────────────────────────
export async function refreshCabinsController({ params, body }) {
  const code = decodeURIComponent(params.code);
  const { vendorKey } = body ?? {};

  if (!vendorKey) {
    return { statusCode: 400, body: { ok: false, error: "vendorKey is required" } };
  }

  // Already running for this cruise?
  if (activeJobs.has(code)) {
    const job = activeJobs.get(code);
    const elapsed  = Date.now() - job.startedAt;
    const remaining = Math.max(0, job.estimatedMs - elapsed);
    return {
      statusCode: 409,
      body: { ok: false, status: "in_progress", estimatedMs: job.estimatedMs, elapsed, remaining }
    };
  }

  // Cooldown check
  const prev = completedJobs.get(code);
  if (prev) {
    const sinceCompleted = Date.now() - prev.completedAt;
    if (sinceCompleted < COOLDOWN_MS) {
      const retryAfter = Math.ceil((COOLDOWN_MS - sinceCompleted) / 1000);
      return {
        statusCode: 429,
        body: { ok: false, status: "cooldown", retryAfter, completedAt: prev.completedAt }
      };
    }
  }

  // Rate limit check
  const windowStart = Date.now() - RATE_LIMIT_WINDOW;
  // Prune old entries
  while (recentRequests.length && recentRequests[0] < windowStart) recentRequests.shift();
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((recentRequests[0] + RATE_LIMIT_WINDOW - Date.now()) / 1000);
    return {
      statusCode: 429,
      body: { ok: false, status: "rate_limited", retryAfter, message: `Max ${RATE_LIMIT_MAX} fetches per 5 minutes reached.` }
    };
  }

  // Look up cruise
  // code is unique per vendor (not globally) — prefer the row matching the
  // requesting vendorKey, fall back to any row with that code.
  const cruise = await prisma.cruise.findFirst({
    where: { code, vendor: { slug: vendorKey } },
    select: { startDate: true, shipCode: true, cruiseLine: true, vendor: { select: { slug: true } } }
  }) ?? await prisma.cruise.findFirst({
    where: { code },
    select: { startDate: true, shipCode: true, cruiseLine: true, vendor: { select: { slug: true } } }
  });
  if (!cruise) return { statusCode: 404, body: { ok: false, error: `Cruise not found: ${code}` } };

  const vendorSlug = cruise.vendor?.slug ?? vendorKey;

  // For MSC, startDate is often null in the DB (not returned by bulk search endpoint).
  // Fall back to extracting the embedded YYYYMMDD from the cruise code (e.g. OR20260611MRSVLC).
  let effectiveStartDate = cruise.startDate;
  if (!effectiveStartDate && vendorSlug === "msc") {
    const m = code.match(/(\d{8})/);
    if (m) effectiveStartDate = new Date(`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`);
  }
  if (!effectiveStartDate) return { statusCode: 422, body: { ok: false, error: "Cruise has no startDate" } };

  const estimatedMs = VENDOR_ESTIMATE_MS[vendorSlug] ?? 120_000;

  // Record and start job
  recentRequests.push(Date.now());
  activeJobs.set(code, { startedAt: Date.now(), estimatedMs, vendorSlug });
  runJob(code, vendorSlug, effectiveStartDate, cruise.shipCode ?? null, cruise.cruiseLine ?? null);

  return {
    statusCode: 202,
    body: { ok: true, status: "started", estimatedMs }
  };
}

// ── GET /api/cruises/:code/refresh-status ────────────────────────────────────
export async function refreshCabinsStatusController({ params }) {
  const code = decodeURIComponent(params.code);

  if (activeJobs.has(code)) {
    const job      = activeJobs.get(code);
    const elapsed  = Date.now() - job.startedAt;
    const remaining = Math.max(0, job.estimatedMs - elapsed);
    return {
      statusCode: 200,
      body: { status: "in_progress", estimatedMs: job.estimatedMs, elapsed, remaining }
    };
  }

  const prev = completedJobs.get(code);
  if (prev) {
    const sinceCompleted  = Date.now() - prev.completedAt;
    const cooldownRemaining = Math.max(0, COOLDOWN_MS - sinceCompleted);
    return {
      statusCode: 200,
      body: {
        status:     cooldownRemaining > 0 ? "cooldown" : "idle",
        success:    prev.success,
        count:      prev.count ?? null,
        error:      prev.error ?? null,
        completedAt: prev.completedAt,
        retryAfter: cooldownRemaining > 0 ? Math.ceil(cooldownRemaining / 1000) : 0
      }
    };
  }

  return { statusCode: 200, body: { status: "idle" } };
}
