import prisma from "../config/prisma.js";
import { getScraperDefinition } from "../scrapers/registry.js";
import {
  ensureVendor,
  ingestCruisesForVendor
} from "./cruiseIngestionService.js";
import { writeVendorOutput } from "./outputWriter.js";
import { validateScraperPayload } from "./cruiseValidator.js";

// Each scraper.run() launches its own browser session (createScraperSession),
// so two runs of the SAME vendor for DIFFERENT date windows don't actually
// contend for a shared resource — only true duplicate/overlapping windows do.
// activeRuns therefore keys on vendorKey + a run-scope token (defaults to the
// normalized date range, or "default" when a vendor has no date param) rather
// than vendorKey alone, so e.g. "msc 0-30d" and "msc 90-180d" can run at the
// same time while two triggers for the exact same window still get blocked.
const activeRuns = new Set();

function runScopeKey(vendorKey, options) {
  const scope = options.fromDate && options.toDate
    ? `${options.fromDate}~${options.toDate}`
    : options.sailDate
      ? options.sailDate
      : options.sailingDateFrom && options.sailingDateTo
        ? `${options.sailingDateFrom}~${options.sailingDateTo}`
        : options.runScope ?? "default";
  const shipSuffix = options.shipName ? `::${options.shipName.trim().toUpperCase()}` : "";
  return `${vendorKey}::${scope}${shipSuffix}`;
}

// ── Date normalization ───────────────────────────────────────────────────────
// The frontend always sends a single common shape — { startDate, horizonDays }
// (startDate: "YYYY-MM-DD", horizonDays: number of days from startDate) — but
// every vendor's own run() expects a different shape (some want a date range,
// some a single months-ahead count, some a single formatted sail date, and
// FirstMates wants no date param at all). Rather than push that inconsistency
// onto the frontend or rewrite all 10 scrapers, translate here in one place.
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const yyyymmdd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ddMonYy = (d) => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")}${months[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
};
const mmyyyy = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}${d.getFullYear()}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function normalizeDateOptions(vendorKey, options) {
  if (!options.startDate) return options;

  const start = new Date(options.startDate);
  if (isNaN(start)) return options;

  const horizonDays = Number(options.horizonDays) || 30;
  const end = addDays(start, horizonDays);
  const { startDate, horizonDays: _h, ...rest } = options;

  // shipName (if present on options) is never destructured out below, so it
  // always flows through via ...rest into every vendor's run() untouched.
  switch (vendorKey) {
    case "celestyal":
      return { ...rest, fromDate: ddmmyyyy(start), toDate: ddmmyyyy(end) };
    case "cruisingpower":
    case "azamara":
      return { ...rest, fromDate: yyyymmdd(start), toDate: yyyymmdd(end) };
    case "completecruisesolutionA":
    case "completecruisesolutionB":
    case "gohal":
      return { ...rest, sailDate: ddMonYy(start) };
    case "goccl":
    case "msc":
      // monthsAhead feeds buildMonthlyRanges(), which sweeps whole CALENDAR
      // months from the start month — so it must be the number of distinct
      // calendar months the window touches, not horizonDays/30. A late-in-month
      // start (e.g. 29 Jul + 30d) spans two calendar months but ceil(30/30)=1
      // searched only July, whose days were already in the past — which is why
      // MSC kept coming back with nothing but same-day, unbookable sailings.
      return {
        ...rest,
        startDate: start,
        monthsAhead: Math.max(
          1,
          (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1
        ),
        sailingDateFrom: mmyyyy(start),
        sailingDateTo: mmyyyy(end)
      };
    case "seawebagents":
      return { ...rest, startDate: yyyymmdd(start), horizonDays };
    case "firstmates":
      // No date param exists on this scraper's run() — drop startDate/horizonDays silently.
      return rest;
    default:
      return options;
  }
}

export function clearActiveRun(vendorKey) {
  for (const key of activeRuns) {
    if (key === vendorKey || key.startsWith(`${vendorKey}::`)) activeRuns.delete(key);
  }
}

export function getActiveRuns() {
  // Callers historically expect bare vendorKeys (e.g. dashboard "is X running"
  // checks) — de-duplicate the vendorKey portion of each scoped entry.
  return [...new Set([...activeRuns].map((key) => key.split("::")[0]))];
}

// ── Clear all cruises for a vendor (ordered to satisfy FK constraints) ────────
async function clearVendorCruises(vendorSlug) {
  const vendor = await prisma.vendor.findUnique({ where: { slug: vendorSlug } });
  if (!vendor) return 0;

  const cruises = await prisma.cruise.findMany({
    where: { vendorId: vendor.id },
    select: { id: true }
  });
  if (cruises.length === 0) return 0;

  const cruiseIds = cruises.map(c => c.id);
  const cats = await prisma.cabinCategory.findMany({
    where: { cruiseId: { in: cruiseIds } },
    select: { id: true }
  });
  const catIds = cats.map(c => c.id);

  if (catIds.length > 0) {
    await prisma.cabinPromotion.deleteMany({ where: { cabinCategoryId: { in: catIds } } });
    await prisma.cabin.deleteMany({ where: { cabinCategoryId: { in: catIds } } });
    await prisma.cabinCategory.deleteMany({ where: { id: { in: catIds } } });
  }
  await prisma.cruisePromotion.deleteMany({ where: { cruiseId: { in: cruiseIds } } });
  await prisma.itineraryStop.deleteMany({ where: { cruiseId: { in: cruiseIds } } });

  const tags = await prisma.cruiseTag.findMany({
    where: { cruiseId: { in: cruiseIds } },
    select: { id: true }
  });
  const tagIds = tags.map(t => t.id);
  if (tagIds.length > 0) {
    await prisma.cruiseTagAlert.deleteMany({ where: { cruiseTagId: { in: tagIds } } });
    await prisma.cruiseTag.deleteMany({ where: { id: { in: tagIds } } });
  }

  await prisma.cruise.deleteMany({ where: { id: { in: cruiseIds } } });
  console.log(`[clearVendorCruises] removed ${cruiseIds.length} cruises for ${vendorSlug}`);
  return cruiseIds.length;
}

function isRecoverablePrismaConnectionError(error) {
  return (
    error?.code === "P1017" ||
    error?.name === "PrismaClientInitializationError" ||
    /server has closed the connection/i.test(error?.message ?? "")
  );
}

async function reconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch {}

  await prisma.$connect();
}

// VendorRun.notes is VARCHAR(191) in the DB (Prisma's plain `String?` doesn't
// surface the real column length) — every caller here previously assumed a
// generous budget (some sliced error.message to 1900 chars) and Prisma threw
// P2000 ("value too long for column") on anything over 191. That threw INSIDE
// this retry helper's own write, at a call site with no outer try/catch in
// several places (e.g. the failure-path notes write itself) — an unhandled
// rejection that crashed the whole scraper process, not just this one update.
// Truncate defensively here so no caller can trigger this again regardless of
// what string it passes.
const VENDOR_RUN_NOTES_MAX_LENGTH = 191;

async function updateVendorRunWithRetry(id, data, maxAttempts = 3) {
  if (typeof data.notes === "string" && data.notes.length > VENDOR_RUN_NOTES_MAX_LENGTH) {
    data = { ...data, notes: data.notes.slice(0, VENDOR_RUN_NOTES_MAX_LENGTH) };
  }

  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await prisma.vendorRun.update({
        where: { id },
        data
      });
    } catch (error) {
      attempt += 1;

      if (!isRecoverablePrismaConnectionError(error) || attempt >= maxAttempts) {
        throw error;
      }

      console.warn(
        `[vendor-run] retrying update for run ${id} after dropped DB connection (attempt ${attempt}/${maxAttempts})`
      );
      await reconnectPrisma();
    }
  }
}

async function executeVendorScrape(vendorKey, options = {}) {
  const scraper = getScraperDefinition(vendorKey);

  if (!scraper) {
    const error = new Error(`Unknown scraper: ${vendorKey}`);
    error.statusCode = 404;
    throw error;
  }

  options = normalizeDateOptions(vendorKey, options);
  const scopeKey = runScopeKey(vendorKey, options);

  if (activeRuns.has(scopeKey)) {
    const error = new Error(`${vendorKey} scraper is already running for this date range.`);
    error.statusCode = 409;
    throw error;
  }

  activeRuns.add(scopeKey);

  const vendor = await ensureVendor(scraper);
  const startedAt = new Date();

  const vendorRun = await prisma.vendorRun.create({
    data: {
      vendorId: vendor.id,
      status: "running",
      startedAt,
      notes: `Triggered through API for ${vendorKey}`
    }
  });

  try {
    await updateVendorRunWithRetry(vendorRun.id, {
      notes: `Extracting ${vendorKey} sailings...`
    });
    console.log(`[vendor-run] starting ${vendorKey} extraction`);
    const result = validateScraperPayload(await scraper.run(options));
    console.log(
      `[vendor-run] ${vendorKey} extraction complete: ${result.cruises.length} cruises normalized`
    );
    await updateVendorRunWithRetry(vendorRun.id, {
      cruisesSeen: result.cruises.length,
      notes: `Extracted ${result.cruises.length} cruises. Starting ingestion...`
    });
    console.log(`[vendor-run] starting ${vendorKey} ingestion`);
    const saveResult = await ingestCruisesForVendor(vendor, result.cruises, {
      onProgress: async ({ savedCount, totalCruises }) => {
        await updateVendorRunWithRetry(vendorRun.id, {
          notes: `Ingesting cruises... ${savedCount}/${totalCruises} saved`
        });
      }
    });
    console.log(
      `[vendor-run] ${vendorKey} ingestion complete: ${saveResult.savedCount} cruises saved`
    );
    const finishedAt = new Date();
    const responseTimeMs = finishedAt.getTime() - startedAt.getTime();

    await updateVendorRunWithRetry(vendorRun.id, {
      status: "completed",
      finishedAt,
      responseTimeMs,
      cruisesSeen: result.cruises.length,
      shipsSeen: saveResult.shipsSeen,
      cabinCategoriesSeen: saveResult.cabinCategoriesSeen,
      healthScore: 100,
      notes: `Saved ${saveResult.savedCount} cruises using ${result.browserMode} mode.`
    });

    return {
      vendor: vendor.slug,
      runId: vendorRun.id,
      browserMode: result.browserMode,
      cruisesExtracted: result.cruises.length,
      cruisesSaved: saveResult.savedCount,
      startedAt,
      finishedAt
    };
  } catch (error) {
    const finishedAt = new Date();
    const responseTimeMs = finishedAt.getTime() - startedAt.getTime();

    await updateVendorRunWithRetry(vendorRun.id, {
      status: "failed",
      finishedAt,
      responseTimeMs,
      errorCount: 1,
      notes: error.message // updateVendorRunWithRetry truncates to the real 191-char column limit
    });

    throw error;
  } finally {
    activeRuns.delete(scopeKey);
  }
}

export async function runVendorScrape(vendorKey, options = {}) {
  return executeVendorScrape(vendorKey, options);
}

export async function triggerVendorScrape(vendorKey, options = {}) {
  const scraper = getScraperDefinition(vendorKey);

  if (!scraper) {
    const error = new Error(`Unknown scraper: ${vendorKey}`);
    error.statusCode = 404;
    throw error;
  }

  // Fast pre-check only — executeQueuedRun re-normalizes options and does the
  // real add/guard/delete once it actually starts. This just avoids creating
  // a doomed "queued" DB row when the exact same scope is already running.
  const scopeKey = runScopeKey(vendorKey, normalizeDateOptions(vendorKey, options));
  if (activeRuns.has(scopeKey)) {
    const error = new Error(`${vendorKey} scraper is already running for this date range.`);
    error.statusCode = 409;
    throw error;
  }

  const vendor = await ensureVendor(scraper);
  const run = await prisma.vendorRun.create({
    data: {
      vendorId: vendor.id,
      status: "queued",
      startedAt: new Date(),
      notes: `Queued through API for ${vendorKey}`
    }
  });

  executeQueuedRun(run.id, vendorKey, options).catch((error) => {
    console.error(`Background scraper failed for ${vendorKey}:`, error);
  });

  return {
    runId: run.id,
    vendor: vendor.slug,
    status: "queued"
  };
}

export async function authenticateVendor(vendorKey, options = {}) {
  const scraper = getScraperDefinition(vendorKey);

  if (!scraper) {
    const error = new Error(`Unknown scraper: ${vendorKey}`);
    error.statusCode = 404;
    throw error;
  }

  if (typeof scraper.authenticate !== "function") {
    const error = new Error(`Authentication is not available for ${vendorKey}`);
    error.statusCode = 400;
    throw error;
  }

  // Authentication touches the vendor's shared browser session/cookies, which
  // any in-flight scrape (any date scope) for this vendor is also using —
  // unlike scrape-vs-scrape, this genuinely needs to block against ALL scopes.
  const anyActiveForVendor = [...activeRuns].some((key) => key === vendorKey || key.startsWith(`${vendorKey}::`));
  if (anyActiveForVendor) {
    const error = new Error(`${vendorKey} scraper is already running.`);
    error.statusCode = 409;
    throw error;
  }

  const authScopeKey = `${vendorKey}::__auth__`;
  activeRuns.add(authScopeKey);

  try {
    return await scraper.authenticate(options);
  } finally {
    activeRuns.delete(authScopeKey);
  }
}

async function executeQueuedRun(runId, vendorKey, options = {}) {
  const run = await prisma.vendorRun.findUnique({
    where: { id: runId },
    include: { vendor: true }
  });

  if (!run) {
    return;
  }

  const scraper = getScraperDefinition(vendorKey);

  if (!scraper) {
    await updateVendorRunWithRetry(runId, {
      status: "failed",
      finishedAt: new Date(),
      errorCount: 1,
      notes: `Unknown scraper: ${vendorKey}`
    });
    return;
  }

  options = normalizeDateOptions(vendorKey, options);
  const scopeKey = runScopeKey(vendorKey, options);

  if (activeRuns.has(scopeKey)) {
    await updateVendorRunWithRetry(runId, {
      status: "failed",
      finishedAt: new Date(),
      errorCount: 1,
      notes: `${vendorKey} scraper is already running for this date range.`
    });
    return;
  }

  activeRuns.add(scopeKey);
  const startedAt = new Date();

  await updateVendorRunWithRetry(runId, {
    status: "running",
    startedAt,
    notes: `Extracting ${vendorKey} sailings...`
  });

  try {
    if (options.clearExisting) {
      await updateVendorRunWithRetry(runId, { notes: `Clearing existing ${vendorKey} data…` });
      const removed = await clearVendorCruises(vendorKey);
      await updateVendorRunWithRetry(runId, { notes: `Cleared ${removed} cruises. Starting extraction…` });
    }

    console.log(`[vendor-run] starting queued ${vendorKey} extraction`);
    const result = validateScraperPayload(await scraper.run(options));
    console.log(
      `[vendor-run] queued ${vendorKey} extraction complete: ${result.cruises.length} cruises normalized`
    );
    await updateVendorRunWithRetry(runId, {
      cruisesSeen: result.cruises.length,
      notes: `Extracted ${result.cruises.length} cruises. Starting ingestion...`
    });
    console.log(`[vendor-run] starting queued ${vendorKey} ingestion`);
    const saveResult = await ingestCruisesForVendor(run.vendor, result.cruises, {
      onProgress: async ({ savedCount, totalCruises }) => {
        await updateVendorRunWithRetry(runId, {
          notes: `Ingesting cruises... ${savedCount}/${totalCruises} saved`
        });
      }
    });
    console.log(
      `[vendor-run] queued ${vendorKey} ingestion complete: ${saveResult.savedCount} cruises saved`
    );
    const outputResult = await writeVendorOutput(vendorKey, {
      vendorKey,
      browserMode: result.browserMode,
      authentication: result.authentication ?? null,
      extractedAt: new Date().toISOString(),
      extracted: result.extracted ?? [],
      cruises: result.cruises
    });
    const finishedAt = new Date();

    // If a ship filter was requested but nothing came back, say so explicitly —
    // the free-text shipName is matched by substring against whatever the site
    // actually calls that ship, so a typo or an unlisted ship silently yields
    // zero results otherwise, with no signal beyond a scraper-side console log.
    const shipNoteSuffix = options.shipName && result.cruises.length === 0
      ? ` — no sailings matched ship filter "${options.shipName}" (check spelling, or this vendor may not operate that ship)`
      : "";

    await updateVendorRunWithRetry(runId, {
      status: "completed",
      finishedAt,
      responseTimeMs: finishedAt.getTime() - startedAt.getTime(),
      cruisesSeen: result.cruises.length,
      shipsSeen: saveResult.shipsSeen,
      cabinCategoriesSeen: saveResult.cabinCategoriesSeen,
      healthScore: 100,
      notes: `Saved ${saveResult.savedCount} cruises using ${result.browserMode} mode. JSON: ${outputResult.filename}${shipNoteSuffix}`
    });
  } catch (error) {
    const finishedAt = new Date();

    await updateVendorRunWithRetry(runId, {
      status: "failed",
      finishedAt,
      responseTimeMs: finishedAt.getTime() - startedAt.getTime(),
      errorCount: 1,
      notes: error.message // updateVendorRunWithRetry truncates to the real 191-char column limit
    });
  } finally {
    activeRuns.delete(scopeKey);
  }
}

export async function getVendorRun(runId) {
  return prisma.vendorRun.findUnique({
    where: { id: runId },
    include: {
      vendor: {
        select: {
          id: true,
          name: true,
          slug: true,
          url: true
        }
      }
    }
  });
}
