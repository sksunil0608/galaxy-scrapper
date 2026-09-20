// MSC Cruises (mscbook.com — UK agent portal)
//
// Strategy: login through the React UI, then for each requested date range
// navigate to the results page and read cruise summaries directly from the
// rendered DOM (see extractCruisesFromResultsDom below). MSC relaunched
// mscbook.com on a new Next.js frontend at some point after this scraper was
// first written; the old shop/SearchCruiseV3?... WCS-commerce URL and its
// CruiseResultsElasticSearchCmd JSON response no longer work (confirmed live:
// that URL now silently redirects to a generic "flags=no-search" page).
// Full per-cabin-category pricing/availability still comes from the same
// CruiseCabinAvailabilityCmd endpoint as before, reached via BOOK NOW →
// CONFIRM SELECTION on the new UI's itinerary cards.

import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";
import prisma from "../../config/prisma.js";

dotenv.config();

const USERNAME  = process.env.MSC_USER;
const PASSWORD  = process.env.MSC_PASS;
const HOME_URL  = "https://www.mscbook.com/uk/home";

// Authoritative cabin code → group lookup, sourced from MSC's own
// CABIN_CATEGORIES dictionary embedded in CruiseDetailsView. The official
// groups are I (Interior), O (Oceanview), B (Balcony), S (Suite),
// Y (Yacht Club), F (Family), BIN (Speciality). A first-letter heuristic
// gets several codes wrong (e.g. SPL is Interior, SL1/SL2 are Suites,
// VL1/VL2 are Oceanview, PV/PR1-3 are Balcony) so we use the explicit map.
const CABIN_GROUPS = {
  Interior:    ["I1","I2","I3","IF1","IW","I1S","SPL","IP1","IB","IM1","IM2","IS","IR1","IR2","IL1","IX1"],
  Oceanview:   ["O1","O2","OF1","OW","OB","OM1","OM2","OR1","OR2","OL1","OS","OL2","OL3","OO","VL1","VL2","VLA"],
  Balcony:     ["B1","B2","B3","BW","BP","BP2","BB","BM1","BS","BR1","BR2","BR3","BA","BM2","BL1","BL2","BL3","BR4","PV","PR1","PR2","PR3","BGA"],
  Suite:       ["S2","S3","SP3","SD3","SE3","SEW","SJ3","SP2","SUI","SUIB","D3","SR1","SR2","SLJ","SXJ","SRS","SLS","SX","SRP","SLP","SM","SXT","SL1","SL2","SLW","SD","SLT"],
  "Yacht Club":["YC1","YC2","YC3","YCW","YH1","YIN","YC4","YCP","YCD","YJD","YCL","YCT"],
  Family:      ["FPO","FPB","FMO","FMB","FLP","FLO","FLA","FAM"],
  Speciality:  ["BIN","BOU","BBL","SBG"],
};

const CABIN_CODE_TO_GROUP = Object.fromEntries(
  Object.entries(CABIN_GROUPS).flatMap(([group, codes]) => codes.map(c => [c, group]))
);

function inferCabinGroup(code) {
  const c = String(code || "").toUpperCase();
  if (!c) return null;
  return CABIN_CODE_TO_GROUP[c] ?? null;
}


// MSC relaunched mscbook.com on a new Next.js frontend. The old
// shop/SearchCruiseV3?... WCS-commerce URL (with departuretimefrom1/to1 etc.)
// silently redirects to a generic "flags=no-search" page and never fires a
// real search — confirmed live by watching network traffic while manually
// using the site. The new working results URL is simply
// uk/search/list?date-range=YYYYMMDD-YYYYMMDD&ship=CODE (dashes, no other
// params needed — occupancy/cabins default sensibly and can be adjusted via
// the UI's own filters if ever needed).
function buildSearchUrl({ from, to, ship = "" }) {
  const params = new URLSearchParams({ "date-range": `${from}-${to}` });
  if (ship) params.set("ship", ship);
  return `https://www.mscbook.com/uk/search/list?${params.toString()}`;
}

function ddmmyyyy(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = date.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function yyyymmdd(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${yyyy}${mm}${dd}`;
}

function buildMonthlyRanges(startDate, monthsAhead) {
  const ranges = [];
  for (let i = 0; i < monthsAhead; i++) {
    const start = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const end   = new Date(startDate.getFullYear(), startDate.getMonth() + i + 1, 0);
    ranges.push({ from: ddmmyyyy(start), to: ddmmyyyy(end), _fromDate: start, _toDate: end });
  }
  return ranges;
}

// MSC cruise IDs embed the ship code + sail date + embark/disembark port
// codes, e.g. "OX20270101FDFFDF" = ship OX, sails 2027-01-01, ports FDF->FDF.
// This is the only per-cruise structured data available from the results
// page's DOM (no separate JSON API to read full itinerary/price details from
// for the list pass — full cabin-category detail comes later from the
// deck-pass's BOOK NOW click-through, same as before).
function normalizeMscDomCruise({ cruiseId, priceCode, ship, route, bestPrice, nights = null }) {
  const m = String(cruiseId).match(/^([A-Z]{2})(\d{4})(\d{2})(\d{2})([A-Z]{3})([A-Z]{3})$/);
  const shipCode = m?.[1] ?? null;
  const startDate = m ? new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).toISOString() : null;
  const portFrom = m?.[5] ?? null;
  const portTo = m?.[6] ?? null;
  return {
    id: cruiseId,
    ship,
    shipCode,
    package: null,
    routeLabel: route ?? (portFrom && portTo ? `${portFrom} -> ${portTo}` : null),
    portFrom,
    portTo,
    startDate,
    endDate: nights != null && startDate ? new Date(new Date(startDate).getTime() + nights * 86400000) : null,
    nights,
    trend: null,
    confidence: "Low",
    pinned: false,
    currency: "GBP",
    promotions: [],
    itineraryStops: [],
    // code/name are required (non-null) columns on CabinCategory — this
    // placeholder only ever carries a single best-price total (the real
    // per-category codes aren't visible in the results-page DOM), so use a
    // sentinel code rather than null, which crashed the DB insert for any
    // cruise the deck-pass never got to (or that this placeholder survived
    // past, before the deck-pass loop started replacing it wholesale).
    cabinCategories: bestPrice != null
      ? [{ code: "BESTPRICE", name: "Best available price", group: null, status: "Available", avlResult: "OK", totalCabins: null, avail: null, available: null, cabinPrice: bestPrice, perPersonPrice: null, capacity: null, confidence: "Low", promos: [], cabins: [], decks: [], priceCode, currency: "GBP", fareType: null }]
      : [],
  };
}

async function dismissImportantInfo(page) {
  for (let i = 0; i < 8; i++) {
    const closeBtn = page.locator('button[aria-label="Close modal"]').first();
    // Since MSC's Cruise Search redesign, a one-time "What's New in Cruise
    // Search?" tour modal can also appear, with "Not Now"/"Start" buttons
    // instead of an aria-label close button.
    const notNowBtn = page.locator('button:has-text("Not Now")').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      if (!(await closeBtn.isVisible().catch(() => false))) return;
    } else if (await notNowBtn.isVisible().catch(() => false)) {
      await notNowBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      if (!(await notNowBtn.isVisible().catch(() => false))) return;
    } else {
      await page.waitForTimeout(600);
    }
  }
}

async function isLoggedIn(page) {
  const loginBtn = page.locator('button:has-text("LOG IN"), a:has-text("LOG IN")').first();
  return !(await loginBtn.isVisible().catch(() => false));
}

async function ensureMscAuthentication(session, { forceRelogin = false } = {}) {
  const { page } = session;

  if (!USERNAME || !PASSWORD) {
    throw new Error("MSC_USER and MSC_PASS must be set in .env before using the msc scraper.");
  }

  // isLoggedIn() only checks whether the header shows "LOG IN" — a reused
  // session can pass this (header still renders as logged in) while the
  // underlying auth token is actually stale for the shop/search API, which
  // then silently 302-redirects SearchCruiseV3 back to /uk/home instead of
  // running the search. forceRelogin clears cookies first so the header
  // genuinely shows LOG IN again, instead of trusting a stale-but-rendered
  // "logged in" UI state.
  if (forceRelogin) {
    console.log("[msc] forceRelogin: clearing cookies for a genuinely fresh session");
    await page.context().clearCookies();
  }

  console.log("[msc] navigating to home");
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  await dismissImportantInfo(page);

  if (!forceRelogin && await isLoggedIn(page)) {
    console.log("[msc] session reused");
    return { success: true, alreadyLoggedIn: true, message: "MSC session reused." };
  }

  console.log("[msc] logging in via UI");
  const loginBtn = page.locator('button:has-text("LOG IN"), a:has-text("LOG IN")').first();
  await loginBtn.click({ force: true });
  await page.waitForTimeout(2000);

  const userInput = page.locator('input[name="username"], input[name="logonId"], input[type="text"]').first();
  await userInput.waitFor({ state: "visible", timeout: 15000 });
  await userInput.fill(USERNAME);
  await page.locator('input[name="password"], input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]:has-text("LOG IN"), input[type="submit"]').first().click({ force: true });
  await page.waitForTimeout(2000);

  // MSC enforces one active session per agent user ID. If this same account
  // is already logged in elsewhere (e.g. a previous run's session that never
  // cleanly closed), a modal blocks the login: "THIS INDIVIDUAL USER ID HAS
  // LOGGED IN SINCE <date>. FORCE LOG IN?" with CANCEL/CONFIRM buttons.
  // Without handling this, the login silently never completes (URL never
  // changes, header never updates) and looks identical to a bad password.
  const forceLoginConfirm = page.locator("button, a").filter({ hasText: /^confirm$/i }).first();
  if (await forceLoginConfirm.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("[msc] another session is active for this user — clicking CONFIRM to force login");
    await forceLoginConfirm.click({ force: true });
    await page.waitForTimeout(2000);
  }

  await page.waitForURL(/\/uk\/home/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await dismissImportantInfo(page);

  // The header can take a moment to re-render post-submit even after the URL
  // has already changed to /uk/home — a single fixed-delay isLoggedIn() check
  // here raced that render and threw "still logged out" on an otherwise
  // successful login (confirmed live: body content showed "ADMIN AGENT /
  // SIGN OUT" — genuinely logged in — at the exact moment the old check
  // failed). Poll for a few seconds instead of trusting one snapshot.
  let loggedIn = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await isLoggedIn(page)) { loggedIn = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!loggedIn) {
    throw new Error("MSC login failed — LOG IN button still visible after submit.");
  }

  console.log("[msc] login successful");
  await session.persistAuthState();
  return { success: true, alreadyLoggedIn: false, message: "MSC login successful." };
}

// Extract cruise summaries directly from the results page DOM. MSC's
// redesigned Cruise Search renders one <div data-scroll-anchor="itinerary-card">
// per itinerary, and inside it one <div data-cruiseid="..." data-pricecode="...">
// price tile per sailing date (confirmed live: this tile's cruiseId is what
// CruiseResultsSetCurrentOrderCmd/BOOK NOW needs — the older a[data-cruiseid]
// calendar-cell selector no longer exists on this UI at all).
async function extractCruisesFromResultsDom(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-scroll-anchor="itinerary-card"]')];
    const out = [];
    for (const card of cards) {
      const shipText = card.querySelector(".text-msc-blue span")?.textContent?.trim() ?? null;
      const routeText = card.querySelector(".font-bold.text-base\\/\\[25px\\]")?.textContent?.trim() ?? null;
      // The card carries a "Duration" column rendered as e.g. "7 Nights" — the
      // only place trip length appears at list stage. Read it off the card text
      // rather than a brittle class selector; unmatched simply stays null.
      const nightsMatch = (card.textContent ?? "").match(/(\d+)\s*night/i);
      const cardNights = nightsMatch ? Number(nightsMatch[1]) : null;
      const tiles = [...card.querySelectorAll("div[data-cruiseid]")];
      for (const tile of tiles) {
        const cruiseId = tile.getAttribute("data-cruiseid");
        const priceCode = tile.getAttribute("data-pricecode");
        const priceText = tile.querySelector("span")?.parentElement?.textContent ?? tile.textContent ?? "";
        const priceMatch = priceText.match(/£\s*([\d,]+)/);
        if (cruiseId) {
          out.push({
            cruiseId,
            priceCode,
            ship: shipText,
            route: routeText,
            nights: cardNights,
            bestPrice: priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null,
          });
        }
      }
    }
    return out;
  });
}

// Navigate to the results page for a date range (+ optional ship filter) and
// extract cruise summaries from the DOM. MSC relaunched mscbook.com on a new
// Next.js frontend — the old shop/SearchCruiseV3?... WCS-commerce URL (and
// its ElasticSearchCmd XHR) silently redirects to a generic "flags=no-search"
// page and never returns results (confirmed live by watching network traffic
// while manually using the site after the redesign). The new working URL is
// uk/search/list?date-range=YYYYMMDD-YYYYMMDD&ship=CODE, and results render
// directly into the page HTML — no separate JSON API to intercept.
async function fetchOneRange(page, range, occupancy, shipCode = null) {
  const url = buildSearchUrl({
    from: yyyymmdd(range._fromDate),
    to:   yyyymmdd(range._toDate),
    ship: shipCode ?? "",
  });

  console.log(`[msc] searching ${range.from} → ${range.to}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await dismissImportantInfo(page);

  const hasCards = await page.locator('[data-scroll-anchor="itinerary-card"]').first().isVisible({ timeout: 15000 }).catch(() => false);
  if (!hasCards) {
    // A reused session can go stale in (at least) two ways: (1) the results
    // page silently redirects back to /uk/home while the header still shows
    // "logged in", or (2) the server explicitly serves ReLogonFormView with
    // "Your session has timed out". Both leave zero itinerary cards on the
    // page. Detect either and signal it to the caller (via .staleSession) so
    // it can force a real re-login and retry, instead of returning an empty
    // result that looks identical to "no cruises in this date range."
    const staleSession = page.url().includes("/uk/home")
      || page.url() === HOME_URL
      || page.url().includes("ReLogonFormView");
    console.log(`[msc] no itinerary cards for ${range.from} → ${range.to}${staleSession ? " (session expired/redirected — stale session)" : ""}`);
    if (process.env.MSC_DEBUG_SNAPSHOT) {
      try {
        const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
        console.log(`[msc-debug] url=${page.url()} bodyPreview=${JSON.stringify(bodyText)}`);
      } catch {}
    }
    const result = [];
    result.staleSession = staleSession;
    return result;
  }

  const rawTiles = await extractCruisesFromResultsDom(page);
  // Group price-tiles by cruiseId — each tile is one sailing date of an
  // itinerary, and CruiseResultsSetCurrentOrderCmd/BOOK NOW addresses the
  // cruiseId directly, so each tile is really its own bookable cruise.
  const cruises = rawTiles.map(t => normalizeMscDomCruise(t));

  console.log(`[msc]   → ${cruises.length} cruises`);
  return cruises;
}

export async function authenticateMsc() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/msc-user-data",
    storageStatePath: "./sessions/.auth/msc-storage.json",
    headless:         false,
    slowMo:           0
  });
  try {
    const authResult = await ensureMscAuthentication(session);
    return { vendorKey: "msc", browserMode: session.mode, ...authResult };
  } catch (error) {
    error.message = `msc authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

export async function runMscScraper(options = {}) {
  let {
    startDate    = new Date(),
    monthsAhead  = 12,
    occupancy    = { adults: 2, children: 0, juniors: 0, infants: 0 },
    withDecks    = true,       // fetch real cabin numbers + decks for every cruise (slow but required)
    maxDeckCruises = Infinity, // safety cap for testing
    deckWindowDays = null,     // if set, only run deck-pass for cruises sailing within N days of startDate
    shipName     = null,       // optional, e.g. "SEASIDE" — SearchCruiseV3's own `ship` param takes a shipCode, not a name, so the first month is fetched unfiltered to resolve name→code, then every subsequent month's bulk fetch is narrowed server-side via that code
  } = options;
  // API callers pass startDate as an ISO string — coerce to Date
  if (typeof startDate === "string") startDate = new Date(startDate);
  monthsAhead = Number(monthsAhead) || 12;

  // Testing/debugging a single specific cruise via deckCodes shouldn't require
  // walking the full monthsAhead sweep from today — MSC cruise IDs embed their
  // sail date (e.g. MR20261016PMOBCN -> 2026-10-16), so jump straight to that
  // month and only search a narrow ±1 month window around it instead of every
  // month between today and the target.
  if (options.deckCodes?.length === 1 && !options.startDate) {
    const m = String(options.deckCodes[0]).match(/(\d{8})/);
    if (m) {
      const targetDate = new Date(`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`);
      if (!isNaN(targetDate)) {
        startDate = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
        monthsAhead = 2;
        console.log(`[msc] deckCodes targets a single cruise (${options.deckCodes[0]}) — narrowing search to ${startDate.toDateString()} + ${monthsAhead} months instead of full sweep`);
      }
    }
  }

  const session = await createScraperSession({
    userDataDir:      "./sessions/msc-user-data",
    storageStatePath: "./sessions/.auth/msc-storage.json",
    headless:         false,
    slowMo:           0
  });

  try {
    const authResult = await ensureMscAuthentication(session);
    const { page } = session;

    const ranges = buildMonthlyRanges(startDate, monthsAhead);
    const allCruises = [];
    const seen = new Set();
    let relogged = false;

    const shipFilter = shipName ? shipName.trim().toUpperCase() : null;
    let resolvedShipCode = null; // resolved from the first unfiltered range once shipName matches something

    for (const range of ranges) {
      // Once we know the shipCode, every later month's search is filtered server-side.
      let cruises = await fetchOneRange(page, range, occupancy, resolvedShipCode);
      if (cruises.staleSession && !relogged) {
        // Reused session rendered as logged-in but the shop API silently
        // redirected the search back to /uk/home — force a real re-login
        // (clears cookies first) and retry this range once. Only do this
        // once per run, not per range, since a genuine site outage would
        // otherwise trigger a relogin loop across every month searched.
        console.log("[msc] stale session detected — forcing re-login and retrying");
        relogged = true;
        await ensureMscAuthentication(session, { forceRelogin: true });
        cruises = await fetchOneRange(page, range, occupancy, resolvedShipCode);
      }

      if (shipFilter && !resolvedShipCode) {
        // First pass for this shipName — resolve name→code from whatever this
        // (still-unfiltered) range returned, then narrow every later range.
        const match = cruises.find?.((c) => c.ship?.toUpperCase().includes(shipFilter));
        if (match?.shipCode) {
          resolvedShipCode = match.shipCode;
          console.log(`[msc] shipName="${shipName}" resolved to shipCode=${resolvedShipCode} — narrowing remaining ranges`);
        }
      }

      // Same cruiseID can appear in adjacent months (departure date sits inside both windows).
      for (const cruise of cruises) {
        if (shipFilter && !cruise.ship?.toUpperCase().includes(shipFilter)) continue;
        if (cruise.id && !seen.has(cruise.id)) {
          seen.add(cruise.id);
          allCruises.push(cruise);
        }
      }
    }

    console.log(`[msc] total unique cruises across ${ranges.length} ranges: ${allCruises.length}`);

    // ── Deck-data pass ──────────────────────────────────────────────────────
    // Bulk search gives categories/prices only. Loop every cruise through the
    // cabin-selection wizard (same session) to attach real cabin numbers+decks.
    if (withDecks) {
      let done = 0, ok = 0;
      let lastMonthKey = null;
      // MSC's bulk search leaves cruise.startDate null — the real sail date is
      // embedded in the cruise code (e.g. "EU20270306FDF..." → 2027-03-06).
      const deriveSailDate = (c) => {
        if (c.startDate) return new Date(c.startDate);
        const m = String(c.id).match(/(\d{8})/);
        return m ? new Date(`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`) : null;
      };

      // deckCodes: optional explicit list (testing); deckWindowDays: date-window
      // cap (e.g. 14 = only sailings in the next 2 weeks); otherwise all cruises
      // allCruises is already shipName-filtered above (once resolvedShipCode kicks
      // in, the bulk fetch itself is narrowed too) — no need to re-filter here.
      let deckList = options.deckCodes?.length
        ? allCruises.filter((c) => options.deckCodes.includes(c.id))
        : allCruises;
      if (deckWindowDays) {
        const cutoff = new Date(startDate.getTime() + deckWindowDays * 86400000);
        deckList = deckList.filter((c) => { const d = deriveSailDate(c); return d && !isNaN(d) && d <= cutoff; });
        console.log(`[msc-decks] deckWindowDays=${deckWindowDays} — ${deckList.length}/${allCruises.length} cruises in window`);
      }

      // Cruises that already have cabin rows go LAST, and ones with nothing
      // bookable (no price at all → cabinCategories empty) go last too — same
      // ordering bug already found and fixed in goccl.js, celestyal.js and
      // azamara.js: a capped pass in plain list order either kept re-fetching
      // already-covered sailings, or wasted its cap on sailings that can never
      // yield cabins. MSC's list stage doesn't carry real per-category WTL/SLD
      // status (every priced category is provisionally "OK" until the wizard
      // proves otherwise), so "has any category at all" is the right MSC-side
      // equivalent of the OK-category check used for the other three vendors.
      try {
        const codesWithCabins = new Set(
          (await prisma.cruise.findMany({
            where: { vendor: { slug: "msc" }, cabinCategories: { some: { cabins: { some: {} } } } },
            select: { code: true }
          })).map((c) => c.code)
        );
        const priority = (c) => {
          if (codesWithCabins.has(c.id)) return 2;               // already covered
          if ((c.cabinCategories ?? []).length === 0) return 2;   // nothing priced/bookable
          return 1;                                                 // real gap
        };
        deckList = [...deckList].sort((a, b) => priority(a) - priority(b));
        const missingCount = deckList.filter((c) => priority(c) === 1).length;
        console.log(`[msc-decks] ${missingCount}/${deckList.length} candidates lack cabin data — those go first`);
      } catch (err) {
        console.log(`[msc-decks] ordering-by-DB-state failed (${err.message}) — falling back to list order`);
      }

      for (const cruise of deckList) {
        if (done >= maxDeckCruises) break;
        done++;
        const sailDate = deriveSailDate(cruise);
        if (!sailDate || isNaN(sailDate)) { console.log(`[msc-decks] ${cruise.id}: no sail date — skipped`); continue; }
        console.log(`[msc-decks] (${done}/${Math.min(deckList.length, maxDeckCruises)}) ${cruise.id}`);

        // 2 attempts per cruise — transient network drops (ERR_HTTP2, DNS)
        // killed a third of the first bulk pass. "Sailing not found" is a
        // permanent condition (variant/one-way not on results page): no retry.
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            // Proven refresh order: month ElasticSearch (sets the session's
            // search context — without it the category grid renders empty) →
            // results page → cabin selection.
            const monthKey = `${sailDate.getFullYear()}-${sailDate.getMonth()}`;
            if (monthKey !== lastMonthKey || attempt > 1) {
              const mStart = new Date(sailDate.getFullYear(), sailDate.getMonth(), 1);
              const mEnd   = new Date(sailDate.getFullYear(), sailDate.getMonth() + 1, 0);
              const mRange = { from: ddmmyyyy(mStart), to: ddmmyyyy(mEnd), _fromDate: mStart, _toDate: mEnd };
              await fetchOneRange(page, mRange, occupancy);
              lastMonthKey = monthKey;
            }
            await navigateToResultsPage(page, sailDate);
            await reachCabinSelectionPage(page, { cruiseCode: cruise.id, shipCode: cruise.shipCode, sailDate });
            const { categoryCodes, cabinsByCategory, categoryPriceByCode } = await establishCartAndGetCategories(page, cruise.shipCode, cruise.id);
            // The list-extraction pass only ever produces a single Low-confidence
            // placeholder category with code/name left null (real category codes
            // aren't visible on the results-page DOM, only a best-price total) —
            // replace it wholesale with the deck-pass's real per-category rows
            // instead of trying to merge into it by code, which always missed
            // (null placeholder code never matches a real category code) and left
            // the null-code placeholder in place, crashing the later DB insert
            // (code/name are required columns).
            cruise.cabinCategories = categoryCodes.map((code) => {
              const avlCabins = cabinsByCategory[code] ?? [];
              const cabinPrice = categoryPriceByCode?.[code] ?? null;
              return {
                code,
                name:           code,
                group:          inferCabinGroup(code),
                status:         avlCabins.length > 0 ? "Available" : "Unknown",
                avlResult:      avlCabins.length > 0 ? "OK" : null,
                totalCabins:    null,
                avail:          avlCabins.length,
                available:      avlCabins.length,
                cabinPrice,
                perPersonPrice: null,
                capacity:       null,
                confidence:     avlCabins.length > 0 ? "High" : "Medium",
                promos:         [],
                cabins: (avlCabins ?? []).map((c) => ({
                  cabinNumber: String(c.cabinNo),
                  deckNumber:  c.deckNumber ? Number(c.deckNumber) : deckFromCabinNumber(c.cabinNo),
                  deckName:    c.deckName ?? null,
                  capacity:    null,
                  status:      c.allocated === "Y" ? "Available" : "Occupied",
                })),
              };
            });
            ok++;
            break;
          } catch (err) {
            const msg = err.message.split("\n")[0];
            const permanent = /Sailing not found/i.test(msg);
            // "Target page, context or browser has been closed" means the
            // browser itself is gone (killed externally, crashed, etc.) — no
            // amount of retrying within this session can recover, and the
            // retry's own page.waitForTimeout() below would throw the same
            // error again (unhandled, since it's outside this try). Stop the
            // whole deck pass immediately instead of limping through 20+ more
            // doomed per-cruise retries.
            const browserClosed = /Target page, context or browser has been closed/i.test(msg);
            if (browserClosed) {
              console.log(`[msc-decks] ${cruise.id}: browser/page closed — aborting remaining deck pass`);
              throw err;
            }
            if (permanent || attempt === 2) {
              console.log(`[msc-decks] ${cruise.id} failed: ${msg}`);
              break;
            }
            console.log(`[msc-decks] ${cruise.id} attempt ${attempt} failed (${msg}) — retrying`);
            await page.waitForTimeout(5000).catch(() => {});
          }
        }
      }
      console.log(`[msc-decks] deck pass complete: ${ok}/${done} cruises got cabin data`);
    }

    return {
      vendorKey:      "msc",
      browserMode:    session.mode,
      authentication: authResult,
      cruises:        allCruises,
    };
  } finally {
    await session.close();
  }
}

// ── Single-voyage deck/cabin detail fetch ───────────────────────────────────
// /api/promotions (used above) only returns cheapest-per-class pricing.
// Individual stateroom numbers live behind CabinSelectionCabinListDescriptionCmd,
// a direct POST endpoint discovered behind the booking wizard's deck plan view.
// It needs an active cart ("cabinId=1"), so we still drive the wizard once per
// sailing (search -> select -> confirm one category) to establish that cart,
// then loop every category code via fast direct POSTs instead of clicking
// through the wizard once per category.

// Kept open across requests — Chromium drops session-only cookies on browser
// close even with a persistent profile dir, so closing after every refresh
// forces a fresh login every time. Reusing one long-lived session avoids that.
let cachedMscSession = null;
let mscQueue = Promise.resolve();

async function getOrCreateMscSession() {
  if (cachedMscSession) {
    const alive = await cachedMscSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedMscSession;
    await cachedMscSession.close().catch(() => {});
    cachedMscSession = null;
  }
  cachedMscSession = await createScraperSession({
    userDataDir:      "./sessions/msc-user-data-shadow",
    storageStatePath: "./sessions/.auth/msc-storage-shadow.json",
    headless:         false,
    slowMo:           0
  });
  return cachedMscSession;
}

function runExclusiveMsc(fn) {
  const result = mscQueue.then(fn);
  mscQueue = result.catch(() => {});
  return result;
}

async function dismissCookieBanner(page) {
  const agreeBtn = page.locator('button:has-text("Agree and close")').first();
  if (await agreeBtn.isVisible().catch(() => false)) {
    await agreeBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
  }
}

/** Per-category lead price from the category grid, keyed by category code. */
async function readCategoryPrices(page) {
  return page.evaluate(() => {
    const byCode = {};
    for (const el of document.querySelectorAll(".cs-price-box[data-category]")) {
      const code = el.getAttribute("data-category");
      if (!code || byCode[code]) continue;
      const m = (el.textContent ?? "").match(/£\s*([\d,]+)/);
      if (m) byCode[code] = Number(m[1].replace(/,/g, ""));
    }
    return byCode;
  }).catch(() => ({}));
}

/**
 * Accept the "IMPORTANT INFO" interstitial the booking wizard raises on some
 * itineraries, and report whether one was there.
 *
 * Sailings that call at Greek ports get a mandatory notice about the Greek
 * Government passenger fee (in force since 21 July 2025) with "Back to cruise
 * results" / "Accept and confirm". Until it's accepted the wizard silently
 * swallows CONFIRM SELECTION: the click registers, nothing navigates, and the
 * category grid reads as 0 categories — which looked exactly like the sailing
 * having no availability. Every Piraeus departure failed this way while
 * non-Greek itineraries in the same run succeeded, which is what made it look
 * like the account had been throttled.
 *
 * Matched on the btnProceed class rather than the label so a reworded or
 * differently-themed notice (other ports levy their own fees) still clears.
 */
async function acceptImportantInfo(page) {
  const proceed = page.locator("button.btnProceed:visible, a.btnProceed:visible").first();
  if (!(await proceed.isVisible().catch(() => false))) return false;

  const label = (await proceed.textContent().catch(() => ""))?.replace(/\s+/g, " ").trim();
  console.log(`[msc] important-info interstitial present — accepting ("${label}")`);
  await proceed.click({ force: true }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2500);
  return true;
}

/**
 * Search the month containing sailDate and find the sailing matching
 * shipCode + exact date. Returns the matching row's raw checkbox value
 * (the same JSON shape used by the results page itself) or null.
 */
async function clearMscCart(page) {
  // Cancel any active WCS order via direct POST — using redirect:"manual" so
  // the browser never follows the /in/welcome redirect the server returns.
  // This cleans the server-side cart without changing the session locale.
  await page.evaluate(async () => {
    try {
      await fetch("/webapp/wcs/stores/servlet/AjaxCancelOrderCmd", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        redirect: "manual",
        body: new URLSearchParams({ storeId: "10254", requesttype: "ajax" }).toString(),
      });
    } catch {}
  }).catch(() => {});

  // Navigate home to reset the wizard flow / cart state.
  // If the session was redirected to a non-UK store (e.g. /in/ from a stale
  // redirect), force back to /uk/home so SearchCruiseV3 uses the GBR store.
  console.log("[msc] clearing cart: navigating to uk/home");
  await page.goto("https://www.mscbook.com/uk/home", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Verify we landed in the UK store — if not, navigate again explicitly
  if (!page.url().includes("/uk/")) {
    console.log(`[msc] clearMscCart: wrong locale (${page.url().split("?")[0]}) — forcing uk/home`);
    await page.goto("https://www.mscbook.com/uk/home", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  await dismissImportantInfo(page);
}

async function navigateToResultsPage(page, sailDate, { windowDays = null, shipCode = null } = {}) {
  await clearMscCart(page);

  // The results page's card layout only ever renders a fixed ~26-item
  // "curated" subset regardless of how wide the date search is — it is NOT
  // random/reloadable. A full-month search buries most sailings entirely.
  // Narrowing the window to a few days around the target date shrinks the
  // result set enough that the sailing we actually want reliably shows up.
  // Filtering by ship (when known) narrows it further still, for sailings
  // that don't surface even in a tightly-windowed date search.
  const from = windowDays
    ? ddmmyyyy(new Date(sailDate.getTime() - windowDays * 86400000))
    : ddmmyyyy(new Date(sailDate.getFullYear(), sailDate.getMonth(), 1));
  const to = windowDays
    ? ddmmyyyy(new Date(sailDate.getTime() + windowDays * 86400000))
    : ddmmyyyy(new Date(sailDate.getFullYear(), sailDate.getMonth() + 1, 0));

  const fromYmd = yyyymmdd(new Date(from.split("/").reverse().join("-")));
  const toYmd   = yyyymmdd(new Date(to.split("/").reverse().join("-")));
  const searchUrl = buildSearchUrl({ from: fromYmd, to: toYmd, ship: shipCode ?? "" });
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await dismissImportantInfo(page);
  // Wait for itinerary cards (new UI) or legacy table rows to appear (up to 20s)
  await page.waitForSelector(
    '[data-scroll-anchor="itinerary-card"], input[name="productId"], div[data-cruiseid]',
    { timeout: 20000 }
  ).catch(async () => {
    // Nothing rendered — try one more direct navigation
    console.log("[msc] results page: no cards after 20s, re-navigating");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await dismissImportantInfo(page);
    await page.waitForSelector(
      '[data-scroll-anchor="itinerary-card"], input[name="productId"], div[data-cruiseid]',
      { timeout: 20000 }
    ).catch(() => {});
  });
  await page.waitForTimeout(2000);
  console.log(`[msc] results page url: ${page.url().split("?")[0]}`);
}

// Table-layout fallback — only used when the card layout (matched by exact
// cruiseCode, see selectSailingViaCardLayout) isn't present.
async function scanTableForSailing(page, { shipCode, sailDate }) {
  const targetYYYYMMDD = `${sailDate.getFullYear()}${String(sailDate.getMonth() + 1).padStart(2, "0")}${String(sailDate.getDate()).padStart(2, "0")}`;

  for (let p = 0; p < 15; p++) {
    const target = await page.evaluate(({ shipCode, targetYYYYMMDD }) => {
      const cbs = [...document.querySelectorAll('input.checkbox.groupSailing')];
      // Debug: log first few checkbox values on page 0
      if (cbs.length > 0) {
        try {
          const sample = JSON.parse(cbs[0].value);
          console.debug("[msc-table] sample cb.value keys:", Object.keys(sample).join(","), "first shipCode:", sample.shipCode, "first sailDate:", sample.sailDateYYYYMMDD);
        } catch {}
      } else {
        console.debug("[msc-table] no input.checkbox.groupSailing found on page");
      }
      for (const cb of cbs) {
        try {
          const v = JSON.parse(cb.value);
          if (v.shipCode === shipCode && v.sailDateYYYYMMDD === targetYYYYMMDD) return v;
        } catch {}
      }
      return null;
    }, { shipCode, targetYYYYMMDD });
    if (target) return target;

    const nextBtn = page.locator('#sailingListTable_next');
    const disabled = await nextBtn.evaluate((el) => el.classList.contains("paginate_disabled_next")).catch(() => true);
    if (disabled) break;
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), nextBtn.click()]);
    await page.waitForTimeout(2000);
  }
  return null;
}

// The results page renders one of two layouts: MSC's redesigned Next.js
// "Cruise Search" (default) with itinerary cards, or the legacy dataTables
// checkbox table (reachable via the page's own "go to old layout" toggle,
// not used by us). On the redesigned card layout, each itinerary card
// (<div data-scroll-anchor="itinerary-card">) contains one
// <div data-cruiseid="..." data-pricecode="..."> price tile per sailing
// date. Confirmed live (network trace + manual booking through to a real
// cabin number) that clicking the "BOOK NOW" button inside that same card
// fires CruiseResultsSetCurrentOrderCmd → CabinSelectionView, the genuine
// booking-flow entry point. The older a[data-cruiseid] calendar-cell
// selector no longer exists anywhere on this UI — that mismatch (not any
// site-side block) was silently preventing every deck-data fetch before
// this fix.
async function selectSailingViaCardLayout(page, cruiseCode) {
  const cardInfo = await page.evaluate((code) => {
    const allTiles = [...document.querySelectorAll("div[data-cruiseid]")]
      .map(e => `div[data-cruiseid=${e.getAttribute("data-cruiseid")}]`)
      .slice(0, 5);
    const exactMatch = !!document.querySelector(`div[data-cruiseid="${code}"]`);
    return { allTiles, exactMatch };
  }, cruiseCode).catch(() => ({ allTiles: [], exactMatch: false }));
  console.log(`[msc] card layout — exact match for ${cruiseCode}: ${cardInfo.exactMatch}, sample tiles: ${cardInfo.allTiles.join(", ") || "none"}`);

  const tile = page.locator(`div[data-cruiseid="${cruiseCode}"]`).first();
  if (await tile.count() === 0) return false;

  const clicked = await page.evaluate((code) => {
    const tileEl = document.querySelector(`div[data-cruiseid="${code}"]`);
    const card = tileEl?.closest('[data-scroll-anchor="itinerary-card"]');
    const bookBtn = [...(card?.querySelectorAll("button, a") ?? [])].find(b => /book now/i.test(b.textContent || ""));
    if (!bookBtn) return false;
    bookBtn.scrollIntoView({ block: "center", behavior: "instant" });
    bookBtn.click();
    return true;
  }, cruiseCode);
  if (!clicked) throw new Error(`Found cruise ${cruiseCode} on the card layout but no BOOK NOW button nearby.`);

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(5000);
  console.log(`[msc] after BOOK NOW, url=${page.url().split("?")[0]}`);
  return true;
}

async function selectSailingViaTableLayout(page, target) {
  const checkboxId = await page.evaluate((key) => {
    const cbs = [...document.querySelectorAll('input.checkbox.groupSailing')];
    const match = cbs.find((cb) => {
      try { return JSON.parse(cb.value).key === key; } catch { return false; }
    });
    return match ? match.id : null;
  }, target.key);
  if (!checkboxId) throw new Error(`Sailing checkbox not found for key ${target.key}`);

  const idx = checkboxId.match(/checkbox-(\d+)/)?.[1];
  await page.locator(`label[for="${checkboxId}"]`).click();
  await page.waitForTimeout(1000);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator(`#sailingList${idx}1`).click({ force: true })
  ]);
  await page.waitForTimeout(5000);
}

/**
 * From the search-results page, reach the "1. Cabin selection" page for the
 * given sailing, supporting both result-page layouts.
 */
async function reachCabinSelectionPage(page, { cruiseCode, shipCode, sailDate }) {
  const viaCard = await selectSailingViaCardLayout(page, cruiseCode);
  if (viaCard) { await dismissCookieBanner(page); return; }

  const target = await scanTableForSailing(page, { shipCode, sailDate });
  if (target) { await selectSailingViaTableLayout(page, target); await dismissCookieBanner(page); return; }

  // A full-month search only ever shows a fixed curated ~26-card subset —
  // reloading the same wide search never surfaces a different one. Instead,
  // re-search with a progressively narrower date window so the target
  // sailing is one of only a handful of results and reliably renders.
  for (const windowDays of [5, 2]) {
    console.log(`[msc] sailing not in month-wide results — retrying with ±${windowDays}d window`);
    await navigateToResultsPage(page, sailDate, { windowDays });
    const viaCardNarrow = await selectSailingViaCardLayout(page, cruiseCode);
    if (viaCardNarrow) { await dismissCookieBanner(page); return; }
    const targetNarrow = await scanTableForSailing(page, { shipCode, sailDate });
    if (targetNarrow) { await selectSailingViaTableLayout(page, targetNarrow); await dismissCookieBanner(page); return; }
  }

  // Some sailings never surface even in a tightly-windowed date search (the
  // curated card list can omit specific embark-port/itinerary variants
  // entirely) — as a last resort, filter by ship as well, which shrinks the
  // result set to just that ship's sailings regardless of how the site
  // curates by date/destination.
  if (shipCode) {
    for (const windowDays of [10, 2]) {
      console.log(`[msc] still not found — retrying with ship filter (${shipCode}) + ±${windowDays}d window`);
      await navigateToResultsPage(page, sailDate, { windowDays, shipCode });
      const viaCardShip = await selectSailingViaCardLayout(page, cruiseCode);
      if (viaCardShip) { await dismissCookieBanner(page); return; }
      const targetShip = await scanTableForSailing(page, { shipCode, sailDate });
      if (targetShip) { await selectSailingViaTableLayout(page, targetShip); await dismissCookieBanner(page); return; }
    }
  }

  throw new Error(`Sailing not found on either layout (month-wide + narrowed + ship-filtered windows): cruiseCode=${cruiseCode} shipCode=${shipCode}`);
}

async function establishCartAndGetCategories(page, shipCode, cruiseCode) {
  console.log(`[msc] establishCart: url=${page.url().split("?")[0]}`);

  // Wait briefly so lazy-rendered CONFIRM SELECTION has time to appear
  await page.waitForTimeout(1500);
  const confirmBtn = page.locator("button:visible, a:visible").filter({ hasText: /CONFIRM SELECTION/i }).first();
  const confirmVisible = await confirmBtn.isVisible().catch(() => false);
  console.log(`[msc] CONFIRM SELECTION visible=${confirmVisible}`);

  // Capture promotionCode from network requests AND responses around CONFIRM SELECTION
  let capturedPromoCode = null;

  const extractPromo = (text) => {
    try {
      const stripped = text.replace(/^\s*\/\*/, "").replace(/\*\/\s*$/, "");
      const j = JSON.parse(stripped);
      const p = Array.isArray(j.promotionCode) ? j.promotionCode[0] : j.promotionCode;
      if (p && typeof p === "string" && p.length >= 8) return p;
    } catch {}
    // Match with or without quotes around key, handle array brackets
    const m = text.match(/promo(?:tion)?[Cc]ode["']?\s*[=:,\[\]]*\s*["']([A-Za-z0-9]{8,})/i);
    return m ? m[1] : null;
  };

  const promoReqHandler = (req) => {
    if (capturedPromoCode) return;
    try {
      const body = req.postData() ?? "";
      if (!body) return;
      const p = extractPromo(body) ?? new URLSearchParams(body).get("promotionCode");
      if (p && p.length >= 8) { capturedPromoCode = p; console.log(`[msc] promo found in REQUEST body: ${p} (${req.url().split("/").pop()})`); }
    } catch {}
  };

  const promoRespHandler = async (resp) => {
    if (capturedPromoCode) return;
    const u = resp.url();
    if (!u.includes("mscbook.com")) return;
    try {
      const t = await resp.text();
      const p = extractPromo(t);
      if (p) { capturedPromoCode = p; console.log(`[msc] promo found in RESPONSE: ${p} (${u.split("/").pop().split("?")[0]})`); }
    } catch {}
  };

  if (confirmVisible) {
    page.on("request", promoReqHandler);
    page.on("response", promoRespHandler);
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), confirmBtn.click({ force: true })]);
    await page.waitForTimeout(6000);
    page.off("request", promoReqHandler);
    page.off("response", promoRespHandler);
    await dismissCookieBanner(page);
    console.log(`[msc] after CONFIRM SELECTION, url=${page.url().split("?")[0]}${capturedPromoCode ? ` promo=${capturedPromoCode}` : " promo=NOT_FOUND"}`);
  }

  // Second pass: inspect page source for promo after CONFIRM SELECTION
  if (!capturedPromoCode) {
    const promoFromPage = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const m = html.match(/promo(?:tion)?[Cc]ode["']?\s*[=:,\[\]]*\s*["']([A-Za-z0-9]{8,})/i);
      if (m) return m[1];
      // Check cookies
      const c = document.cookie.match(/promo(?:tion)?[Cc]ode=([A-Za-z0-9]{8,})/i);
      if (c) return c[1];
      return null;
    }).catch(() => null);
    if (promoFromPage) {
      capturedPromoCode = promoFromPage;
      console.log(`[msc] promo found in page HTML/cookie: ${promoFromPage}`);
    }
  }

  // If the cart is dirty from a previous run, MSC may land us on the IDP/deck page directly.
  const onDeckPage = page.url().includes("CabinSelectionDeck") || page.url().includes("deckSelection");
  if (onDeckPage) {
    console.log("[msc] landed on deck page from dirty cart — navigating back");
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  // CONFIRM SELECTION sometimes only advances from the wizard-intro page to an
  // intermediate "1. Cabin selection" occupancy panel (Number of Guests, promo
  // code, etc.) rather than straight to the category grid — a SECOND click on
  // its own CONFIRM SELECTION button is needed to actually reach the grid.
  // Previously misdiagnosed as a "dirty cart" needing full retries; it's really
  // just one more expected wizard step.
  const onOccupancyPanel = await page.evaluate(() => /Number of Guests/i.test(document.body.innerText ?? ""));
  if (onOccupancyPanel) {
    // Cruises that call at a US port additionally require an age band for
    // every adult passenger (<select id="age-{cabin}-adult-{n}"> with a
    // blank default option) before CONFIRM SELECTION will actually advance —
    // confirmed live: without this, clicking CONFIRM SELECTION any number of
    // times just redisplays the same occupancy panel with 0 categories, which
    // used to be misread as this cruise having no availability at all.
    // Any unanswered dropdown on this panel silently blocks CONFIRM SELECTION:
    // the click is accepted, nothing navigates, and the grid reads as "0
    // categories" — which looked like the sailing having no availability. This
    // used to only fill selects whose id starts with "age-" (the US-port age
    // bands), so panels asking anything else stalled forever. Fill every empty
    // visible dropdown instead, still preferring an adult age band where the
    // options look like one.
    // The age widgets are custom comboboxes now (an input[type=search] inside a
    // styled dropdown), not native selects — a Miami sailing's dump showed the
    // two "Age" fields with ZERO <select> elements visible on the page, so the
    // old visible-selects fill never touched them and Confirm was silently
    // ignored. Custom comboboxes usually proxy a hidden native select, so fill
    // those first (no offsetParent filter), restricted to age-band-looking
    // options so we never set something consequential like a discount code.
    const fieldsFilled = await page.evaluate(() => {
      const looksLikeAgeBand = (o) => /^\s*\d+\s*(?:-\s*\d+|\+)\s*$/.test(o.text);
      const selects = [...document.querySelectorAll("select")].filter(
        s => !s.disabled && !s.value && [...s.options].some(looksLikeAgeBand)
      );
      const filled = [];
      for (const sel of selects) {
        const opts = [...sel.options].filter(o => o.value);
        if (opts.length === 0) continue;
        const best = opts.find(o => /21\s*\+/.test(o.text)) ?? opts[opts.length - 1];
        sel.value = best.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        filled.push(`${sel.id || sel.name || "?"}="${best.text.trim().slice(0, 20)}"`);
      }
      return filled;
    }).catch(() => []);
    if (fieldsFilled.length > 0) {
      console.log(`[msc] filled ${fieldsFilled.length} age dropdown(s) via native select: ${fieldsFilled.join(", ")}`);
      await page.waitForTimeout(800);
    } else {
      // No native select behind the widget — drive the combobox UI itself:
      // open each "Age" dropdown and pick the 21+ band (US-port sailings
      // require the primary passenger to be 21+, so 21+ is always safe).
      const ageWidgets = page.locator("div,span").filter({ hasText: /^Age$/ });
      const widgetCount = await ageWidgets.count().catch(() => 0);
      let clicked = 0;
      for (let w = 0; w < widgetCount && w < 6; w++) {
        const widget = ageWidgets.nth(w);
        if (!(await widget.isVisible().catch(() => false))) continue;
        await widget.click({ force: true }).catch(() => {});
        await page.waitForTimeout(600);
        // The open dropdown renders its options as li/div entries.
        const option = page
          .locator("li:visible, [role=option]:visible, .cs-select-option:visible, div:visible")
          .filter({ hasText: /^\s*21\s*\+\s*$/ })
          .first();
        if (await option.isVisible().catch(() => false)) {
          await option.click({ force: true }).catch(() => {});
          clicked++;
          await page.waitForTimeout(500);
        } else {
          // Close a dropdown we opened but couldn't fill, so it doesn't
          // swallow the next widget's click.
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
      if (clicked > 0) console.log(`[msc] filled ${clicked} age dropdown(s) via combobox UI`);
    }

    // The occupancy panel renders one CONFIRM SELECTION per cabin block plus the
    // real submit (three were seen live on a single-cabin sailing). Clicking
    // .first() hit a per-cabin button that doesn't advance the wizard, so the
    // grid never appeared and the three dirty-cart retries just repeated it.
    // Try each visible one, last first — the page-level submit sits after the
    // per-cabin controls — and stop as soon as the grid renders.
    const confirmButtons = page.locator("button:visible, a:visible").filter({ hasText: /CONFIRM SELECTION/i });
    const confirmCount = await confirmButtons.count().catch(() => 0);
    if (confirmCount > 0) {
      console.log(`[msc] on occupancy-selection panel — ${confirmCount} CONFIRM SELECTION button(s), trying last-first`);
      for (let i = confirmCount - 1; i >= 0; i--) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(() => {}),
          confirmButtons.nth(i).click({ force: true }).catch(() => {})
        ]);
        // An unaccepted "IMPORTANT INFO" notice blocks the wizard silently, so
        // clear it before deciding this click failed — otherwise the grid never
        // renders and the sailing is written off as having no availability.
        if (await acceptImportantInfo(page)) {
          await page.waitForSelector(".cs-price-box[data-category]", { timeout: 20000 }).catch(() => {});
        }
        // The grid can take noticeably longer than a fixed delay to render (a
        // "Loading" spinner was observed live) — wait for the price-box itself.
        await page.waitForSelector(".cs-price-box[data-category]", { timeout: 15000 }).catch(() => {});
        const gridUp = await page.locator(".cs-price-box[data-category]").count().catch(() => 0);
        if (gridUp > 0) { console.log(`[msc] category grid appeared after clicking button #${i + 1}`); break; }
        console.log(`[msc] button #${i + 1} did not reach the grid — trying the next one`);
      }
      await dismissCookieBanner(page);
      console.log(`[msc] after second CONFIRM SELECTION, url=${page.url().split("?")[0]}`);
    }
  }

  const categoryPriceByCode = await readCategoryPrices(page);
  const categoryCodes = Object.keys(categoryPriceByCode).length > 0
    ? Object.keys(categoryPriceByCode)
    : await page.evaluate(() =>
        [...new Set([...document.querySelectorAll(".cs-price-box[data-category]")].map((e) => e.getAttribute("data-category")))]
      );
  console.log(`[msc] category codes found: ${categoryCodes.length} (${Object.keys(categoryPriceByCode).length} priced), url=${page.url().split("?")[0]}`);

  if (categoryCodes.length === 0) {
    // Dirty-cart: MSC drops us on a later wizard step (cabin panel, add-ons, etc.)
    // Log state and try recovery with up to 3 attempts.
    const pageState = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll("button:not([style*='none']), a.btn:not([style*='none'])")]
        .map(b => b.textContent?.trim()?.slice(0, 40)).filter(Boolean).slice(0, 8),
      bodySnippet: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
    })).catch(() => ({}));
    console.log(`[msc] no categories — dirty-cart state: ${JSON.stringify(pageState)}`);

    // The 200-char snippet above kept truncating right before whatever is
    // actually blocking the wizard, which sent two rounds of fixes at the wrong
    // control type (the guest counter is a +/- stepper, not a <select>, so
    // "fill the empty dropdowns" had nothing to act on). Dump the full panel
    // once, to a file, so the next fix is based on the real DOM.
    if (process.env.MSC_DEBUG_DUMP) {
      try {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const dump = await page.evaluate(() => {
          const vis = (el) => el.offsetParent !== null;
          const txt = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
          return {
            url: location.href,
            buttons: [...document.querySelectorAll("button, a[role=button], a.btn, [class*=cta]")]
              .filter(vis).map(b => ({
                text: txt(b).slice(0, 50), disabled: b.disabled === true,
                ariaDisabled: b.getAttribute("aria-disabled"),
                cls: (b.className || "").toString().slice(0, 90)
              })),
            selects: [...document.querySelectorAll("select")].filter(vis)
              .map(s => ({ id: s.id, name: s.name, value: s.value, required: s.required })),
            inputs: [...document.querySelectorAll("input")].filter(vis)
              .map(i => ({ id: i.id, name: i.name, type: i.type, required: i.required,
                           value: (i.value || "").slice(0, 30), checked: i.checked })),
            errors: [...document.querySelectorAll("[class*=error],[class*=invalid],[role=alert],[class*=warning]")]
              .filter(vis).map(txt).filter(Boolean).slice(0, 15),
            // Hidden selects too — custom comboboxes often proxy one, and the
            // visible-only listing hid exactly the fields that were blocking.
            hiddenSelects: [...document.querySelectorAll("select")].filter(s => !vis(s))
              .map(s => ({ id: s.id, name: s.name, value: s.value,
                           options: [...s.options].slice(0, 6).map(o => o.text.trim()) })).slice(0, 10),
            // Raw markup of the age widgets, so the click target stops being a
            // guess. Grab the container around any element whose text is "Age".
            ageWidgetHtml: (() => {
              const leaf = [...document.querySelectorAll("*")].find(el =>
                el.children.length === 0 && (el.textContent || "").trim() === "Age" && vis(el));
              if (!leaf) return null;
              let box = leaf;
              for (let i = 0; i < 4 && box.parentElement; i++) box = box.parentElement;
              return box.outerHTML.slice(0, 3500);
            })(),
            bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 4000)
          };
        });
        await mkdir("./debug", { recursive: true });
        const stamp = `${cruiseCode ?? "unknown"}-${Date.now()}`;
        await writeFile(`./debug/msc-nocat-${stamp}.json`, JSON.stringify(dump, null, 2));
        await page.screenshot({ path: `./debug/msc-nocat-${stamp}.png`, fullPage: true }).catch(() => {});
        console.log(`[msc] wrote full panel dump → debug/msc-nocat-${stamp}.json/.png`);
      } catch (e) {
        console.log(`[msc] panel dump failed: ${e.message}`);
      }
    }

    for (let attempt = 1; attempt <= 3 && categoryCodes.length === 0; attempt++) {
      // Pause so any delayed button renders
      await page.waitForTimeout(1500);

      const currentUrl = page.url();

      // If Back previously sent us to the results list, re-click BOOK NOW for this cruise.
      // After the AjaxCancelOrderCmd in clearMscCart, the cart should be cleared and
      // BOOK NOW should land us on the category grid.
      if (currentUrl.includes("/uk/search/list") && cruiseCode) {
        console.log(`[msc] dirty-cart attempt ${attempt}: on results list — re-clicking BOOK NOW`);
        await page.evaluate((code) => {
          const tileEl = document.querySelector(`div[data-cruiseid="${code}"]`);
          const card = tileEl?.closest('[data-scroll-anchor="itinerary-card"]');
          const bookBtn = [...(card?.querySelectorAll("button, a") ?? [])].find(b => /book now/i.test(b.textContent || ""));
          if (bookBtn) { bookBtn.scrollIntoView({ block: "center", behavior: "instant" }); bookBtn.click(); }
        }, cruiseCode);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(4000);
        // Check for CONFIRM SELECTION on fresh booking
        const confirmFresh = page.locator("button:visible, a:visible").filter({ hasText: /CONFIRM SELECTION/i }).first();
        if (await confirmFresh.isVisible().catch(() => false)) {
          await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), confirmFresh.click({ force: true })]);
          await page.waitForTimeout(5000);
        }
      } else {
        // Detect which dirty-cart step we're on:
        // (a) Cabin-panel: body has "Number of Guests" → guest form open → Back
        // (b) Wizard intro "CONFIRM SELECTION" step → click it
        // (c) Add-ons step or other → Back
        const stepInfo = await page.evaluate(() => {
          const body = document.body.innerText ?? "";
          const isCabinPanel = /Number of Guests/i.test(body);
          const hasConfirmBtn = [...document.querySelectorAll("button:not([style*='none']), a.btn:not([style*='none'])")].some(b => /confirm selection/i.test(b.textContent));
          return { isCabinPanel, hasConfirmBtn };
        }).catch(() => ({ isCabinPanel: false, hasConfirmBtn: false }));

        // Clear an outstanding IMPORTANT INFO notice first: while one is up the
        // panel can't advance, so every retry below would just bounce off it.
        if (await acceptImportantInfo(page)) {
          await page.waitForSelector(".cs-price-box[data-category]", { timeout: 20000 }).catch(() => {});
        }

        // Confirm wins over Back whenever it's present. This used to require
        // !isCabinPanel, so a stuck cabin panel — the one case that actually
        // needs Confirm re-clicked — fell through to Back and simply
        // redisplayed itself, burning all three attempts on a no-op.
        if (stepInfo.hasConfirmBtn) {
          const confirmNow = page.locator("button:visible, a:visible").filter({ hasText: /CONFIRM SELECTION/i }).first();
          if (await confirmNow.isVisible().catch(() => false)) {
            console.log(`[msc] dirty-cart attempt ${attempt}: wizard CONFIRM SELECTION — clicking`);
            await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), confirmNow.click({ force: true })]);
            await page.waitForTimeout(4000);
          } else {
            console.log(`[msc] dirty-cart attempt ${attempt}: CONFIRM SELECTION off-screen — force evaluate click`);
            await page.evaluate(() => {
              const btn = [...document.querySelectorAll("button, a.btn")].find(b => /confirm selection/i.test(b.textContent));
              btn?.click();
            });
            await page.waitForTimeout(4000);
          }
        } else {
          const backBtn = page.locator("button:visible, a:visible").filter({ hasText: /^back$/i }).first();
          const backVisible = await backBtn.isVisible().catch(() => false);
          console.log(`[msc] dirty-cart attempt ${attempt}: Back visible=${backVisible}, isCabinPanel=${stepInfo.isCabinPanel}`);
          if (!backVisible) break;
          await backBtn.click({ force: true });
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      console.log(`[msc] after dirty-cart attempt ${attempt}, url=${page.url().split("?")[0]}`);
      const recovered = await page.evaluate(() =>
        [...new Set([...document.querySelectorAll(".cs-price-box[data-category]")].map(e => e.getAttribute("data-category")))]
      );
      console.log(`[msc] dirty-cart attempt ${attempt}: ${recovered.length} categories found`);
      if (recovered.length > 0) {
        categoryCodes.splice(0, 0, ...recovered);
        // Prices were read before this attempt, while the grid was still
        // absent, so the map is empty — re-read it now that the grid is up.
        // Without this a recovered sailing saves full cabin/deck data with
        // every category priced £0, which is how "deck info hai but price
        // nahi" sailings were getting written.
        const recoveredPrices = await readCategoryPrices(page);
        Object.assign(categoryPriceByCode, recoveredPrices);
        console.log(`[msc] dirty-cart attempt ${attempt}: re-read prices for ${Object.keys(recoveredPrices).length} categories`);
      }
    }

    if (categoryCodes.length === 0) {
      // Genuinely no bookable categories after Book Now + dirty-cart recovery —
      // capture whatever real status text MSC is showing (waitlist, sold out,
      // guarantee-only, etc.) so the failure reason is visible in logs/DB
      // instead of a blind "no categories" with no explanation.
      const statusInfo = await page.evaluate(() => {
        const body = document.body.innerText ?? "";
        const m = body.match(/wait ?list|sold ?out|no(?:t)? available|guarantee only|fully booked|closed for sale|no cabins? available/i);
        return { statusText: m ? m[0] : null, bodySnippet: body.replace(/\s+/g, " ").slice(0, 300) };
      }).catch(() => ({ statusText: null, bodySnippet: "" }));
      const reason = statusInfo.statusText
        ? `site shows "${statusInfo.statusText}"`
        : `no explicit status found, page snippet: ${statusInfo.bodySnippet}`;
      throw new Error(`No cabin categories found on this sailing's category grid (${reason}).`);
    }
  }

  const hasAvailable = await page.locator(".cs-price-box.cs-price-box-npm:not(.cs-no-aval)").count() > 0;
  console.log(`[msc] category grid: ${categoryCodes.length} codes, hasAvailableTile=${hasAvailable}`);

  // ── Cabin data via CruiseCabinAvailabilityCmd ──────────────────────────────
  // Call the endpoint directly for each category — richiesta=A auto-selects ONE
  // cabin per category and returns full deck/location info. We call this without
  // going through the "Select Real Cabin" UI flow, so CruiseCabinLockCmd and
  // CabinSelectionAddCabinOrder are never triggered and the cart stays clean.
  //
  // Auth params live in hidden inputs on the page. If not found there, we fall
  // back to clicking the "Select Real Cabin" button once to capture them from
  // the network response, then reuse them for all remaining categories.

  // 1. Extract auth params from page DOM and inline scripts.
  //    MSC uses abbreviated hidden-input names: authPwd / authAgId / authAgyId.
  //    The cruise ID comes from the URL partNumber param, not a form field.
  const pageAuth = await page.evaluate(() => {
    const getInput = (name) => document.querySelector(`input[name="${name}"]`)?.value ?? null;

    // Hidden form inputs — try full name first, then MSC's abbreviated variants
    const authPassword  = getInput("authPassword")  ?? getInput("authPwd");
    const authAgentId   = getInput("authAgentId")   ?? getInput("authAgId");
    const authAgencyId  = getInput("authAgencyId")  ?? getInput("authAgyId");
    const promotionCode = getInput("promotionCode") ?? getInput("promoCode");
    const storeId       = getInput("storeId")  ?? "10254";
    const catalogId     = getInput("catalogId") ?? "10001";
    const langId        = getInput("langId") ?? "-1";

    // cruiseID is the partNumber URL param on CabinSelectionView
    const cruiseID = getInput("cruiseID") ?? getInput("cruiseId")
      ?? new URLSearchParams(location.search).get("partNumber");

    // Inline <script> fallback for anything still missing
    const scriptText = [...document.querySelectorAll("script:not([src])")].map(s => s.textContent).join("\n");
    const extract = (re) => scriptText.match(re)?.[1] ?? null;
    const authPasswordF  = authPassword  ?? extract(/["']authP(?:assword|wd)["']\s*[=:,]\s*["']([0-9a-f]{20,})/i);
    const authAgentIdF   = authAgentId   ?? extract(/["']authAg(?:entId|Id)["']\s*[=:,]\s*["']([^"']{3,30})/i);
    const authAgencyIdF  = authAgencyId  ?? extract(/["']authAg(?:encyId|yId)["']\s*[=:,]\s*["']([^"']{3,20})/i);

    // promotionCode: try hidden inputs, window.CabinController props, then inline scripts
    const ctrlPromo = (() => {
      try {
        const cc = window.CabinController;
        return cc?.promotionCode ?? cc?.config?.promotionCode ?? cc?.params?.promotionCode
          ?? cc?.options?.promotionCode ?? cc?.promoCode ?? null;
      } catch { return null; }
    })();
    const promotionCodeF = promotionCode ?? ctrlPromo
      ?? extract(/["']promo(?:tion)?Code["']\s*[:=,]\s*["']([A-Za-z0-9]{8,})/i);

    return {
      authPassword: authPasswordF, authAgentId: authAgentIdF,
      authAgencyId: authAgencyIdF, promotionCode: promotionCodeF,
      cruiseID, storeId, catalogId, langId,
      NoofAdults: "2", NoofChildren: "0", NoofNeonati: "0",
      _hiddenNames: [...document.querySelectorAll("input[type='hidden']")]
        .map(i => i.name).filter(n => /auth|cruise|promo|store|catalog|lang|noof/i.test(n)).slice(0, 20),
    };
  }).catch(e => ({ error: e.message }));
  console.log(`[msc] page auth: pwd=${pageAuth.authPassword ? "found" : "null"} agent=${pageAuth.authAgentId} cruise=${pageAuth.cruiseID} promo=${pageAuth.promotionCode ?? "null"}`);

  let authParams = null;
  if (pageAuth.authPassword && pageAuth.authAgentId && pageAuth.cruiseID) {
    authParams = pageAuth;
    // Patch in promotionCode captured from CONFIRM SELECTION network responses if DOM had none
    if (!authParams.promotionCode && capturedPromoCode) {
      authParams = { ...authParams, promotionCode: capturedPromoCode };
      console.log(`[msc] promotionCode patched from network capture: ${capturedPromoCode}`);
    }
  }

  // 2. Fallback: click one category tile and "Select Real Cabin" to capture auth + promoCode
  //    Triggers when: (a) auth wasn't in DOM, OR (b) promotionCode is missing.
  //    The CruiseCabinAvailabilityCmd request body echoes the promotionCode the page JS uses.
  //    After capture, call AjaxCancelOrderCmd to clean the server-side cart.
  const needsPromo = authParams && !authParams.promotionCode;
  if ((!authParams || needsPromo) && hasAvailable) {
    const reason = !authParams ? "auth not in page DOM" : "promotionCode missing";
    console.log(`[msc] ${reason} — clicking category tile to capture from panel/network`);
    const availableTile = page.locator(".cs-price-box.cs-price-box-npm:not(.cs-no-aval)").first();
    await availableTile.click({ force: true });
    await page.waitForTimeout(2000);

    // First: check if the tile panel loaded any hidden inputs with promotionCode
    const panelPromo = await page.evaluate(() => {
      const getInput = (n) => document.querySelector(`input[name="${n}"]`)?.value ?? null;
      return getInput("promotionCode") ?? getInput("promoCode") ?? null;
    }).catch(() => null);

    if (panelPromo) {
      console.log(`[msc] promotionCode found in panel DOM: ${panelPromo}`);
      if (authParams) authParams = { ...authParams, promotionCode: panelPromo };
    } else {
      // Capture from the CruiseCabinAvailabilityCmd REQUEST body (contains the promo the page JS had)
      const realCabinBtn = page.locator("button.real-cabin-btn:visible, button:has-text('Select Real Cabin'):visible, a.real-cabin-btn:visible").first();
      if (await realCabinBtn.count() > 0) {
        let capturedAvailBody = null;
        let capturedAvailResp = null;
        const availReqHandler = (req) => {
          if (!capturedAvailBody && req.url().includes("CruiseCabinAvailabilityCmd")) {
            capturedAvailBody = req.postData() ?? "";
          }
        };
        const availRespHandler = async (resp) => {
          if (!capturedAvailResp && resp.url().includes("CruiseCabinAvailabilityCmd")) {
            try { capturedAvailResp = await resp.text(); } catch {}
          }
        };
        page.on("request", availReqHandler);
        page.on("response", availRespHandler);
        await realCabinBtn.click({ force: true });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        page.off("request", availReqHandler);
        page.off("response", availRespHandler);
        await dismissCookieBanner(page);

        // Extract from request body first (direct, reliable)
        const promoFromReq = capturedAvailBody
          ? new URLSearchParams(capturedAvailBody).get("promotionCode") : null;

        if (capturedAvailResp) {
          try {
            const j = JSON.parse(capturedAvailResp.replace(/^\s*\/\*/, "").replace(/\*\/\s*$/, ""));
            const promoFromResp = j.promotionCode?.[0] ?? "";
            const capturedAuth = {
              authPassword:  j.authPassword?.[0]  ?? "",
              authAgentId:   j.authAgentId?.[0]   ?? "",
              authAgencyId:  j.authAgencyId?.[0]  ?? "",
              promotionCode: promoFromReq ?? promoFromResp,
              cruiseID:      j.cruiseID?.[0]       ?? "",
              storeId:       j.storeId ?? "10254",
              catalogId:     j.catalogId ?? "10001",
              langId:        Array.isArray(j.langId) ? j.langId[0] : (j.langId ?? "-1"),
              NoofAdults:    j.NoofAdults?.[0]  ?? "2",
              NoofChildren:  j.NoofChildren?.[0] ?? "0",
              NoofNeonati:   j.NoofNeonati?.[0]  ?? "0",
            };
            if (needsPromo && authParams) {
              // Only patch the promotionCode, keep existing auth fields
              authParams = { ...authParams, promotionCode: capturedAuth.promotionCode };
              console.log(`[msc] promotionCode from availability cmd: ${capturedAuth.promotionCode}`);
            } else {
              authParams = capturedAuth;
            }
            const firstCabin = j.DtsCruiseCabinAvailabilityResponse?.availableCabins?.availableCabin?.[0];
            if (firstCabin) console.log(`[msc] captured auth from network; first cabin: ${JSON.stringify(firstCabin)}`);
          } catch(e) { console.log(`[msc] avail parse error: ${e.message}`); }
        } else if (promoFromReq) {
          // Got promo from request body even if response parse failed
          if (authParams) authParams = { ...authParams, promotionCode: promoFromReq };
          else authParams = { ...(pageAuth ?? {}), promotionCode: promoFromReq };
          console.log(`[msc] promotionCode from request body only: ${promoFromReq}`);
        }

        // Clean the server-side cart — clicking "Select Real Cabin" adds a cabin
        await page.evaluate(async () => {
          try {
            await fetch("/webapp/wcs/stores/servlet/AjaxCancelOrderCmd", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              credentials: "include",
              redirect: "manual",
              body: new URLSearchParams({ storeId: "10254", requesttype: "ajax" }).toString(),
            });
          } catch {}
        }).catch(() => {});
        console.log("[msc] cart cleaned after availability cmd capture");
      }
    }
  }

  // 3. Call CruiseCabinAvailabilityCmd for each category to get one auto-selected cabin
  const cabinsByCategory = {};
  if (authParams?.authPassword) {
    console.log(`[msc] fetching cabin availability for ${categoryCodes.length} categories...`);
    for (const catCode of categoryCodes) {
      const result = await page.evaluate(async (p) => {
        const body = new URLSearchParams({
          storeId: p.storeId, catalogId: p.catalogId, langId: p.langId,
          authPassword: p.authPassword, authAgentId: p.authAgentId, authAgencyId: p.authAgencyId,
          cabinId: "1", cabinAccessibility: "", physicallyChallenged: "",
          NoofAdults: p.NoofAdults, NoofChildren: p.NoofChildren, NoofNeonati: p.NoofNeonati,
          cruiseID: p.cruiseID, promotionCode: p.promotionCode,
          bookingContactName: "test", categoryCode: p.categoryCode,
          requesttype: "ajax", richiesta: "A", tipoComando: "ordercabin",
          cabina: "1", searchedCabinNo: "", cabinConnected: "",
          cabinconnectingRooms: "0", connectedCabins: "",
        });
        try {
          const r = await fetch("/webapp/wcs/stores/servlet/CruiseCabinAvailabilityCmd", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            credentials: "include",
            body: body.toString(),
          });
          const t = await r.text();
          const j = JSON.parse(t.replace(/^\s*\/\*/, "").replace(/\*\/\s*$/, ""));
          return { cabins: j.DtsCruiseCabinAvailabilityResponse?.availableCabins?.availableCabin ?? [], err: null };
        } catch (e) { return { cabins: [], err: e.message }; }
      }, { ...authParams, categoryCode: catCode }).catch(e => ({ cabins: [], err: e.message }));

      cabinsByCategory[catCode] = result.cabins;
      const nums = result.cabins.map(c => c.cabinNo).join(",");
      console.log(`[msc] avail ${catCode}: ${result.cabins.length} cabin(s)${result.err ? " err="+result.err : ""}${nums ? " ["+nums+"]" : ""}`);
    }
  } else {
    console.log("[msc] no auth params — cabin availability skipped");
  }

  return { categoryCodes, cabinsByCategory, categoryPriceByCode };
}

// Cabin numbers are deck-prefixed (e.g. "15008" -> deck 15, "5001" -> deck 5):
// everything but the last 3 digits is the deck number.
function deckFromCabinNumber(cabinNumber) {
  const s = String(cabinNumber);
  if (s.length <= 3) return null;
  return Number(s.slice(0, -3));
}

async function fetchCategoryDeckData(page, shipCode, categoryCabin, baseParams = null) {
  const params = {
    storeId: "10254", catalogId: "10001", langId: "-1",
    shipCode, cabinId: "1", categoryCabin,
    requesttype: "ajax",
    ...(baseParams ?? { deskConfigCode: "O8" }),
    categoryCabin, // always override
  };
  const body = new URLSearchParams(params).toString();

  const res = await page.evaluate(async (body) => {
    const r = await fetch("/webapp/wcs/stores/servlet/CabinSelectionCabinListDescriptionCmd", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
    });
    return { status: r.status, text: await r.text() };
  }, body);

  const json = JSON.parse(res.text.replace(/^\s*\/\*/, "").replace(/\*\/\s*$/, ""));
  const cabinNumbers = json.allCabinNumByCtg ?? [];
  const descriptions  = json.cabinDescriptions ?? {};
  console.log(`[msc] deck fetch ${categoryCabin}: HTTP ${res.status}, cabins=${cabinNumbers.length}, jsonKeys=${Object.keys(json).slice(0, 6).join(",")}, snippet="${res.text.slice(0,80).replace(/\s+/g," ")}"`);

  const byDeck = new Map();
  for (const num of cabinNumbers) {
    const desc       = descriptions[String(num)];
    const deckNumber = desc?.deckNumber ? Number(desc.deckNumber) : deckFromCabinNumber(num);
    const deckName   = desc?.deckName ?? null;
    const deckKey     = String(deckNumber);
    if (!byDeck.has(deckKey)) byDeck.set(deckKey, { deckNumber, deckName, cabins: [] });
    byDeck.get(deckKey).cabins.push({
      number:             num,
      occupancy:          desc?.occupancy ?? null,
      obstructedView:     desc?.obstructedView === "yes",
      phisicallyChallenged: desc?.phisicallyChallenged === "yes",
      squareMeters:       desc?.squareMeters ?? null,
      facilities:         desc?.facilities ?? [],
    });
  }

  return [...byDeck.values()].sort((a, b) => (a.deckNumber ?? 0) - (b.deckNumber ?? 0));
}

/**
 * Fetch full deck/cabin-level detail for one MSC sailing, merged with
 * category-level pricing from the bulk search endpoint. One-time wizard
 * click establishes cart context; every category after that is a single
 * fast direct POST (~1s each vs ~30s/category via UI).
 *
 * Returns a flat cabinCategories array matching the shape
 * buildCabinCategoryCreateInput expects (cabins: [{cabinNumber, deckNumber,
 * deckName, capacity, status}]).
 */
export async function fetchMscVoyageDetails({ cruiseCode, shipCode, sailDate, occupancy = { adults: 2, children: 0, juniors: 0, infants: 0 } }) {
  return runExclusiveMsc(async () => {
    const session = await getOrCreateMscSession();
    const { page } = session;

    await ensureMscAuthentication(session);

    // Pricing comes from the bulk month search — find this exact cruise in it.
    const rangeStart = new Date(sailDate.getFullYear(), sailDate.getMonth(), 1);
    const rangeEnd   = new Date(sailDate.getFullYear(), sailDate.getMonth() + 1, 0);
    const range = { from: ddmmyyyy(rangeStart), to: ddmmyyyy(rangeEnd), _fromDate: rangeStart, _toDate: rangeEnd };
    const monthCruises = await fetchOneRange(page, range, occupancy);
    const priced = monthCruises.find((c) => c.id === cruiseCode);
    const priceByCode = new Map((priced?.cabinCategories ?? []).map((c) => [c.code, c]));
    console.log(`[msc] pricing lookup: ${priced ? `found ${priceByCode.size} priced categories` : "cruise not found in month search"}`);

    await navigateToResultsPage(page, sailDate);
    await reachCabinSelectionPage(page, { cruiseCode, shipCode, sailDate });

    const { categoryCodes, cabinsByCategory, categoryPriceByCode } = await establishCartAndGetCategories(page, shipCode, cruiseCode);
    const totalCabins = Object.values(cabinsByCategory).reduce((s, arr) => s + arr.length, 0);
    console.log(`[msc] established cart context — ${categoryCodes.length} categories, ${totalCabins} auto-selected cabins`);

    const cabinCategories = [];
    for (const code of categoryCodes) {
      const priceInfo = priceByCode.get(code);
      const avlCabins = cabinsByCategory[code] ?? [];
      const cabinPrice = categoryPriceByCode?.[code] ?? priceInfo?.cabinPrice ?? null;

      const cabins = avlCabins.map((c) => ({
        cabinNumber: String(c.cabinNo),
        deckNumber:  c.deckNumber ? Number(c.deckNumber) : deckFromCabinNumber(c.cabinNo),
        deckName:    c.deckName ?? null,
        capacity:    null,
        status:      c.allocated === "Y" ? "Available" : "Occupied",
      }));

      cabinCategories.push({
        code,
        name:           priceInfo?.name ?? code,
        group:          priceInfo?.group ?? inferCabinGroup(code),
        status:         priceInfo?.status ?? (avlCabins.length > 0 ? "Available" : "Unknown"),
        avlResult:      priceInfo?.avlResult ?? (avlCabins.length > 0 ? "OK" : null),
        avail:          priceInfo?.avail ?? avlCabins.length,
        cabinPrice,
        perPersonPrice: priceInfo?.perPersonPrice ?? null,
        confidence:     avlCabins.length > 0 ? "High" : priceInfo ? "Medium" : "Low",
        promos:         priceInfo?.promos ?? [],
        cabins,
      });
    }

    return cabinCategories;
  });
}
