import { scraperRegistry } from "../scrapers/registry.js";
import prisma from "../config/prisma.js";

// Runs each vendor's authenticate() with a short timeout and reports pass/fail
const AUTH_TIMEOUT_MS = 30_000;

async function checkOneVendor(key, scraper) {
  if (typeof scraper.authenticate !== "function") {
    return { key, name: scraper.name, status: "skipped", reason: "No authenticate() defined" };
  }

  const start = Date.now();
  try {
    await Promise.race([
      scraper.authenticate({}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Auth timed out")), AUTH_TIMEOUT_MS)
      )
    ]);
    return { key, name: scraper.name, status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { key, name: scraper.name, status: "error", error: err.message, latencyMs: Date.now() - start };
  }
}

// GET /api/auth/check — check all vendors in parallel
export async function authCheckAllController() {
  const entries = Object.values(scraperRegistry);
  const results = await Promise.allSettled(entries.map(s => checkOneVendor(s.key, s)));

  const checks = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { key: entries[i].key, name: entries[i].name, status: "error", error: r.reason?.message ?? "Unknown" }
  );

  const allOk = checks.every(c => c.status === "ok" || c.status === "skipped");

  return {
    statusCode: 200,
    body: { ok: allOk, checkedAt: new Date().toISOString(), vendors: checks }
  };
}

// GET /api/auth/check/:vendorKey — check single vendor
export async function authCheckVendorController({ params }) {
  const scraper = scraperRegistry[params.vendorKey];
  if (!scraper) {
    return { statusCode: 404, body: { ok: false, error: `Unknown vendor: ${params.vendorKey}` } };
  }

  const result = await checkOneVendor(params.vendorKey, scraper);
  return { statusCode: result.status === "ok" ? 200 : 502, body: { ok: result.status === "ok", ...result } };
}

// GET /api/vendors/last-runs — latest vendorRun per vendor for the ops console
export async function vendorLastRunsController() {
  const vendors = await prisma.vendor.findMany({
    include: {
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true, status: true, startedAt: true, finishedAt: true, cruisesSeen: true, notes: true }
      }
    }
  });

  const data = vendors.map(v => ({
    key:        v.slug,
    name:       v.name,
    lastRun:    v.runs[0] ?? null
  }));

  return { statusCode: 200, body: { ok: true, vendors: data } };
}
