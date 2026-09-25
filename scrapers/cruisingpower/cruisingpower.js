import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { createScraperSession } from "../runtime.js";
import { ingestCruise } from "../../services/cruiseIngestionService.js";
import prisma from "../../config/prisma.js";

dotenv.config();

const USERNAME  = process.env.CRUISINGPOWER_USER;
const PASSWORD  = process.env.CRUISINGPOWER_PASS;
const LOGIN_URL = "https://secure.cruisingpower.com/login";
const BASE_URL  = "https://secure.cruisingpower.com";

// ── Debug helpers ────────────────────────────────────────────────────────────

async function saveDebugSnapshot(page, label) {
  const outputDir = path.resolve("output");
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `cruisingpower-${label}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

// ── Normalization helpers ────────────────────────────────────────────────────

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function addDays(isoStr, days) {
  if (!isoStr || !days) return null;
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString();
}

function toTitleCase(str) {
  return String(str ?? "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Response shape normalizers ───────────────────────────────────────────────
// CruisingPower /api/filters/voyages returns:
//   data.index  – lookup tables: ships, brands, destinations, portsOfCalls
//   data.voyages – array of filter-catalog items (codes only, no pricing)

/**
 * Build a code→name lookup map from an index array like
 *   [{ code: "EN", name: "ENCHANTMENT OF THE SEAS", ... }, ...]
 */
function buildLookup(arr = []) {
  const map = new Map();
  for (const item of arr) {
    if (item?.code) map.set(item.code, item);
  }
  return map;
}

/**
 * Extract the voyages array and index lookups from the raw API response.
 * Returns { voyages, shipMap, brandMap, destinationMap, portMap }
 */
function extractVoyageArray(raw) {
  const index    = raw?.data?.index ?? {};
  const voyages  = raw?.data?.voyages ?? [];

  return {
    voyages,
    shipMap:        buildLookup(index.ships        ?? []),
    brandMap:       buildLookup(index.brands       ?? []),
    destinationMap: buildLookup(index.destinations ?? []),
    portMap:        buildLookup(index.portsOfCalls ?? [])
  };
}

/**
 * Build a stable, unique cruise code from voyage fields.
 * Format: CP{brand}{ship}{YYYYMMDD}{departurePort}
 * e.g.  "CPREN20260416TPA"
 */
function buildCruiseCode(voyage) {
  const dateCompact = (voyage.date ?? "").replace(/\//g, "");
  return `CP${voyage.brand ?? ""}${voyage.ship ?? ""}${dateCompact}${voyage.departurePort ?? ""}`;
}

// ── /api/promotions response normalization ──────────────────────────────────
// /api/promotions returns each sailing with an embedded cabinClassPricing[]
// array — one entry per cabin class (INSIDE / OUTSIDE / BALCONY / SUITE) with
// the cheapest category code + price + best applicable promo. We fold these
// into our standard cabinCategory rows.

function mapCabinClassToGroup(cabinClass) {
  const c = String(cabinClass ?? "").toUpperCase();
  if (c.includes("SUITE") || c.includes("DELUXE")) return "Suite";
  if (c.includes("BALCONY")) return "Balcony";
  if (c.includes("OUTSIDE") || c.includes("OCEAN")) return "Exterior";
  if (c.includes("INSIDE") || c.includes("INTERIOR")) return "Interior";
  return null;
}

function buildCabinCategoriesFromPromotions(promotion) {
  const out = [];
  for (const cc of promotion?.cabinClassPricing ?? []) {
    const group = mapCabinClassToGroup(cc.cabinClass);
    for (const p of cc.price ?? []) {
      const promo = p.promotion ?? {};
      const promoLabels = [
        promo.id,
        promo.description,
        ...(p.combinableWith ?? []).map((cw) => cw.description).filter(Boolean)
      ].filter(Boolean);
      const orig = p.averageGuestPrice?.originalAmount ?? null;
      const net  = p.averageGuestPrice?.netAmount ?? null;
      const code = p.category ?? p.cabinType ?? null;
      if (!code) continue;

      out.push({
        code,
        name: `${cc.cabinClass} ${p.description ?? ""}`.trim(),
        group,
        status: "Available",
        avlResult: "OK",
        total: 1,
        avail: 1,
        cabinPrice: net ?? orig,
        perPersonPrice: net ?? orig,
        capacity: null,
        trend: null,
        confidence: net != null ? "High" : "Low",
        promos: unique(promoLabels)
      });
    }
  }
  return out;
}

function buildPromoCruiseId(promotion, voyage = null) {
  // sailingRef.package + saildate gives us a stable, unique key
  const pkg  = promotion?.sailingRef?.package ?? voyage?.package ?? "";
  const date = (promotion?.sailingRef?.saildate ?? promotion?.startDate ?? "").replace(/-/g, "");
  return `CP${pkg}${date}` || null;
}

// packageCode's first two letters = ship code (confirmed via AirWaves
// criteria/cruise/ship API: AX=Celebrity Apex, AT=Celebrity Ascent, ...).
// Used as ship-name fallback when the wizard page has no usable heading, and
// as the only ship signal available at the bulk /api/promotions list stage.
const CP_SHIP_NAMES = {
  // Celebrity
  AP: "Celebrity Apex", AX: "Celebrity Apex", AT: "Celebrity Ascent", BY: "Celebrity Beyond",
  CS: "Celebrity Constellation", EC: "Celebrity Eclipse", EG: "Celebrity Edge",
  EQ: "Celebrity Equinox", IF: "Celebrity Infinity", ML: "Celebrity Millennium",
  RF: "Celebrity Reflection", SL: "Celebrity Silhouette", SM: "Celebrity Summit",
  SO: "Celebrity Solstice", XP: "Celebrity Xpedition",
  // Royal Caribbean
  AL: "Allure of the Seas", AD: "Adventure of the Seas", AN: "Anthem of the Seas",
  BR: "Brilliance of the Seas", EN: "Enchantment of the Seas", EX: "Explorer of the Seas",
  FL: "Freedom of the Seas", GR: "Grandeur of the Seas", HM: "Harmony of the Seas",
  IC: "Icon of the Seas", ID: "Independence of the Seas", JW: "Jewel of the Seas",
  LB: "Liberty of the Seas", LE: "Legend of the Seas", MA: "Mariner of the Seas",
  NV: "Navigator of the Seas", OA: "Oasis of the Seas", OV: "Ovation of the Seas",
  OD: "Odyssey of the Seas", QN: "Quantum of the Seas", RD: "Radiance of the Seas",
  RH: "Rhapsody of the Seas", SR: "Serenade of the Seas", SP: "Spectrum of the Seas",
  ST: "Star of the Seas", SY: "Symphony of the Seas", UT: "Utopia of the Seas",
  VY: "Voyager of the Seas", VI: "Vision of the Seas", WN: "Wonder of the Seas",
};

function unique(values = []) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeCruisingPowerVoyage(voyage, { shipMap, brandMap, destinationMap, portMap }) {
  const id = buildCruiseCode(voyage);
  if (!id || id === "CP") return null;

  const shipEntry  = shipMap.get(voyage.ship ?? "");
  const brandEntry = brandMap.get(voyage.brand ?? "");
  const destEntry  = destinationMap.get(voyage.destination ?? "");
  const portEntry  = portMap.get(voyage.departurePort ?? "");

  const shipCode = voyage.ship ?? null;
  const shipName = shipEntry?.name ? toTitleCase(shipEntry.name) : shipCode;

  const nights    = normalizeInteger(voyage.duration ?? null);
  const startDate = normalizeDate((voyage.date ?? "").replace(/\//g, "-") || null);
  const endDate   = addDays(startDate, nights);

  const portFromCode = voyage.departurePort ?? null;
  const portFromName = portEntry?.name ?? portFromCode;

  // Last port of call is the debarkation port (same as embark for round-trips)
  const portsArr     = voyage.portsOfCall ?? [];
  const lastPortCode = portsArr[portsArr.length - 1] ?? portFromCode;
  const lastPortName = portMap.get(lastPortCode)?.name ?? lastPortCode;

  const destinationName = destEntry?.name ?? voyage.destination ?? null;
  const brandName       = brandEntry?.name ?? voyage.brand ?? null;
  const cruiseType      = voyage.voyageType === "V" ? "River" : "Ocean";

  const routeLabel = portFromName && lastPortName
    ? `${portFromName} -> ${lastPortName}`
    : destinationName ?? null;

  return {
    id,
    ship:        shipName,
    shipCode,
    shipDetails: shipEntry ? {
      name:   shipName,
      guests: null,
      cabins: null
    } : null,
    package:     `${brandName ?? ""} ${cruiseType} Cruise`.trim(),
    cruiseLine:  brandName,
    portFrom:    portFromCode,
    portTo:      lastPortCode,
    routeLabel,
    nights,
    startDate,
    endDate,
    seatsAvailable:  null,
    totalCapacity:   null,
    totalCabins:     null,
    trend:           null,
    confidence:      "Low",
    pinned:          false,
    currency:        "GBP",   // portal is GBR agency; pricing endpoint would confirm
    promotions:      [],
    cabinCategories: [],      // pricing not available from this endpoint
    rawPayload:      voyage
  };
}

// ── /api/promotions search call ─────────────────────────────────────────────

const BRAND_CODE_TO_NAME = {
  C: "Celebrity Cruises",
  R: "Royal Caribbean",
  S: "Silversea",
  Z: "Azamara"
};

function generateUuid() {
  return Math.random().toString(36).slice(2, 14).toUpperCase();
}

async function fetchPromotionsViaPage(page, token, options = {}) {
  const {
    fromDate = "2026-04-26",
    toDate   = "2026-12-31",
    brand    = "C",          // "C" = Celebrity, "R" = Royal Caribbean, etc.
    office   = "LON",
    country  = "GBR",
    currency = "GBP"
  } = options;

  const body = {
    header: {
      application: "espresso_cruisingpower.com",
      language:    "US",
      uuid:        generateUuid()
    },
    criteria: {
      office, country, currency,
      channel:     "ES",
      bookingType: "FIT",
      cruiseType:  { value: ["CO"] },
      brand:       { value: [brand] },
      sailingDate: { dateRange: { from: fromDate, to: toDate } }
    }
  };

  // The site sets a __Host-x-csrf-token cookie (HttpOnly, so document.cookie
  // can't read it from inside page.evaluate) that the server checks against
  // an x-csrf-token request header — omitting it was causing every
  // /api/promotions call to fail with 403 "Invalid CSRF token". Read it
  // Node-side via the browser context's cookie jar and forward it explicitly.
  const cookies = await page.context().cookies();
  const csrfToken = cookies.find((c) => c.name === "__Host-x-csrf-token")?.value ?? "";

  const result = await page.evaluate(async ({ url, body, token, csrfToken }) => {
    const r = await fetch(url, {
      method:      "POST",
      credentials: "include",
      headers: {
        "Content-Type":  "application/json",
        Accept:          "application/json",
        Authorization:   `Bearer ${token}`,
        "x-csrf-token":  csrfToken
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`Promotions API HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    return r.json();
  }, { url: `${BASE_URL}/api/promotions`, body, token, csrfToken });

  return result;
}

// ── /api/filters/voyages — itinerary source ──────────────────────────────────
// /api/promotions has pricing but no itinerary at all, which is why
// normalizePromotionEntry leaves portFrom/portTo/routeLabel/nights null. This
// catalogue endpoint is the missing half: every row carries duration and the
// full portsOfCall list (verified 4727/4727 on both), plus an index that maps
// port codes to names. It only answers GET — POST returns 404.
//
// There's no package code to join on, so sailings are matched by ship + sail
// date: a given ship departs at most once on a given day.
async function fetchVoyagesViaPage(page, token) {
  const cookies = await page.context().cookies();
  const csrfToken = cookies.find((c) => c.name === "__Host-x-csrf-token")?.value ?? "";

  // ~900KB of JSON — parse inside the page and hand back only what we index on,
  // rather than serialising the whole payload across the boundary.
  return page.evaluate(async ({ url, token, csrfToken }) => {
    const r = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "x-csrf-token": csrfToken
      }
    });
    if (!r.ok) throw new Error(`Voyages API HTTP ${r.status}`);
    const j = JSON.parse(await r.text());
    return {
      voyages: (j?.data?.voyages ?? []).map((v) => ({
        ship: v.ship, date: v.date, duration: v.duration,
        departurePort: v.departurePort, portsOfCall: v.portsOfCall ?? [],
        destination: v.destination
      })),
      ports: (j?.data?.index?.portsOfCalls ?? []).map((p) => ({ code: p.code, name: p.name }))
    };
  }, { url: `${BASE_URL}/api/filters/voyages`, token, csrfToken });
}

function buildVoyageIndex(raw) {
  const portMap = new Map((raw?.ports ?? []).map((p) => [p.code, p.name]));
  const byShipDate = new Map();
  for (const v of raw?.voyages ?? []) {
    if (!v.ship || !v.date) continue;
    byShipDate.set(`${v.ship}|${String(v.date).replace(/\//g, "-")}`, v);
  }
  return { byShipDate, portMap };
}

/**
 * Fill in the fields /api/promotions can't supply. Mutates in place and returns
 * how many sailings were matched, so the caller can log coverage.
 */
function enrichCruisesFromVoyages(cruises, index) {
  if (!index) return 0;
  let matched = 0;

  for (const cruise of cruises) {
    if (!cruise.shipCode || !cruise.startDate) continue;

    const iso = new Date(cruise.startDate).toISOString().slice(0, 10);
    const voyage = index.byShipDate.get(`${cruise.shipCode}|${iso}`);
    if (!voyage) continue;
    matched++;

    const portName = (code) => index.portMap.get(code) ?? code ?? null;

    if (cruise.nights == null && voyage.duration != null) {
      cruise.nights = normalizeInteger(voyage.duration);
      if (!cruise.endDate) cruise.endDate = addDays(cruise.startDate, cruise.nights);
    }

    const ports = voyage.portsOfCall ?? [];
    const fromCode = voyage.departurePort ?? ports[0] ?? null;
    // Round-trips end where they started, so the last call is the debark port.
    const toCode = ports[ports.length - 1] ?? fromCode;

    if (!cruise.portFrom && fromCode) cruise.portFrom = portName(fromCode);
    if (!cruise.portTo && toCode) cruise.portTo = portName(toCode);
    if (!cruise.routeLabel && fromCode) {
      cruise.routeLabel = `${portName(fromCode)} -> ${portName(toCode)}`;
    }

    if ((cruise.itineraryStops ?? []).length === 0 && ports.length > 0) {
      cruise.itineraryStops = ports.map((code, i) => ({
        day: null, date: null, time: null, activity: null,
        port: portName(code), country: null, order: i
      }));
    }
  }

  return matched;
}

function normalizePromotionEntry(promotion, lookups, brandCode) {
  const sailingRef = promotion?.sailingRef ?? {};
  const id = buildPromoCruiseId(promotion);
  if (!id) return null;

  const startDate = normalizeDate(sailingRef.saildate ?? promotion.startDate);
  const cabinCategories = buildCabinCategoriesFromPromotions(promotion);

  // packageCode's first two letters resolve to a ship via CP_SHIP_NAMES
  // (confirmed against AirWaves' criteria/cruise/ship API) — this is the only
  // ship signal available at the bulk-list stage, since the promotions API
  // itself never returns a ship name/code per entry.
  const pkgPrefix = (sailingRef.package ?? "").slice(0, 2).toUpperCase();
  const shipName  = CP_SHIP_NAMES[pkgPrefix] ?? null;

  return {
    id,
    ship:        shipName,
    shipCode:    pkgPrefix || null,
    shipDetails: null,
    package:     `${BRAND_CODE_TO_NAME[brandCode] ?? brandCode ?? ""} Cruise`.trim(),
    portFrom:    null,
    portTo:      null,
    routeLabel:  null,
    nights:      null,
    startDate,
    endDate:     null,
    seatsAvailable: null,
    totalCapacity: null,
    totalCabins:   null,
    trend:         null,
    confidence:    cabinCategories.length > 0 ? "Medium" : "Low",
    pinned:        false,
    currency:      "GBP",
    promotions:    unique(cabinCategories.flatMap((c) => c.promos ?? [])),
    cabinCategories,
    rawPayload:    promotion
  };
}

// ── Authentication ───────────────────────────────────────────────────────────

// "Not the login page" is not enough: with an expired session the OAuth chain hops
// through the identity provider (auth.cruisingpower.com/.../connect/endSession?...)
// on its way back to /login, and that URL passed the old "no /login in it" test —
// so the session was reported restored, no login was ever performed, and the run
// died later with "Could not capture bearer token" (run 483). Only the app host
// counts as the dashboard.
function isDashboardUrl(url) {
  let u;
  try { u = new URL(url.toString()); } catch { return false; }
  if (!u.hostname.endsWith("cruisingpower.com") || u.hostname === "auth.cruisingpower.com") return false;
  return !u.pathname.includes("/login") && !u.pathname.includes("/oauth/callback") && !u.pathname.includes("/connect/");
}

async function waitForDashboard(page) {
  await page.waitForURL(isDashboardUrl, { timeout: 90000 });
  console.log("[cruisingpower] redirected to dashboard:", page.url());
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => null);
}

async function ensureCruisingPowerAuthentication(session) {
  const { page } = session;

  if (!USERNAME || !PASSWORD) {
    throw new Error(
      "CRUISINGPOWER_USER and CRUISINGPOWER_PASS must be set in .env before using the CruisingPower scraper."
    );
  }

  console.log("[cruisingpower] opening login page");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Race: wait for dashboard (OAuth completing) vs login form ready (no OAuth in flight).
  // The page may have saved cookies that trigger an OAuth redirect — that can take
  // 30-90 seconds. Wait up to 90s for whichever arrives first.
  const loginButton   = page.locator('[data-qa="ushome.button.login"]');
  const usernameInput = page.locator('input[placeholder="Username/Email"]');

  const reached = await Promise.race([
    page.waitForURL(isDashboardUrl, { timeout: 90000 }).then(() => "dashboard"),
    // Form is ready when the Sign In button exists AND is NOT in loading state
    page.waitForFunction(() => {
      const btn = document.querySelector('[data-qa="ushome.button.login"]');
      return btn && btn.getAttribute("data-loading") !== "true";
    }, null, { timeout: 90000 }).then(() => "form"),
  ]).catch(() => "timeout");

  console.log(`[cruisingpower] login page resolved: ${reached}, url: ${page.url()}`);

  if (reached === "dashboard" || isDashboardUrl(page.url())) {
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
    console.log("[cruisingpower] session restored (OAuth redirect completed)");
    await session.persistAuthState();
    return {
      success: true,
      alreadyLoggedIn: true,
      message: "CruisingPower session reused successfully."
    };
  }

  if (reached === "timeout") {
    // The SPA sometimes hangs (on /oauth/callback with cookies already set, or
    // on /login without rendering the form). Nudge to /home — if the session is
    // actually live we land on the dashboard.
    console.log(`[cruisingpower] login resolution timed out at ${page.url().split("?")[0]} — nudging to /home`);
    await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(3000);
    if (isDashboardUrl(page.url()) && !page.url().includes("/login")) {
      console.log("[cruisingpower] recovered — session active after nudge");
      await session.persistAuthState();
      return { success: true, alreadyLoggedIn: true, message: "CruisingPower session recovered after login-page hang." };
    }

    // Landed back on /login — give the form one more chance to render
    const formReady = await page.waitForFunction(() => {
      const btn = document.querySelector('[data-qa="ushome.button.login"]');
      return btn && btn.getAttribute("data-loading") !== "true";
    }, null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (!formReady) {
      throw new Error("CruisingPower login page timed out waiting for form or OAuth redirect.");
    }
    console.log("[cruisingpower] login form ready after retry");
  }

  // Form is ready — fill credentials. A saved-cookie OAuth redirect can still
  // fire mid-fill (input flips readonly, page navigates to oauth/callback):
  // if the fill fails, check whether we auto-landed on the dashboard instead.
  try {
    await usernameInput.fill(USERNAME);
    await page.locator('input[placeholder="Password"]').fill(PASSWORD);
  } catch (fillErr) {
    console.log("[cruisingpower] fill interrupted — checking for OAuth auto-login");
    const landed = await page.waitForURL(isDashboardUrl, { timeout: 30000 }).then(() => true).catch(() => false);
    if (landed || isDashboardUrl(page.url())) {
      console.log("[cruisingpower] OAuth auto-login completed during fill");
      await session.persistAuthState();
      return { success: true, alreadyLoggedIn: true, message: "CruisingPower session reused (auto-login mid-fill)." };
    }
    throw fillErr;
  }
  console.log("[cruisingpower] credentials filled");

  await loginButton.waitFor({ state: "visible", timeout: 15000 });
  await loginButton.click();
  console.log("[cruisingpower] login submitted, waiting for OAuth redirect");

  await waitForDashboard(page);

  console.log("[cruisingpower] login successful, current url:", page.url());
  await session.persistAuthState();

  return {
    success: true,
    alreadyLoggedIn: false,
    message: "CruisingPower login successful."
  };
}

// ── Main scraper ─────────────────────────────────────────────────────────────

export async function authenticateCruisingPower() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/cruisingpower-user-data",
    storageStatePath: "./sessions/.auth/cruisingpower-storage.json",
    headless:         false,
    slowMo:           80
  });

  try {
    const authResult = await ensureCruisingPowerAuthentication(session);
    return {
      vendorKey:   "cruisingpower",
      browserMode: session.mode,
      ...authResult
    };
  } catch (error) {
    error.message = `CruisingPower authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

/**
 * Capture the bearer token by intercepting the first authenticated API request
 * that the app fires naturally after reaching the home/dashboard page.
 */
function captureTokenFromRequests(page) {
  return new Promise((resolve) => {
    const handler = (request) => {
      const auth = request.headers()["authorization"] ?? "";
      if (auth.startsWith("Bearer ") && request.url().includes("cruisingpower.com/api")) {
        page.off("request", handler);
        resolve(auth.slice("Bearer ".length));
      }
    };
    page.on("request", handler);
  });
}

export async function runCruisingPowerScraper(options = {}) {
  const {
    fromDate = "2026-04-26",
    toDate   = "2026-12-31",
    brand    = "C",  // "C" = Celebrity, "R" = Royal Caribbean
    withDecks = true,        // loop each sailing through the espresso wizard for cabin numbers
    maxDeckCruises = Infinity,
    shipName = null,  // optional, e.g. "Apex" — /api/promotions has no ship param, so the bulk list-fetch still covers the full date range, but the expensive per-cruise deck pass narrows to just this ship (resolved from each packageCode's ship-code prefix)
  } = options;

  const session = await createScraperSession({
    userDataDir:      "./sessions/cruisingpower-user-data",
    storageStatePath: "./sessions/.auth/cruisingpower-storage.json",
    headless:         false,
    slowMo:           0
  });

  const { page } = session;

  try {
    const authResult = await ensureCruisingPowerAuthentication(session);

    // Navigate to home so the SPA triggers an authenticated API call (gives us a bearer token)
    console.log("[cruisingpower] navigating to home to capture bearer token");
    const tokenCapture = captureTokenFromRequests(page);
    await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded" });

    const bearerToken = await Promise.race([
      tokenCapture,
      new Promise(r => setTimeout(() => r(null), 30000))
    ]);
    if (!bearerToken) throw new Error("Could not capture bearer token");
    console.log("[cruisingpower] bearer token captured");

    // /api/promotions caps its result set server-side (a 365-day window returns
    // the same ~64 rows / 10 sailings as a 120-day one), so a single call can't
    // cover a long horizon no matter how wide the range. Walk the range in
    // month-sized slices and merge, which keeps each request under the cap.
    const promoChunks = [];
    {
      const start = new Date(fromDate);
      const end = new Date(toDate);
      const cursor = new Date(start);
      while (cursor < end) {
        const chunkTo = new Date(cursor);
        chunkTo.setMonth(chunkTo.getMonth() + 1);
        promoChunks.push({
          from: cursor.toISOString().slice(0, 10),
          to: (chunkTo < end ? chunkTo : end).toISOString().slice(0, 10)
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }
      if (promoChunks.length === 0) promoChunks.push({ from: fromDate, to: toDate });
    }

    console.log(`[cruisingpower] fetching /api/promotions (brand=${brand}, ${fromDate} to ${toDate}) in ${promoChunks.length} slice(s)`);

    const promotionsArr = [];
    for (const chunk of promoChunks) {
      try {
        const raw = await fetchPromotionsViaPage(page, bearerToken, {
          fromDate: chunk.from, toDate: chunk.to, brand
        });
        const rows = raw?.data?.promotions ?? [];
        promotionsArr.push(...rows);
        console.log(`[cruisingpower]   ${chunk.from} → ${chunk.to}: ${rows.length} promo rows`);
      } catch (err) {
        // One bad slice shouldn't cost the whole horizon.
        console.log(`[cruisingpower]   ${chunk.from} → ${chunk.to}: failed (${err.message.split("\n")[0]})`);
      }
    }
    console.log(`[cruisingpower] /api/promotions returned ${promotionsArr.length} rows across ${promoChunks.length} slice(s)`);

    const rawCruises = promotionsArr
      .map((p) => normalizePromotionEntry(p, {}, brand))
      .filter((c) => c?.id);

    // The promotions API returns one entry PER PROMO, not per sailing — the
    // same packageKey (cruise.id) repeats once per applicable offer. Merge
    // duplicates so the deck-fetch loop below processes each sailing once
    // instead of re-driving the whole espresso wizard N times for nothing.
    const byId = new Map();
    for (const c of rawCruises) {
      const existing = byId.get(c.id);
      if (!existing) { byId.set(c.id, c); continue; }
      const seenCodes = new Set(existing.cabinCategories.map((cc) => cc.code));
      for (const cc of c.cabinCategories) if (!seenCodes.has(cc.code)) existing.cabinCategories.push(cc);
      existing.promotions = unique([...(existing.promotions ?? []), ...(c.promotions ?? [])]);
    }
    const cruises = [...byId.values()];
    console.log(`[cruisingpower] normalized ${rawCruises.length} promo entries → ${cruises.length} unique sailings`);

    // Fill in itinerary/duration, which /api/promotions never returns. One
    // catalogue fetch covers every sailing; a failure here only costs those
    // fields, so it must not abort the run.
    try {
      const voyageIndex = buildVoyageIndex(await fetchVoyagesViaPage(page, bearerToken));
      const matched = enrichCruisesFromVoyages(cruises, voyageIndex);
      console.log(`[cruisingpower] voyage catalogue: ${voyageIndex.byShipDate.size} sailings indexed → enriched ${matched}/${cruises.length}`);
    } catch (err) {
      console.log(`[cruisingpower] voyage catalogue unavailable (${err.message.split("\n")[0]}) — route/nights/stops left empty`);
    }

    // ── Deck-data pass ──────────────────────────────────────────────────────
    // Promotions API has no cabin numbers. Close the bulk session (frees the
    // browser profile), then loop each sailing through the espresso wizard via
    // fetchCruisingPowerCategoryDecks (shared cached session, one login).
    if (withDecks && cruises.length > 0) {
      let deckList = cruises;
      if (shipName) {
        const shipFilter = shipName.trim().toUpperCase();
        deckList = cruises.filter((c) => c.ship?.toUpperCase().includes(shipFilter));
        console.log(`[cp-decks] shipName="${shipName}" — ${deckList.length}/${cruises.length} cruises match`);
      }

      // Sailings that already have cabin rows go LAST, so a capped pass reaches the
      // gaps instead of re-fetching the same covered ones every time (same fix as
      // goccl/celestyal/azamara/msc). Only a plain vendor lookup here — ensureVendor
      // would overwrite the vendor's name/url on every call.
      let cpVendorId = null;
      try {
        const vendorRow = await prisma.vendor.findFirst({ where: { slug: "cruisingpower" }, select: { id: true } });
        cpVendorId = vendorRow?.id ?? null;
        if (cpVendorId) {
          const have = new Set((await prisma.cruise.findMany({
            where: { vendorId: cpVendorId, cabinCategories: { some: { cabins: { some: {} } } } },
            select: { code: true }
          })).map((c) => c.code));
          deckList = [...deckList].sort((a, b) => (have.has(a.id) ? 1 : 0) - (have.has(b.id) ? 1 : 0));
          console.log(`[cp-decks] ${deckList.filter((c) => !have.has(c.id)).length}/${deckList.length} sailings lack cabin data — those go first`);
        }
      } catch (err) {
        console.log(`[cp-decks] ordering-by-DB-state failed (${err.message}) — falling back to list order`);
      }

      await session.close().catch(() => {});
      let done = 0, ok = 0;
      for (const cruise of deckList) {
        if (done >= maxDeckCruises) break;
        done++;
        // cruise.id format: CP{packageCode}{YYYYMMDD}
        const noPrefix = String(cruise.id).replace(/^CP/, "");
        if (noPrefix.length <= 8) continue;
        const packageKey = buildCruisingPowerPackageKey(noPrefix.slice(0, -8), noPrefix.slice(-8));
        try {
          console.log(`[cp-decks] (${done}/${Math.min(deckList.length, maxDeckCruises)}) ${packageKey}`);
          const result = await fetchCruisingPowerCategoryDecks({ packageKey });
          if (result?.ship && !cruise.ship) cruise.ship = result.ship;
          // normalizePromotionEntry leaves nights/endDate null (the promotions
          // API has no itinerary) — the wizard page is the only source.
          if (result?.nights != null && cruise.nights == null) {
            cruise.nights = result.nights;
            if (cruise.startDate && !cruise.endDate) {
              cruise.endDate = new Date(new Date(cruise.startDate).getTime() + result.nights * 86400000);
            }
          }
          const byCode = new Map((cruise.cabinCategories ?? []).map((c) => [c.code, c]));
          for (const cat of result?.categories ?? []) {
            const cabins = (cat.decks ?? []).flatMap((d) => (d.cabins ?? []).map((c) => ({
              cabinNumber: String(c.number),
              deckNumber:  d.deckNumber ?? null,
              deckName:    d.deckName ?? null,
              capacity:    c.maxOccupancy ?? null,
              status:      c.status ?? null,
            })));
            // cat.count comes from scraping a `.available.count` cell on the
            // categories page — empty/absent for "Prime"/IGT-tier categories
            // (confirmed live: "Prime Concierge Class", "Prime Edge Strm w/
            // Infinite Ver"), which parses to 0 even when the category has real
            // inventory. The stateroom fetch that produced `cabins` is a direct
            // API call, not DOM scraping, so once we've actually enumerated
            // cabins that count is ground truth and wins over the scraped one.
            const realAvail = cabins.length > 0 ? cabins.length : (cat.count ?? 0);
            const existing = byCode.get(cat.code);
            if (existing) {
              existing.cabins = cabins;
              if (cabins.length > 0) {
                existing.confidence = "High";
                // buildCabinCategoriesFromPromotions hardcodes avail:1 for
                // every promo-derived category — don't let that stale summary
                // number understate a category we've now verified has more.
                if (!(existing.avail > realAvail)) existing.avail = realAvail;
              }
            } else {
              cruise.cabinCategories.push({
                code: cat.code, name: cat.name ?? cat.code, group: null,
                status: cat.status === "WLT" ? "Waitlist" : "Available",
                avlResult: cat.status !== "WLT" ? "OK" : null,
                avail: realAvail,
                cabinPrice: cat.price ? Number(String(cat.price).replace(/[^0-9.]/g, "")) || null : null,
                perPersonPrice: null,
                confidence: cabins.length > 0 ? "High" : "Low",
                promos: [], cabins,
              });
            }
          }
          ok++;
          // Save this sailing right now rather than only when the whole pass ends:
          // a CP deck pass is ~5-10 min per sailing and a run once hung for 3.5 h,
          // and everything it had fetched was lost because nothing was written
          // until the very end (same fix already made in goccl.js and azamara.js).
          if (cpVendorId && (cruise.cabinCategories ?? []).some((c) => (c.cabins ?? []).length > 0)) {
            try {
              await ingestCruise(cpVendorId, cruise);
              console.log(`[cp-decks] ${packageKey} saved to DB`);
            } catch (saveErr) {
              console.error(`[cp-decks] ${packageKey} save failed: ${saveErr.message}`);
            }
          }
        } catch (err) {
          console.log(`[cp-decks] ${packageKey} failed: ${err.message.split("\n")[0]}`);
        }
      }
      console.log(`[cp-decks] deck pass complete: ${ok}/${done} sailings got cabin data`);
    }

    return {
      vendorKey:      "cruisingpower",
      source:         "cruisingpower",
      browserMode:    session.mode,
      authentication: authResult,
      extracted:      promotionsArr,
      cruises
    };
  } catch (error) {
    try {
      const screenshotPath = await saveDebugSnapshot(page, "failure");
      console.error("[cruisingpower] debug screenshot saved:", screenshotPath);
      console.error("[cruisingpower] current url:", page.url());
    } catch (snapshotError) {
      console.error("[cruisingpower] failed to save debug screenshot:", snapshotError.message);
    }

    error.message = `CruisingPower scraper failed: ${error.message}`;
    throw error;
  } finally {
    // deck pass may have closed it already — double-close is a no-op failure
    await session.close().catch(() => {});
  }
}

// ── Single-voyage deck/cabin detail fetch ───────────────────────────────────
// The bulk /api/promotions endpoint only returns cheapest-per-class pricing.
// Actual stateroom numbers + deck assignments live behind the classic Espresso
// booking wizard (Search -> Categories -> Staterooms), a Spring WebFlow app
// where each step is a real .do GET/POST (execution=e1sN&_eventId=...), not a
// SPA route. We drive that wizard in the real browser and capture the JSON
// responses fired along the way instead of scraping rendered HTML.

// Kept open across requests — Chromium drops session-only cookies on browser
// close even with a persistent profile dir, so closing after every refresh
// forces a fresh login every time. Reusing one long-lived session avoids that.
let cachedCruisingPowerSession = null;
let cruisingPowerQueue = Promise.resolve();

async function getOrCreateCruisingPowerSession() {
  if (cachedCruisingPowerSession) {
    const alive = await cachedCruisingPowerSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedCruisingPowerSession;
    await cachedCruisingPowerSession.close().catch(() => {});
    cachedCruisingPowerSession = null;
  }
  cachedCruisingPowerSession = await createScraperSession({
    userDataDir:      "./sessions/cruisingpower-user-data",
    storageStatePath: "./sessions/.auth/cruisingpower-storage.json",
    headless:         false,
    slowMo:           0
  });
  return cachedCruisingPowerSession;
}

function runExclusiveCruisingPower(fn) {
  const result = cruisingPowerQueue.then(fn);
  cruisingPowerQueue = result.catch(() => {});
  return result;
}

/**
 * packageKey is the value the site itself uses to identify a sailing, e.g.
 * "CS10M385_1260619". It's deterministic: packageCode + "_1" + the last 6
 * digits of sailDateYYYYMMDD. Both packageCode and sailDateYYYYMMDD already
 * come back on every /api/promotions / /api/filters/voyages row, so callers
 * can build it without re-searching the UI.
 */
export function buildCruisingPowerPackageKey(packageCode, sailDateYYYYMMDD) {
  if (!packageCode || !sailDateYYYYMMDD) return null;
  return `${packageCode}_1${String(sailDateYYYYMMDD).slice(2)}`;
}

// The sidebar "Modify Search" filter form (ship/brand/date) sits in a
// collapsed panel with brittle show/hide behavior — not worth fighting.
// Instead we run the default broad search and page through results
// (see findSailingCheckboxId) until we find the matching packageKey.
// page.evaluate() can race a still-in-flight navigation right after a click
// ("Execution context was destroyed") — retry once after the page settles.
async function evaluateWithNavRetry(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (err) {
    if (!/execution context was destroyed/i.test(err.message)) throw err;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2000);
    return page.evaluate(fn, arg);
  }
}

// Espresso Classic wizard entry — the home-page Espresso widget now opens the
// AirWaves popup, but the classic wizard (reservations.do Spring Web Flow) is
// still alive and reachable DIRECTLY via a searchCriteriaJson URL param.
// Template captured from a real agent session (2026-07-03); packageCode and
// sailingDate are the only fields we vary per lookup, brandCode for bulk runs.
function buildSearchCriteriaJson({ sailingDate = "", brandCode = "", shipCode = "", packageCode = "" } = {}) {
  return {
    reservationType: "Individual", cruiseType: "", brandCode, shipCode,
    regionCode: "", embarkationPortCode: "", portsOfCallCode: "",
    openCruiseToursTab: false, invalidPromoCodes: "", cpCruisetourSearch: false,
    sailingDate,
    sailingDateDay: sailingDate ? sailingDate.slice(6, 8) : "",
    sailingDateMonthYear: "",
    sailingDateFromDay: "", sailingDateFromMonthYear: sailingDate ? sailingDate.slice(0, 6) : "",
    sailingDateFrom: "", sailingDateToDay: "", sailingDateToMonthYear: "", sailingDateTo: "",
    sailingDateType: "specific", sailingDateAdjusted: false, searchType: "",
    selectedGateways: ["C/O", "C/O", "C/O", "C/O"],
    duration: 0, occupancy: 2, numberOfAdults: 2, numberOfChildren: 0, numberOfInfants: 0,
    currencyCode: "GBP", priceCodesList: [], stateroomType: "", agentName: "",
    categoryCode: "", cabinNumber: "", packageCode, restrictedType: [],
    stateProvCode: null, reservationName: null, groupPolicyType: "", groupType: "",
    groupName: "", headquarterGroup: false, childrenAge: ["", "", "", ""], infantAge: ["", "", ""],
    promotionalSearchTab: false, packageType: "JAC", accessibilityRequested: false,
    connectingStateroomRequested: false, promoType: "", cpSearch: false, loyaltyTiers: null,
    qualifierScope: "PRICE_ONLY", priceScope: "REQUESTED_AVAILABLE", searchScope: "",
    includeClosedSailings: true, priceId: null, includeFacets: false, strictSearch: false,
    executeJacSearch: true, executeCtSearch: true, executeFareSearch: true, executePromoSearch: true,
    bookingMode: "C", bookingId: null, groupId: null, addFlight: false, choiceAirCP: false,
    connectingStateroomsRequested: false, familyStateroomsRequested: false, rooms: 1,
    cpCTPackageCode: "", choiceAirGateway: "", loyaltyNos: ["", "", "", ""], promoCodes: [],
    residentZipcode: null, couponCode: ["", "", "", ""], fit: true, groupShell: false,
    cruiseToursIncluded: false, specificDateSearch: true, dateRangeSearch: false,
    fastSellMode: true, closedPromotionIncluded: false,
  };
}

// Espresso session bootstrap. The wizard's OpenAM filter rejects synthetic
// remoteCPAccess.do handshakes (always 302→/home, then reservations.do →
// SecureLogin→logout). The ONLY reliable cold-start entry is the SPA's own
// Espresso widget Search button — the app performs its SSO handshake itself.
async function ensureEspressoSession(session) {
  const { page } = session;
  if (page.url().includes("/espresso/")) return; // already inside the wizard

  console.log("[cruisingpower] bootstrapping espresso session via home widget");
  await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (page.url().includes("/login")) {
    // SPA session died (espresso logout chain kills it) — log back in
    await ensureCruisingPowerAuthentication(session);
    await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // The widget can lazy-render — scroll to trigger it, reload once if missing.
  const espSearch = page.locator('[data-qa="secure.espresso.promos.button.search"]').first();
  let widgetReady = await espSearch.waitFor({ state: "attached", timeout: 20000 }).then(() => true).catch(() => false);
  if (!widgetReady) {
    console.log("[cruisingpower] espresso widget not rendered — scrolling + reloading");
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(3000);
    widgetReady = await espSearch.waitFor({ state: "attached", timeout: 10000 }).then(() => true).catch(() => false);
    if (!widgetReady) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);
      widgetReady = await espSearch.waitFor({ state: "attached", timeout: 30000 }).then(() => true).catch(() => false);
    }
    if (!widgetReady) {
      // Half-recovered sessions render a degraded home without the widget.
      // Full reset: drop cookies, fresh form login, then the widget renders.
      console.log("[cruisingpower] widget still missing — clearing cookies for a fresh login");
      await session.context.clearCookies();
      await ensureCruisingPowerAuthentication(session);
      await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await espSearch.waitFor({ state: "attached", timeout: 30000 });
    }
  }
  await espSearch.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  await espSearch.click({ force: true });
  await page.waitForURL((u) => u.toString().includes("/espresso/"), { timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log(`[cruisingpower] espresso session live: ${page.url().split("?")[0]}`);
}

async function searchSailings(session, criteria = {}) {
  const { page } = session;
  const json = JSON.stringify(buildSearchCriteriaJson(criteria));
  const url  = `${BASE_URL}/espresso/protected/reservations.do?searchCriteriaJson=${encodeURIComponent(json)}`;
  console.log(`[cruisingpower] entering espresso wizard: sailingDate=${criteria.sailingDate ?? ""} packageCode=${criteria.packageCode ?? ""} brand=${criteria.brandCode ?? "all"}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      // Cold espresso session bounced us out (and killed the SPA session too).
      if (attempt === 0) {
        console.log("[cruisingpower] espresso cold — bootstrapping and retrying");
        await ensureEspressoSession(session);
        continue;
      }
      throw new Error("Espresso session could not be established (still bouncing to /login).");
    }
    break;
  }
  console.log(`[cruisingpower] wizard url: ${page.url().split("?")[0]}?${(page.url().split("?")[1] ?? "").slice(0, 40)}`);

  // The sailing list renders as a dataTables grid with groupSailing checkboxes.
  const listed = await page.waitForSelector('input.checkbox.groupSailing, #sailingListTable', { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!listed) {
    const snippet = await page.evaluate(() => document.body.innerText.slice(0, 300).replace(/\s+/g, " ")).catch(() => "?");
    console.log(`[cruisingpower] warning: sailing list not detected. Page says: ${snippet}`);
  }
}

async function findSailingCheckboxId(page, packageKey) {
  for (let p = 0; p < 15; p++) {
    const id = await evaluateWithNavRetry(page, (key) => {
      const cbs = [...document.querySelectorAll('input.checkbox.groupSailing')];
      const match = cbs.find((cb) => {
        try { return JSON.parse(cb.value).key === key; } catch { return false; }
      });
      return match ? match.id : null;
    }, packageKey);
    if (id) return id;

    const nextBtn = page.locator('#sailingListTable_next');
    const disabled = await nextBtn.evaluate((el) => el.classList.contains("paginate_disabled_next")).catch(() => true);
    if (disabled) break;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      nextBtn.click()
    ]);
    await page.waitForTimeout(2000);
  }
  return null;
}

async function selectSailing(page, checkboxId) {
  await page.locator(`label[for="${checkboxId}"]`).click();
  await page.waitForTimeout(1500);

  // Select link id follows the pattern sailingList{rowIdx}1 (e.g. checkbox-1 →
  // #sailingList11). The checkbox is NOT inside a <tr> in the current layout,
  // so index-derivation is the reliable path; fall back to any enabled
  // .btnSelect if the pattern ever changes.
  const idx = checkboxId.match(/checkbox-(\d+)/)?.[1];
  const selectId = await evaluateWithNavRetry(page, (idx) => {
    const byPattern = document.getElementById(`sailingList${idx}1`);
    if (byPattern && !byPattern.classList.contains("disabled")) return byPattern.id;
    const anyEnabled = [...document.querySelectorAll("a.btnSelect:not(.disabled)")];
    return anyEnabled[0]?.id ?? null;
  }, idx);
  if (!selectId) throw new Error(`No enabled Select link found for checkbox ${checkboxId}`);

  console.log(`[cruisingpower] clicking Select link #${selectId}`);
  const selectLink = page.locator(`#${selectId}`);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    selectLink.click({ force: true })
  ]);
  await page.waitForTimeout(4000);
}

async function listCategoriesWithAvailability(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr")].filter((r) => r.querySelector(".categoryIcon"));
    const categories = rows.map((r) => {
      const code   = r.querySelector(".categoryIcon span")?.innerText?.trim() ?? null;
      const name   = r.querySelector(".categoryInfo a")?.innerText?.trim() ?? null;
      const status = r.querySelector(".svCabin .status")?.innerText?.trim() ?? null;
      const countText = r.querySelector(".svCabin .available.count")?.innerText?.trim() ?? "";
      const count  = Number(countText.replace(/[()]/g, "")) || 0;
      const price  = r.querySelector(".pricing")?.innerText?.trim() ?? null;
      const radio  = r.querySelector('input[name="rbCategorySelection"]');
      return { code, name, status, count, price, dataId: radio?.getAttribute("data-id") ?? null };
    }).filter((c) => c.code && c.dataId != null);

    // Ship name: try common heading/summary selectors then fall back to page title
    const headingCandidates = [
      ".sailingDetail .ship-name", ".sailingInfo h2", ".sailingSummary .shipName",
      "#sailingDetailHeader h1", "#sailingDetailHeader h2",
      ".summaryBlock .name", "h2.pageTitle", "h1.pageTitle",
      ".sail-details h2", ".booking-header h2",
      ".voyage-header h1", ".voyage-header h2",
      "h1", "h2"
    ];
    let ship = null;
    // Reject generic/dialog headings that aren't ship names
    const junk = /accept or decline|it's one of those|welcome|error|loading|brewing|hang tight|just a moment|please wait|good (morning|afternoon|evening)/i;
    for (const sel of headingCandidates) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2 && text.length < 120 && !junk.test(text)) {
        ship = text.split(/[\n|–\-]/)[0].trim();
        if (junk.test(ship)) { ship = null; continue; }
        break;
      }
    }
    if (!ship) {
      const title = document.title?.trim();
      if (title && !title.toLowerCase().includes("cruisingpower") && !junk.test(title)) ship = title.split(/[\|\-–]/)[0].trim();
    }

    // /api/promotions (the bulk list source) carries no itinerary at all, so
    // this wizard page is the only place trip length is visible. Read it off
    // the page text — unmatched just stays null, same as before.
    const body = document.body?.innerText ?? "";
    const nightsMatch = body.match(/(\d+)\s*night/i);
    const nights = nightsMatch ? Number(nightsMatch[1]) : null;

    return { categories, ship, nights };
  });
}

// Interstitial dialogs ("Accept or Decline" fare/promo terms) pop up after
// selecting a sailing and block the wizard until Accept is clicked.
async function dismissInterstitial(page) {
  for (let i = 0; i < 3; i++) {
    const accept = page.locator('a:visible, button:visible, input[type=button]:visible, input[type=submit]:visible')
      .filter({ hasText: /^\s*Accept\s*$/i }).first();
    if (!await accept.isVisible({ timeout: 2000 }).catch(() => false)) break;
    console.log("[cruisingpower] dismissing Accept/Decline interstitial");
    await accept.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

async function fetchStateroomsForCategory(page, dataId) {
  await dismissInterstitial(page);

  // Selecting a category fires an ajax `_eventId=allocate` POST which unhides
  // the Staterooms link. A force-click on the styled input often skips the
  // page's handler — click the associated label, then fall back to a real
  // JS click + change event, and wait for the allocate roundtrip.
  const allocatePromise = page.waitForResponse(
    (r) => r.url().includes("_eventId=allocate"), { timeout: 15000 }
  ).catch(() => null);

  const radioClicked = await page.evaluate((dataId) => {
    const r = document.querySelector(`input[name="rbCategorySelection"][data-id="${dataId}"]`);
    if (!r) return false;
    const label = r.id ? document.querySelector(`label[for="${r.id}"]`) : null;
    (label ?? r).scrollIntoView({ block: "center", behavior: "instant" });
    if (label) label.click();
    else { r.click(); }
    if (!r.checked) { r.checked = true; }
    r.dispatchEvent(new Event("click",  { bubbles: true }));
    r.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, dataId).catch(() => false);
  if (!radioClicked) {
    console.log("[cruisingpower]   category radio not found — skipping");
    return { deckData: null, decksMap: null, skipped: true };
  }
  const allocated = await allocatePromise;
  console.log(`[cruisingpower]   allocate ajax: ${allocated ? allocated.status() : "not observed"}`);
  await page.waitForTimeout(1500);

  // Advance to the staterooms step. Two possible controls:
  //   1. #submitToStaterooms (_eventId=saveCategoriesStaterooms) when unhidden
  //   2. any visible link firing _eventId=saveCategories — the standard
  //      Continue path seen in real agent sessions; the staterooms page then
  //      fires findHighestCabinAvailabilityDeck/getAvailableOnDecks itself.
  const advanceId = await page.evaluate(() => {
    const vis = (el) => el && !el.classList.contains("hidden") && el.getBoundingClientRect().width > 0;
    const strm = document.getElementById("submitToStaterooms");
    if (vis(strm)) return "submitToStaterooms";
    const save = [...document.querySelectorAll('a[href*="_eventId=saveCategories"], input[type=submit], button')]
      .find(e => vis(e) && !/staterooms/i.test(e.id ?? "") &&
        (/(continue|next|staterooms)/i.test(e.textContent || e.value || "") || /_eventId=saveCategories(?!Staterooms)/.test(e.getAttribute?.("href") ?? "")));
    if (save) { if (!save.id) save.id = "cpAdvanceTmp"; return save.id; }
    return null;
  }).catch(() => null);

  if (!advanceId) {
    console.log("[cruisingpower]   no staterooms/continue control (GTY or sold out) — skipping deck fetch");
    return { deckData: null, decksMap: null, skipped: true };
  }
  console.log(`[cruisingpower]   advancing via #${advanceId}`);

  const deckDataPromise = page.waitForResponse(
    (r) => r.url().includes("findHighestCabinAvailabilityDeck"), { timeout: 30000 }
  ).catch(() => null);
  const decksMapPromise = page.waitForResponse(
    (r) => r.url().includes("getAvailableOnDecks"), { timeout: 30000 }
  ).catch(() => null);

  // Record what the page actually calls, so a miss reports the endpoints that
  // did fire instead of just "nothing arrived". Both names above are guesses
  // frozen from an older session; if CP renamed or restructured them, this is
  // the only way to find out short of watching a browser by hand.
  const seenUrls = [];
  const noteResponse = (r) => {
    const u = r.url();
    if (/\.(png|jpe?g|gif|svg|css|woff2?|ico)(\?|$)/i.test(u)) return;
    seenUrls.push(`${r.status()} ${u.split("?")[0]}`);
  };
  page.on("response", noteResponse);

  try {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      page.locator(`#${advanceId}`).click({ force: true })
    ]);

    const [deckRes, decksRes] = await Promise.all([deckDataPromise, decksMapPromise]);
    const deckData = deckRes ? await deckRes.json().catch(() => null) : null;
    const decksMap = decksRes ? await decksRes.json().catch(() => null) : null;

    if (!deckData) {
      console.log("[cruisingpower]   no deck data response after advance");
      // Only the tail matters — the interesting calls come right after the click.
      const tail = [...new Set(seenUrls)].slice(-25);
      console.log(`[cruisingpower]   responses seen after advance (${seenUrls.length} total):`);
      for (const u of tail) console.log(`[cruisingpower]     ${u}`);
    }

    return { deckData, decksMap };
  } finally {
    page.off("response", noteResponse);
  }
}

function normalizeStateroomsToDecks(deckData) {
  const cabins = deckData?.stateroomViewList ?? [];

  // A payload that arrives but yields nothing is the failure mode that cost a
  // 95-minute run: the deck response was fetched fine, so no error surfaced,
  // yet zero cabins were written. Report the shape when the expected list is
  // missing rather than silently returning [].
  if (cabins.length === 0 && deckData && typeof deckData === "object") {
    const keys = Object.keys(deckData);
    const arrays = keys.filter(k => Array.isArray(deckData[k]))
      .map(k => `${k}[${deckData[k].length}]`);
    console.log(
      `[cruisingpower]   deck payload has no stateroomViewList — ` +
      `keys: ${keys.slice(0, 12).join(", ") || "(none)"}` +
      (arrays.length ? ` | arrays: ${arrays.join(", ")}` : "")
    );
  }

  const byDeck = new Map();
  for (const cabin of cabins) {
    const deckCode = cabin.deck?.code ?? "?";
    if (!byDeck.has(deckCode)) {
      // deck.sequence is often 0 — derive the deck number from the cabin
      // number instead (RCL/Celebrity: digits before the last 3 = deck,
      // e.g. 10100 → deck 10, 12108 → deck 12).
      let deckNum = cabin.deck?.sequence || null;
      const numStr = String(cabin.stateroomNumber ?? "");
      if (!deckNum && /^\d{4,}$/.test(numStr)) deckNum = parseInt(numStr.slice(0, numStr.length - 3)) || null;
      byDeck.set(deckCode, {
        deckNumber: deckNum,
        deckName:   cabin.deck?.name ?? deckCode,
        deckCode,
        cabins:     []
      });
    }
    byDeck.get(deckCode).cabins.push({
      number:       cabin.stateroomNumber,
      status:       cabin.status,
      bed:          cabin.stateroomDetailsView?.bed ?? null,
      location:     cabin.stateroomDetailsView?.location ?? null,
      obstacles:    cabin.stateroomDetailsView?.obstacles ?? null,
      berths:       cabin.stateroomDetailsView?.berths ?? null,
      maxOccupancy: cabin.maxOccupancy ?? null,
      connecting:   !!cabin.connectingStateroom,
      accessible:   !!cabin.accessible
    });
  }
  return [...byDeck.values()];
}

/**
 * Fetch full deck/cabin-level detail for one sailing, across every category
 * that currently has availability. Re-runs the search->select->category wizard
 * once per category (Spring WebFlow doesn't cleanly support jumping back from
 * Staterooms to Categories), reusing one persistent browser session so login
 * only happens once.
 */
export async function fetchCruisingPowerCategoryDecks({ packageKey }) {
  return runExclusiveCruisingPower(async () => {
    const session = await getOrCreateCruisingPowerSession();
    const { page } = session;

    await ensureCruisingPowerAuthentication(session);
    // Bootstrap espresso BEFORE the first wizard URL: hitting reservations.do
    // with a cold espresso session triggers a SecureLogin→logout chain that
    // destroys the SPA session too, forcing a fragile mid-flow re-login.
    await ensureEspressoSession(session);

    // packageKey format: "AX12U416_1260711" → packageCode "AX12U416", sailDate 20260711.
    // Feeding both into the wizard's searchCriteriaJson lands directly on this
    // sailing instead of paging through a broad search.
    const [pkgCode, dateSuffix] = packageKey.split("_1");
    const criteria = {
      packageCode: pkgCode ?? "",
      sailingDate: dateSuffix ? `20${dateSuffix}` : "",
    };
    await searchSailings(session, criteria);

    let checkboxId = await findSailingCheckboxId(page, packageKey);
    if (!checkboxId && criteria.packageCode) {
      // Some package codes aren't searchable directly — retry with date-only search
      console.log(`[cruisingpower] packageCode search empty — retrying with date-only search`);
      await searchSailings(session, { sailingDate: criteria.sailingDate });
      checkboxId = await findSailingCheckboxId(page, packageKey);
    }
    if (!checkboxId) {
      throw new Error(`Sailing not found in search results: ${packageKey}`);
    }
    await selectSailing(page, checkboxId);

    const { categories, ship: shipFromPage, nights: nightsFromPage } = await listCategoriesWithAvailability(page);
    const available = categories.filter((c) => c.status !== "WLT");
    console.log(`[cruisingpower] ${available.length}/${categories.length} categories available, ship="${shipFromPage ?? "unknown"}"`);

    // Record the categories URL so we can navigate back to it instead of re-running
    // the full wizard search for every category — saves ~8 min on a 10-category sailing.
    const categoriesUrl = page.url();

    const results = [];
    for (let i = 0; i < available.length; i++) {
      const cat = available[i];
      console.log(`[cruisingpower] fetching staterooms for ${cat.code} (${cat.status}, ${cat.count} avail) [${i+1}/${available.length}]`);
      const { deckData, skipped } = await fetchStateroomsForCategory(page, cat.dataId);
      const decks = normalizeStateroomsToDecks(deckData);
      results.push({ code: cat.code, name: cat.name, status: cat.status, count: cat.count, price: cat.price, decks });

      // Skipped categories (GTY) never left the categories page — no back-nav needed.
      if (skipped) continue;

      // Navigate back to categories page for the next iteration.
      // Try page.goBack() first; fall back to full wizard re-run if that fails.
      if (i < available.length - 1) {
        const backOk = await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).then(() => true).catch(() => false);
        await page.waitForTimeout(2000);
        const onCategories = await page.evaluate(() =>
          !!document.querySelector('input[name="rbCategorySelection"]')
        ).catch(() => false);

        if (!backOk || !onCategories) {
          // goBack failed or landed on wrong page — re-navigate via URL shortcut
          if (categoriesUrl && categoriesUrl !== page.url()) {
            await page.goto(categoriesUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
          const stillOk = await page.evaluate(() =>
            !!document.querySelector('input[name="rbCategorySelection"]')
          ).catch(() => false);

          if (!stillOk) {
            // Final fallback: full wizard re-run
            console.log(`[cruisingpower] back navigation failed for ${cat.code} — re-running full wizard`);
            await searchSailings(session, criteria);
            const id = await findSailingCheckboxId(page, packageKey);
            if (id) await selectSailing(page, id);
          }
        }
      }
    }

    const shipFromCode = CP_SHIP_NAMES[packageKey.slice(0, 2)] ?? null;
    return { packageKey, categories: results, ship: shipFromPage ?? shipFromCode, nights: nightsFromPage ?? null };
  });
}
