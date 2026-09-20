import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";
import { ensureVendor, ingestCruise } from "../../services/cruiseIngestionService.js";
import { enrichCruisesWithItineraries } from "./gocclItinerary.js";
import prisma from "../../config/prisma.js";

dotenv.config();

const USERNAME = process.env.GOCCL_USER;
const PASSWORD = process.env.GOCCL_PASS;
const LOGIN_URL = "https://www.goccl.com/";

async function ensureGocclAuthentication(session) {
  const { page } = session;

  if (!USERNAME || !PASSWORD) {
    throw new Error(
      "GOCCL_USER and GOCCL_PASS must be set in .env before using the GOCCL scraper."
    );
  }

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded"
  });
  console.log("[goccl] login page loaded", await page.url());

  const usernameField = page.locator("#username");
  const passwordField = page.locator("#password");
  const loginPageVisible = page.url().toLowerCase().includes("/accounts/login");

  if (!loginPageVisible) {
    console.log("[goccl] existing session detected");
    return {
      success: true,
      alreadyLoggedIn: true,
      message: "GOCCL session appears to be active."
    };
  }

  const cookieAcceptButton = page.locator("#onetrust-accept-btn-handler");
  if (await cookieAcceptButton.isVisible().catch(() => false)) {
    await cookieAcceptButton.click().catch(() => null);
  }

  await usernameField.waitFor({
    state: "visible",
    timeout: 30000
  });
  await passwordField.waitFor({
    state: "visible",
    timeout: 30000
  });

  const loginFormVisible = await usernameField.isVisible().catch(() => false);

  if (!loginFormVisible) {
    throw new Error("GOCCL login form did not become visible.");
  }

  await usernameField.fill(USERNAME);
  await passwordField.fill(PASSWORD);
  console.log("[goccl] credentials filled");

  const signInButton = page.locator('button[type="submit"]').filter({
    hasText: /sign in/i
  });

  await signInButton.click();
  await Promise.race([
    page.waitForURL((url) => !url.toString().includes("/login"), {
      timeout: 30000
    }).catch(() => null),
    page
      .locator("text=Forgot your login details?")
      .waitFor({ state: "hidden", timeout: 30000 })
      .catch(() => null),
    page.waitForTimeout(5000)
  ]);
  console.log("[goccl] post-login wait finished", await page.url());

  const loginSucceeded =
    (await page
      .locator("text=Forgot your login details?")
      .isVisible()
      .catch(() => false)) === false;

  if (!loginSucceeded) {
    throw new Error(
      "GOCCL login was not confirmed. Please verify the credentials or selectors."
    );
  }

  await session.persistAuthState();
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(2000);
  console.log("[goccl] login successful");

  return {
    success: true,
    alreadyLoggedIn: false,
    message: "GOCCL login successful."
  };
}

function unique(values = []) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function addDays(value, days) {
  if (!value || !Number.isFinite(Number(days))) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString();
}

function inferCabinType(code, name) {
  const upperCode = code?.toUpperCase() ?? "";
  const upperName = name?.toUpperCase() ?? "";

  if (!upperCode && !upperName) {
    return null;
  }

  if (upperName.includes("BALCONY")) {
    return "Balcony";
  }

  if (upperName.includes("SUITE")) {
    return "Suite";
  }

  if (upperName.includes("OCEAN") || upperName.includes("VIEW") || upperName.includes("EXTERIOR") || upperName.includes("OUTSIDE")) {
    return "Exterior";
  }

  if (upperName.includes("INTERIOR") || upperName.includes("INSIDE") || upperName.includes("UPPER") || upperName.includes("LOWER")) {
    return "Interior";
  }

  if (upperCode.startsWith("I") || upperCode === "UL") {
    return "Interior";
  }

  if (upperCode.startsWith("B")) {
    return "Balcony";
  }

  if (upperCode.startsWith("O")) {
    return "Exterior";
  }

  if (upperCode.startsWith("S")) {
    return "Suite";
  }

  return null;
}

function buildRouteLabel(portFrom, portTo) {
  if (!portFrom && !portTo) {
    return null;
  }

  return `${portFrom ?? "Unknown"} -> ${portTo ?? "Unknown"}`;
}

function buildCabinStatus(stateroom) {
  return stateroom.isSoldOut ? "Sold Out" : "Available";
}

function buildCabinAvailabilityResult(stateroom) {
  return stateroom.isSoldOut ? "SLD" : "OK";
}

function buildCabinPromotions(stateroom) {
  const codes = [
    stateroom.offerCode,
    ...(stateroom.additionaBenefitCodes ?? [])
  ];

  return unique(codes);
}

function buildCabinClassifications(stateroom) {
  const normalizedType = inferCabinType(
    stateroom.categoryCode ?? stateroom.code,
    stateroom.name
  );
  const classifications = [];

  if (normalizedType) {
    classifications.push({
      linkType: "WEB",
      code: normalizedType.toUpperCase(),
      name: normalizedType,
      description: normalizeString(stateroom.name),
      rank: null,
      shipCode: null
    });
  }

  if (stateroom.termsAndConditions?.rateName) {
    classifications.push({
      linkType: "RATE",
      code: String(stateroom.termsAndConditions.rateName).toUpperCase().replace(/\s+/g, "_"),
      name: stateroom.termsAndConditions.rateName,
      description: stateroom.termsAndConditions.disclaimer ?? null,
      rank: null,
      shipCode: null
    });
  }

  for (const benefit of stateroom.termsAndConditions?.benefits ?? []) {
    const benefitCode = [benefit.type, benefit.subtype].filter(Boolean).join("_");

    if (!benefitCode && !benefit.text) {
      continue;
    }

    classifications.push({
      linkType: "BENEFIT",
      code: benefitCode || String(benefit.text).toUpperCase().replace(/\s+/g, "_"),
      name: benefit.text ?? null,
      description: benefit.text ?? null,
      rank: null,
      shipCode: null
    });
  }

  if (stateroom.offerCode) {
    classifications.push({
      linkType: "OFFER",
      code: stateroom.offerCode,
      name: stateroom.offerCode,
      description: null,
      rank: null,
      shipCode: null
    });
  }

  return unique(
    classifications
      .filter((entry) => entry.code)
      .map((entry) => JSON.stringify(entry))
  ).map((entry) => JSON.parse(entry));
}

function toCodeSuffix(value) {
  return normalizeString(value)?.toUpperCase().replace(/[^A-Z0-9]+/g, "_") ?? null;
}

function buildUniqueCabinCode(baseCode, cabinName, cabinType, usedCodes) {
  const normalizedBaseCode = normalizeString(baseCode) ?? "UNKNOWN";

  if (!usedCodes.has(normalizedBaseCode)) {
    usedCodes.add(normalizedBaseCode);
    return normalizedBaseCode;
  }

  const suffixCandidates = [toCodeSuffix(cabinType), toCodeSuffix(cabinName)].filter(Boolean);

  for (const suffix of suffixCandidates) {
    const candidate = `${normalizedBaseCode}_${suffix}`;

    if (!usedCodes.has(candidate)) {
      usedCodes.add(candidate);
      return candidate;
    }
  }

  let counter = 2;
  while (usedCodes.has(`${normalizedBaseCode}_${counter}`)) {
    counter += 1;
  }

  const fallbackCandidate = `${normalizedBaseCode}_${counter}`;
  usedCodes.add(fallbackCandidate);
  return fallbackCandidate;
}

function inferCabinConfidence(stateroom) {
  if (
    stateroom?.code &&
    stateroom?.name &&
    stateroom?.price?.amount !== null &&
    stateroom?.price?.amount !== undefined
  ) {
    return "High";
  }

  if (stateroom?.code || stateroom?.name) {
    return "Medium";
  }

  return "Low";
}

function inferCruiseConfidence(sailing) {
  if (
    sailing?.id &&
    sailing?.ship?.code &&
    sailing?.departureDate?.iso8601WithTime &&
    (sailing?.staterooms?.length ?? 0) > 0
  ) {
    return "High";
  }

  if ((sailing?.staterooms?.length ?? 0) > 0) {
    return "Medium";
  }

  return "Low";
}

function buildCruisePromotions(sailing) {
  return unique(
    (sailing.staterooms ?? []).flatMap((stateroom) => buildCabinPromotions(stateroom))
  );
}

function isSailingSoldOut(sailing) {
  if (typeof sailing?.isSoldOut === "boolean") {
    return sailing.isSoldOut;
  }

  const staterooms = sailing?.staterooms ?? [];

  if (staterooms.length === 0) {
    return false;
  }

  return staterooms.every((stateroom) => stateroom?.isSoldOut === true);
}

function normalizeGocclSailing(sailing, currencyCode) {
  const portFrom = sailing.departurePort?.code ?? null;
  // destination.code is a marketing region ("GE" Getaway, "MI", "XS"), not an
  // arrival port — using it as portTo wrote junk like "sydney -> mi" onto every
  // one-way sailing. Leave it unknown here; the itinerary pass fills the real
  // debark port from the last scheduled call.
  const portTo = sailing.isRoundTrip
    ? portFrom
    : sailing.arrivalPort?.code ?? null;
  const soldOut = isSailingSoldOut(sailing);
  const staterooms = sailing.staterooms ?? [];
  const availableStaterooms = staterooms.filter((stateroom) => stateroom?.isSoldOut !== true);
  const startDate =
    sailing.departureDate?.iso8601WithTime ??
    sailing.departureDate?.rawValue ??
    null;
  const nights = normalizeInteger(sailing.duration);
  const endDate = addDays(startDate, nights);
  const usedCabinCodes = new Set();

  return {
    id: sailing.id,
    ship: sailing.ship?.name ?? sailing.ship?.code ?? null,
    shipCode: sailing.ship?.code ?? null,
    shipDetails: sailing.ship
      ? {
          name: sailing.ship.name ?? sailing.ship.code ?? null
        }
      : null,
    package: `${sailing.destination?.name ?? "Cruise"} - ${nights ?? ""}N`.trim(),
    portFrom,
    portTo,
    routeLabel: buildRouteLabel(portFrom, portTo),
    nights,
    startDate,
    endDate,
    seatsAvailable: soldOut ? 0 : 1,
    totalCapacity: 1,
    totalCabins: staterooms.length || null,
    trend: null,
    confidence: inferCruiseConfidence(sailing),
    pinned: false,
    currency: currencyCode ?? staterooms?.[0]?.price?.currencyCode ?? null,
    promotions: buildCruisePromotions(sailing),
    cabinCategories: staterooms.map((stateroom) => {
      const cabinName = stateroom.name ?? stateroom.code ?? null;
      const cabinType = inferCabinType(stateroom.code ?? stateroom.categoryCode, stateroom.name);
      const cabinCode = buildUniqueCabinCode(
        stateroom.categoryCode ?? stateroom.code,
        cabinName,
        cabinType,
        usedCabinCodes
      );

      return {
        code: cabinCode,
        name: cabinName,
        group: cabinType,
        status: buildCabinStatus(stateroom),
        avlResult: buildCabinAvailabilityResult(stateroom),
        total: 1,
        avail: stateroom.isSoldOut ? 0 : 1,
        cabinPrice: stateroom.price?.amount ?? null,
        perPersonPrice: stateroom.price?.amount ?? null,
        voyageFare: stateroom.price?.amount ?? null,
        portCharges: stateroom.taxesAndFees?.amount ?? null,
        capacity: null,
        childBeds: null,
        trend: null,
        range7d: null,
        confidence: inferCabinConfidence(stateroom),
        promos: buildCabinPromotions(stateroom),
        classifications: buildCabinClassifications(stateroom)
      };
    }),
    rawPayload: {
      ...sailing,
      derived: {
        soldOut,
        availableStateroomCount: availableStaterooms.length,
        totalStateroomCount: staterooms.length
      }
    }
  };
}

async function fetchGocclCruises(page, options = {}) {
  const {
    sailingDateFrom = "032026",
    sailingDateTo = "032026",
    currencyCode = "GBP",
    amountOfGuests = 2
  } = options;

  let pageNumber = 1;
  let lastPage = 1;
  const extracted = [];
  const apiBaseUrl = new URL(page.url()).origin;

  do {
    console.log(
      `[goccl] requesting sailings page ${pageNumber} for ${sailingDateFrom}-${sailingDateTo}`
    );
    const result = await page.evaluate(
      async ({ amountOfGuests, apiBaseUrl, currencyCode, pageNumber, sailingDateFrom, sailingDateTo }) => {
        const params = new URLSearchParams({
          amountOfGuests: String(amountOfGuests),
          couponCode: "",
          currencyCode,
          excludeResults: "false",
          includeInterline: "false",
          includeMilitary: "false",
          includeSenior: "false",
          pageNumber: String(pageNumber),
          sailingDateFrom,
          sailingDateTo,
          stateOfResidency: "",
          vifpLevels: "",
          vifpNumbers: ""
        });

        const response = await fetch(
          `${apiBaseUrl}/app/cruise-search/api/v1.0/cruises?${params.toString()}`,
          {
            credentials: "include",
            headers: {
              accept: "application/json, text/plain, */*"
            }
          }
        );

        const json = await response.json();

        return {
          status: response.status,
          json
        };
      },
      {
        amountOfGuests,
        apiBaseUrl,
        currencyCode,
        pageNumber,
        sailingDateFrom,
        sailingDateTo
      }
    );

    if (result.status !== 200) {
      throw new Error(`GOCCL cruise search failed with status ${result.status}`);
    }

    extracted.push(result.json);
    lastPage = result.json.pagination?.lastPage ?? 1;
    console.log(
      `[goccl] fetched sailings page ${pageNumber}/${lastPage} (${result.json.sailings?.length ?? 0} sailings)`
    );
    pageNumber += 1;
  } while (pageNumber <= lastPage);

  const sailings = extracted.flatMap((entry) => entry.sailings ?? []);
  console.log(`[goccl] total raw sailings fetched: ${sailings.length}`);

  return {
    extracted,
    cruises: sailings.map((sailing) => normalizeGocclSailing(sailing, currencyCode))
  };
}

// ── Per-cruise rate enrichment via UI clicks ────────────────────────────────
// /availability/rate returns 200 only when triggered by the SPA's own SELECT
// SAILING click (direct fetches return 400 with empty body). So we drive the UI:
// visit /search-results, click each SELECT SAILING button, capture the rate
// response, then merge onto the matching cruise from /cruises by fingerprint.

const SAILING_FINGERPRINT = (sailDate, shipCode, duration) =>
  `${sailDate}|${shipCode}|${duration}`;

function buildCruiseFingerprint(cruise) {
  const sd = (cruise.startDate ?? "").slice(0, 10);
  return SAILING_FINGERPRINT(sd, cruise.shipCode, cruise.nights);
}

function mapMetaCodeToType(code, name) {
  const c = String(code ?? "").toUpperCase();
  const n = String(name ?? "").toUpperCase();
  if (c === "SU" || n.includes("SUITE")) return "Suite";
  if (c === "OB" || n.includes("BALCONY")) return "Balcony";
  if (c === "OS" || n.includes("OCEAN") || n.includes("EXTERIOR") || n.includes("OUTSIDE")) return "Exterior";
  if (c === "IS" || n.includes("INTERIOR") || n.includes("INSIDE")) return "Interior";
  if (c === "UL" || n.includes("UPPER") || n.includes("LOWER")) return "Interior";
  return null;
}

function buildCabinCategoriesFromRate(rateJson) {
  const out = [];
  for (const rate of rateJson?.rates ?? []) {
    const rateCode = rate.code ?? "RATE";
    const rateName = rate.name ?? rate.code ?? "";
    for (const meta of rate.metaPrices ?? []) {
      const cabinTypeCode = meta.code ?? "";
      const cabinTypeName = meta.name ?? "";
      const type = mapMetaCodeToType(cabinTypeCode, cabinTypeName);
      const sold = meta.isSoldOut === true;
      const price = meta.price?.amount ?? null;
      const benefits = (meta.termsAndConditions?.benefits ?? []).map((b) => b.text).filter(Boolean);
      const offerCode = (meta.termsAndConditions?.finePrint ?? [])
        .find((p) => p.type === "OfferCode")?.text?.replace(/^Offer Code:\s*/i, "");

      out.push({
        code: `${rateCode}_${cabinTypeCode}`,
        name: `${cabinTypeName} (${rateName})`,
        group: type,
        status: sold ? "Sold Out" : "Available",
        avlResult: sold ? "SLD" : "OK",
        total: 1,
        avail: sold ? 0 : 1,
        // A sold-out rate reports 0, which reads downstream as "costs nothing"
        // (90 such rows in the DB, all status=Sold Out / avail=0). Unknown is
        // null, not zero.
        cabinPrice: sold || price === 0 ? null : price,
        perPersonPrice: sold || price === 0 ? null : price,
        capacity: null,
        trend: null,
        confidence: price !== null ? "High" : "Low",
        promos: unique([offerCode, rateCode, ...benefits]),
      });
    }
  }
  return out;
}

async function enrichWithRates(page, options = {}) {
  const { maxCruises = 10, maxClicks = 60 } = options;
  const apiBaseUrl = new URL(page.url()).origin;

  // Prime the booking-engine session once
  console.log(`[goccl] priming /app/bookingengine`);
  await page.goto(`${apiBaseUrl}/app/bookingengine`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);

  // /search-results sorts by nearest sail date. Click-iteration captures whatever
  // is at the top — those will be sailings 0-30 days out from today. Cruises
  // matching those should also be in the /cruises result set (filter for current
  // + next month to get good fingerprint overlap).
  const searchResultsUrl = `${apiBaseUrl}/app/bookingengine/search-results?amountOfGuests=2&birthDates=&coupon=&currencyCode=GBP&currencySymbol=%C2%A3&includeInterline=false&includeMilitary=false&includeSenior=false&sailingDate=&shipCode=&stateOfResidency=&vifpLevels=&vifpNumbers=`;

  // Navigate to search results ONCE; iterate buttons in place.
  console.log(`[goccl] loading search-results page`);
  await page.goto(searchResultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(8000);

  const captured = new Map();

  for (let i = 0; i < maxClicks && captured.size < maxCruises; i++) {
    let buttons = page.locator('button[data-component="search-results-select-sailing__select"]');
    let btnCount = await buttons.count();

    // If buttons disappeared (SPA navigated away after a successful 200), reload search results
    if (btnCount === 0 || i >= btnCount) {
      console.log(`[goccl] reloading search-results (btnCount=${btnCount}, i=${i})`);
      await page.goto(searchResultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(8000);
      buttons = page.locator('button[data-component="search-results-select-sailing__select"]');
      btnCount = await buttons.count();
      if (btnCount === 0) {
        console.log(`[goccl] no SELECT SAILING buttons after reload — stopping`);
        break;
      }
      if (i >= btnCount) {
        console.log(`[goccl] reached end of buttons (i=${i}, count=${btnCount})`);
        break;
      }
    }

    const btn = buttons.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      console.log(`[goccl] [click ${i}] button not visible, skipping`);
      continue;
    }

    // Scroll into view so the click registers reliably
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    const ratePromise = page.waitForResponse(
      (r) => r.url().includes("/availability/rate"),
      { timeout: 25000 }
    ).catch(() => null);

    await btn.click({ force: true }).catch((e) => console.log(`[goccl] [click ${i}] click error: ${e.message}`));
    const rateResp = await ratePromise;
    if (!rateResp) {
      console.log(`[goccl] [click ${i}] no /rate response — skipping`);
      continue;
    }

    const u = new URL(rateResp.url());
    const sd = u.searchParams.get("sailDate");
    const sc = u.searchParams.get("shipCode");
    const dur = parseInt(u.searchParams.get("duration"));
    const fp = SAILING_FINGERPRINT(sd, sc, dur);
    const status = rateResp.status();

    if (status === 200) {
      try {
        const json = await rateResp.json();
        captured.set(fp, json);
        console.log(`[goccl] [click ${i}] 200 for ${fp} (${captured.size}/${maxCruises})`);
      } catch (e) {
        console.log(`[goccl] [click ${i}] parse error: ${e.message}`);
      }
    } else if (status === 409) {
      console.log(`[goccl] [click ${i}] 409 (too close) for ${fp}`);
    } else {
      console.log(`[goccl] [click ${i}] status=${status} for ${fp}`);
    }

    await page.waitForTimeout(800);
  }

  console.log(`[goccl] rate enrichment complete: captured ${captured.size} sailings`);
  return captured;
}

// ── Per-cabin deck data via UI-driven category loop ─────────────────────────
// /availability/category lists every cabin category for a sailing+offer, each
// pinned to exactly one deck. /availability/stateroom (categoryCode=X) then
// returns every real cabin on that category's deck in one response — no
// pagination, that IS the full inventory for the category. Direct fetch()
// returns 400 (must originate from the SPA's own SELECT click), so we drive
// the UI: click SELECT per category, capture the response, click Edit to go
// back to the category list, repeat for the next category.

function normalizeGocclCabin(stateroom) {
  return {
    cabinNumber: stateroom.code ?? null,
    deckNumber: normalizeInteger(stateroom.deck?.number) ?? normalizeInteger(stateroom.deck?.code) ?? null,
    deckName: normalizeString(stateroom.deck?.name) ?? normalizeString(stateroom.deck?.code) ?? null,
    capacity: null,
    status: stateroom.isModified ? "Modified" : "Available"
  };
}

function buildCabinCategoriesFromDeckData(categoryJson, statewroomByCategory) {
  return (categoryJson?.categories ?? []).map((cat) => {
    const stateroomResp = statewroomByCategory.get(cat.code);
    const cabins = (stateroomResp?.deck?.staterooms ?? []).map(normalizeGocclCabin);
    const type = mapMetaCodeToType(cat.stateroomType?.code, cat.stateroomType?.name);

    return {
      code: cat.code,
      name: cat.name || cat.code,
      group: type,
      status: cabins.length > 0 ? "Available" : "Sold Out",
      avlResult: cabins.length > 0 ? "OK" : "SLD",
      total: cabins.length || null,
      avail: cabins.length,
      cabinPrice: cat.price?.amount ?? null,
      perPersonPrice: cat.price?.amount ?? null,
      capacity: cat.maximumGuestAllowed ?? null,
      trend: null,
      confidence: cabins.length > 0 ? "High" : "Medium",
      promos: unique((cat.termsAndConditions?.benefits ?? []).map((b) => b.text)),
      cabins
    };
  });
}

async function fetchGocclDeckDataForSailing(page, sailing, options = {}) {
  const apiBaseUrl = new URL(page.url()).origin;

  // The search-results page's own sailingDate= URL param is cosmetic — the SPA's
  // DATES picker filters client-side by re-issuing its own internal fetch() to
  // /app/cruise-search/api/v1.0/cruises with sailingDateFrom/sailingDateTo (confirmed
  // live via DevTools: the page URL never changes when the filter is applied).
  // That param is month-granularity only (no day-level filter exists). The ship
  // filter param is named shipCodes (PLURAL) not shipCode — verified directly
  // against the API: singular shipCode is silently ignored (still returns all
  // ships, 430 sailings for a 3-month window), while shipCodes=XX genuinely
  // narrows to that one ship (13 sailings for the same window). Previously the
  // deck-fetch loaded search-results fully unfiltered (blank sailingDate=&shipCode=)
  // and had to click through the FULL nearest-date-sorted list company-wide —
  // for a sailing months or years out, that's potentially thousands of cards
  // before ever reaching the target, timing out long before success. Instead of
  // driving the DATES widget's UI (fragile), intercept the SPA's own outgoing
  // request to that endpoint and rewrite it to carry both filters correctly.
  const sailDateObj = sailing.startDate ? new Date(sailing.startDate) : null;
  let routeHandler = null;
  if (sailDateObj && !isNaN(sailDateObj)) {
    // Keep a 1-month margin either side in case the site buckets edge-of-month
    // dates differently than a plain calendar-month split — shipCodes below is
    // what actually keeps the result count small, so the extra date margin
    // costs little once scoped to one ship.
    const fromDate = new Date(sailDateObj.getFullYear(), sailDateObj.getMonth() - 1, 1);
    const toDate = new Date(sailDateObj.getFullYear(), sailDateObj.getMonth() + 1, 1);
    const mmyyyy = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}${d.getFullYear()}`;
    const sailingDateFrom = mmyyyy(fromDate);
    const sailingDateTo = mmyyyy(toDate);
    const shipCode = sailing.shipCode ?? "";

    routeHandler = (route) => {
      const u = new URL(route.request().url());
      u.searchParams.set("sailingDateFrom", sailingDateFrom);
      u.searchParams.set("sailingDateTo", sailingDateTo);
      if (shipCode) u.searchParams.set("shipCodes", shipCode);
      route.continue({ url: u.toString() });
    };
    await page.route("**/app/cruise-search/api/v1.0/cruises**", routeHandler);
    console.log(`[goccl-decks] ${buildCruiseFingerprint(sailing)}: scoping search-results to ${sailingDateFrom}-${sailingDateTo} shipCodes=${shipCode || "(any)"} via request interception`);
  }

  try {
    return await fetchGocclDeckDataForSailingInner(page, sailing, options, apiBaseUrl);
  } finally {
    if (routeHandler) await page.unroute("**/app/cruise-search/api/v1.0/cruises**", routeHandler).catch(() => {});
  }
}

// Formats a Date the way GoCCL's card text shows it, e.g. "THU JUL 23, 2026" —
// used to pick the matching card by its visible date rather than trusting a
// remembered button index, since the site's card order was confirmed to shift
// depending on prior session activity (specifically: enrichWithRates(), which
// runs on the same shared page right before this function, clicks through an
// unfiltered set of sailings and appears to perturb the server-side ordering
// for subsequent shipCodes-filtered loads on that same session).
function formatGocclCardDate(date) {
  if (!date || isNaN(date)) return null;
  const dow = ["SUN","MON","TUE","WED","THU","FRI","SAT"][date.getUTCDay()];
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][date.getUTCMonth()];
  return `${dow} ${mon} ${String(date.getUTCDate()).padStart(2, "0")}, ${date.getUTCFullYear()}`;
}

async function fetchGocclDeckDataForSailingInner(page, sailing, options, apiBaseUrl) {
  const { maxCategories = Infinity } = options;
  const searchResultsUrl = `${apiBaseUrl}/app/bookingengine/search-results?amountOfGuests=2&birthDates=&coupon=&currencyCode=GBP&currencySymbol=%C2%A3&includeInterline=false&includeMilitary=false&includeSenior=false&sailingDate=&shipCode=&stateOfResidency=&vifpLevels=&vifpNumbers=`;
  await page.goto(searchResultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);

  const fp = buildCruiseFingerprint(sailing);
  const targetCardDate = formatGocclCardDate(sailing.startDate ? new Date(sailing.startDate) : null);
  const buttons = page.locator('button[data-component="search-results-select-sailing__select"]');

  // A fixed 8s delay here was flaky — under any extra load the SPA's own
  // fetch to /cruise-search/api hadn't resolved yet, so buttons.count() read
  // 0 and the scan gave up immediately on an otherwise-correct search
  // (confirmed: a retry of the exact same search succeeded once buttons had
  // time to render). Wait for at least one button to actually attach instead
  // of guessing a fixed delay; if none ever show up, this genuinely is an
  // empty result set and the existing "0 buttons" / no-LOAD-MORE fallback
  // below still applies.
  await buttons.first().waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Results page paginates 10-at-a-time behind a "LOAD MORE" button and is
  // sorted nearest-date-first, so a sailing months out may not be present in
  // the initial 20. Click LOAD MORE (up to maxLoadMore times) whenever we run
  // past the currently-loaded buttons without a match.
  const { maxLoadMore = 15, maxScanMs = 8 * 60 * 1000 } = options;
  let selected = false;
  let loadMoreClicks = 0;
  let i = 0;
  const scanStartedAt = Date.now();

  while (!selected) {
    if (Date.now() - scanStartedAt > maxScanMs) {
      console.log(`[goccl-decks] ${fp}: aborting search — scan exceeded ${maxScanMs}ms budget (${loadMoreClicks} LOAD MORE clicks done)`);
      break;
    }
    const btnCount = await buttons.count();
    if (i >= btnCount) {
      if (loadMoreClicks >= maxLoadMore) break;
      console.log(`[goccl-decks] ${fp}: scanned ${btnCount} buttons, no match yet — LOAD MORE click ${loadMoreClicks + 1}/${maxLoadMore}`);
      // Scroll to the bottom of the page first — the LOAD MORE button sits
      // below the last loaded card and Playwright's isVisible() can report
      // false for an element that's technically in the DOM but far off-screen.
      await page.mouse.wheel(0, 5000).catch(() => {});
      await page.waitForTimeout(500);
      const loadMoreBtn = page.locator('button:has-text("LOAD MORE"), button:has-text("Load More")').first();
      const loadMoreVisible = await loadMoreBtn.isVisible().catch(() => false);
      if (!loadMoreVisible) {
        console.log(`[goccl-decks] LOAD MORE not visible after ${btnCount} buttons — stopping search`);
        break;
      }
      await loadMoreBtn.scrollIntoViewIfNeeded().catch(() => {});
      await loadMoreBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
      loadMoreClicks++;
      continue;
    }

    const btn = buttons.nth(i);
    const thisIndex = i;
    i++;
    // A button can report not-yet-visible right after page load/re-navigation
    // (still rendering) — this used to `continue` silently, which meant the
    // FIRST card in the list (the nearest-date, most-likely-target sailing)
    // could be skipped entirely with no log trace, while the loop moved on to
    // matching later buttons. Give it one scroll + short wait before giving up
    // on this button, and log the skip either way so it's visible if it recurs.
    let visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      visible = await btn.isVisible().catch(() => false);
    }
    if (!visible) {
      console.log(`[goccl-decks] ${fp}: button ${thisIndex} not visible — skipping`);
      continue;
    }

    // Pre-check the card's own displayed date against the target before
    // clicking — the button-index/click/re-navigate loop below still exists
    // as a fallback (fingerprint verified server-side after click), but most
    // non-matches can be ruled out for free by just reading the card text,
    // avoiding a click + full round-trip through the rate API for every
    // obviously-wrong date.
    if (targetCardDate) {
      const cardDate = await btn.evaluate((el) => {
        const card = el.closest('[class*="card"], article, li') || el.parentElement?.parentElement;
        const text = card ? card.innerText : el.innerText;
        const m = text.match(/[A-Z]{3}\s+[A-Z]{3}\s+\d{1,2},\s+\d{4}/);
        return m ? m[0] : null;
      }).catch(() => null);
      if (cardDate && cardDate !== targetCardDate) continue;
    }

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);

    let rateResp = null;
    for (let clickAttempt = 1; clickAttempt <= 2 && !rateResp; clickAttempt++) {
      const ratePromise = page.waitForResponse((r) => r.url().includes("/availability/rate"), { timeout: 20000 }).catch(() => null);
      await btn.click({ force: true }).catch(() => {});
      rateResp = await ratePromise;
      // A click that never produces a /availability/rate response (no error,
      // just silence) used to fall through to the next button with no trace —
      // retry once on the SAME button before giving up, since a transient
      // overlay/render hiccup is more likely than the button being unusable.
      if (!rateResp && clickAttempt < 2) await page.waitForTimeout(1000);
    }

    // 409 means the site itself rejected this exact sailing as unbookable —
    // confirmed live for a sailing 1 day out (booking-cutoff style rejection,
    // same pattern seen on MSC for near-term dates). This is a genuine site
    // restriction, not a scan bug: no amount of retrying/re-navigating will
    // produce cabin data for a sailing the site won't quote a rate for.
    if (rateResp && rateResp.status() === 409) {
      console.log(`[goccl-decks] ${fp}: sailing rejected by site (HTTP 409 — not bookable, likely too close to sail date) — no cabin data available`);
      return [];
    }

    // A 200 means the SPA navigated off /search-results to /rateCode (even for
    // a non-matching sailing) — buttons.count() would read 0 there and the
    // outer loop would wrongly think we've exhausted results. Re-navigate back
    // whenever this happens so the button index keeps making sense.
    if (rateResp && rateResp.status() === 200) {
      const u = new URL(rateResp.url());
      const thisFp = SAILING_FINGERPRINT(u.searchParams.get("sailDate"), u.searchParams.get("shipCode"), parseInt(u.searchParams.get("duration")));
      if (thisFp === fp) {
        selected = true;
        break;
      }
      console.log(`[goccl-decks] ${fp}: button ${thisIndex} matched a different sailing (${thisFp}) — re-navigating back to search-results and replaying ${loadMoreClicks} LOAD MORE click(s)`);
      await page.goto(searchResultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(5000);
      // Re-loading resets pagination to the first page — re-run any LOAD MORE
      // clicks we'd already done so button index i still lines up.
      for (let r = 0; r < loadMoreClicks; r++) {
        await page.mouse.wheel(0, 5000).catch(() => {});
        await page.waitForTimeout(300);
        const lm = page.locator('button:has-text("LOAD MORE"), button:has-text("Load More")').first();
        if (await lm.isVisible().catch(() => false)) {
          await lm.click({ force: true }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      console.log(`[goccl-decks] ${fp}: replay of ${loadMoreClicks} LOAD MORE click(s) done, resuming button scan`);
    }
  }

  if (!selected) {
    console.log(`[goccl-decks] could not select sailing ${fp} (scanned ${i} buttons, ${loadMoreClicks} load-more clicks)`);
    return [];
  }
  await page.waitForTimeout(2000);

  // Pick a cabin type so an offer becomes selectable, then advance to category list.
  const priceLink = page.locator('text=/£[0-9,]+/').first();
  if (await priceLink.isVisible().catch(() => false)) {
    await priceLink.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const selectOfferBtn = page.locator('button:has-text("SELECT OFFER")').first();
  if (await selectOfferBtn.isVisible().catch(() => false)) {
    await selectOfferBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const categoryPromise = page.waitForResponse((r) => r.url().includes("/availability/category"), { timeout: 20000 }).catch(() => null);
  const continueBtn = page.locator('button:has-text("CONTINUE TO STATEROOM SELECTION")').first();
  if (!(await continueBtn.isVisible().catch(() => false))) {
    console.log(`[goccl-decks] ${fp}: CONTINUE TO STATEROOM SELECTION not reached`);
    return [];
  }
  await continueBtn.click({ force: true }).catch(() => {});
  const categoryResp = await categoryPromise;
  const categoryJson = await categoryResp?.json().catch(() => null);
  if (!categoryJson?.categories?.length) {
    console.log(`[goccl-decks] ${fp}: no categories returned`);
    return [];
  }
  console.log(`[goccl-decks] ${fp}: ${categoryJson.categories.length} categories`);

  const statewroomByCategory = new Map();
  const limit = Math.min(categoryJson.categories.length, maxCategories);

  // Prime the session with ONE real click — /availability/stateroom requires a
  // requestverificationtoken header that only a genuine click-driven request
  // carries. Once we have it, every other category is a plain direct fetch()
  // reusing the same token (confirmed valid across categories): ~1s total for
  // a whole sailing instead of a UI click + Edit-back cycle per category.
  const firstCatCode = categoryJson.categories[0]?.code;
  const selectBtns = page.locator('button:has-text("SELECT")').filter({ hasNotText: "SELECT OFFER" }).filter({ hasNotText: "SELECT SAILING" });
  // A large category list (seen: 46 categories for a far-future sailing) takes
  // longer to paint than the fixed 1500ms wait this used to have — that fixed
  // delay was reliably enough for small lists but raced the DOM for big ones,
  // making "no SELECT buttons" a false negative. Poll instead of guessing a delay.
  let btnCnt = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    btnCnt = await selectBtns.count();
    if (btnCnt > 0) break;
    await page.waitForTimeout(500);
  }
  if (btnCnt === 0) {
    console.log(`[goccl-decks] ${fp}: no SELECT buttons to prime session`);
    return [];
  }

  const primeReqPromise = page.waitForRequest((r) => r.url().includes("/availability/stateroom"), { timeout: 20000 }).catch(() => null);
  const primeRespPromise = page.waitForResponse((r) => r.url().includes("/availability/stateroom"), { timeout: 20000 }).catch(() => null);
  await selectBtns.first().scrollIntoViewIfNeeded().catch(() => {});
  await selectBtns.first().click({ force: true }).catch(() => {});
  const primeReq = await primeReqPromise;
  const primeResp = await primeRespPromise;

  if (!primeReq || !primeResp || primeResp.status() !== 200) {
    console.log(`[goccl-decks] ${fp}: could not prime session (no working stateroom request) — falling back to nothing`);
    return [];
  }

  const primedJson = await primeResp.json().catch(() => null);
  const primedCode = new URL(primeReq.url()).searchParams.get("categoryCode") ?? firstCatCode;
  if (primedJson) {
    statewroomByCategory.set(primedCode, primedJson);
    console.log(`[goccl-decks] ${fp}: ${primedCode} — ${primedJson.deck?.staterooms?.length ?? 0} cabins on ${primedJson.deck?.name ?? "?"} (primed via click)`);
  }

  const primedUrl = new URL(primeReq.url());
  const primedHeaders = {};
  for (const [k, v] of Object.entries(primeReq.headers())) {
    if (!["host", "content-length", "cookie"].includes(k.toLowerCase())) primedHeaders[k] = v;
  }

  const remaining = categoryJson.categories.slice(0, limit).filter((c) => c.code !== primedCode);
  for (const cat of remaining) {
    const params = new URLSearchParams(primedUrl.search);
    params.set("categoryCode", cat.code);
    const url = `${primedUrl.origin}${primedUrl.pathname}?${params.toString()}`;
    const result = await page.evaluate(async ({ url, headers }) => {
      const res = await fetch(url, { credentials: "include", headers });
      const status = res.status;
      const json = status === 200 ? await res.json().catch(() => null) : null;
      return { status, json };
    }, { url, headers: primedHeaders }).catch((err) => ({ status: "error", error: err.message }));

    if (result.status === 200 && result.json) {
      statewroomByCategory.set(cat.code, result.json);
      console.log(`[goccl-decks] ${fp}: ${cat.code} — ${result.json.deck?.staterooms?.length ?? 0} cabins on ${result.json.deck?.name ?? "?"} (direct fetch)`);
    } else {
      console.log(`[goccl-decks] ${fp}: ${cat.code} — direct fetch failed (status=${result.status})`);
    }
  }

  return buildCabinCategoriesFromDeckData(categoryJson, statewroomByCategory);
}

// ── Persistent session for on-demand single-voyage fetch ────────────────────
let cachedGocclSession = null;
let gocclQueue = Promise.resolve();

async function getOrCreateGocclSession() {
  if (cachedGocclSession) {
    const alive = await cachedGocclSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedGocclSession;
    await cachedGocclSession.close().catch(() => {});
    cachedGocclSession = null;
  }
  cachedGocclSession = await createScraperSession({
    userDataDir: "./sessions/goccl-user-data",
    storageStatePath: "./sessions/.auth/goccl-storage.json",
    headless: false,
    slowMo: 0
  });
  return cachedGocclSession;
}

function runExclusiveGoccl(fn) {
  const result = gocclQueue.then(fn);
  gocclQueue = result.catch(() => {});
  return result;
}

/**
 * On-demand single-voyage fetch for "Get Full Details" — searches the
 * MMYYYY month containing startDate for cruiseCode, then runs the proven
 * fast deck-fetch (1 priming click + direct fetch per remaining category).
 */
export async function fetchGocclVoyageByCode(cruiseCode, startDate) {
  return runExclusiveGoccl(async () => {
    const session = await getOrCreateGocclSession();
    await ensureGocclAuthentication(session);
    await session.page.waitForURL((u) => !u.toString().includes("/accounts/post-login") && !u.toString().includes("/accounts/login"), { timeout: 20000 }).catch(() => {});
    await session.page.waitForLoadState("domcontentloaded").catch(() => {});

    const dep = new Date(startDate);
    const mmyyyy = `${String(dep.getMonth() + 1).padStart(2, "0")}${dep.getFullYear()}`;
    const result = await fetchGocclCruises(session.page, { sailingDateFrom: mmyyyy, sailingDateTo: mmyyyy });
    const match = result.cruises.find((c) => c.id === cruiseCode);
    if (!match) throw new Error(`Voyage ${cruiseCode} not found in GOCCL search for ${mmyyyy}`);

    const cabinCategories = await fetchGocclDeckDataForSailing(session.page, match, { maxLoadMore: 10 });
    if (!cabinCategories.length) throw new Error(`No cabin categories returned for ${cruiseCode}`);
    return cabinCategories;
  });
}

export async function authenticateGoccl() {
  const session = await createScraperSession({
    userDataDir: "./sessions/goccl-user-data",
    storageStatePath: "./sessions/.auth/goccl-storage.json",
    headless: true,
    slowMo: 0
  });

  try {
    const authResult = await ensureGocclAuthentication(session);

    return {
      vendorKey: "goccl",
      browserMode: session.mode,
      ...authResult
    };
  } catch (error) {
    error.message = `GOCCL authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

export async function runGocclScraper(options = {}) {
  const { maxCruises = 10, enrichRates = true, withDecks = false, maxDeckCruises = Infinity, maxCategories = Infinity, shipName = null } = options;

  // Auto-set sailingDateFrom/To to current month if not provided (MMYYYY format)
  if (!options.sailingDateFrom) {
    const now = new Date();
    const mmyyyy = `${String(now.getMonth() + 1).padStart(2, "0")}${now.getFullYear()}`;
    options = { ...options, sailingDateFrom: mmyyyy, sailingDateTo: mmyyyy };
  }

  const session = await createScraperSession({
    userDataDir: "./sessions/goccl-user-data",
    storageStatePath: "./sessions/.auth/goccl-storage.json",
    headless: !enrichRates && !withDecks,
    slowMo: 0
  });

  try {
    const authResult = await ensureGocclAuthentication(session);
    console.log("[goccl] authenticated, starting cruise fetch");
    // Wait out any post-login redirects before starting the fetch
    await session.page.waitForURL((u) => !u.toString().includes("/accounts/post-login") && !u.toString().includes("/accounts/login"), { timeout: 20000 }).catch(() => {});
    await session.page.waitForLoadState("domcontentloaded").catch(() => {});
    await session.page.waitForTimeout(1500);
    const result = await fetchGocclCruises(session.page, options);
    console.log(`[goccl] fetched ${result.cruises.length} normalized cruises`);

    let cruisesOut = result.cruises;
    let rateMap = new Map();

    // Day-by-day itinerary is a single cheap GET per sailing (no wizard, no
    // cart), so it runs for the whole set rather than being capped like the
    // deck pass. Without it these cruises fall back to Book1.xlsx matching,
    // which only covers about half of them.
    if (cruisesOut.length > 0) {
      const { filled, attempted } = await enrichCruisesWithItineraries(session.page, cruisesOut);
      console.log(`[goccl] itineraries: ${filled}/${attempted} sailings got day-by-day stops`);
    }

    if (enrichRates && cruisesOut.length > 0) {
      console.log(`[goccl] enriching cruises with /availability/rate via UI clicks (cap=${maxCruises})`);
      rateMap = await enrichWithRates(session.page, { maxCruises });

      // Additive merge: keep ALL cruises with their /cruises-derived 4-row data,
      // and replace cabinCategories with the rate-matrix data for the cruises we
      // were able to enrich via UI clicks.
      let enrichedCount = 0;
      cruisesOut = cruisesOut.map((cruise) => {
        const fp = buildCruiseFingerprint(cruise);
        const rateJson = rateMap.get(fp);
        if (!rateJson) return cruise;
        enrichedCount++;
        return {
          ...cruise,
          cabinCategories: buildCabinCategoriesFromRate(rateJson),
          rateRawPayload: rateJson
        };
      });
      console.log(`[goccl] enriched ${enrichedCount}/${cruisesOut.length} cruises with rate matrix`);
    }

    if (withDecks && cruisesOut.length > 0) {
      let deckCandidates = cruisesOut;
      if (shipName) {
        const shipFilter = shipName.trim().toUpperCase();
        deckCandidates = cruisesOut.filter((c) => c.ship?.toUpperCase().includes(shipFilter));
        console.log(`[goccl-decks] shipName="${shipName}" — ${deckCandidates.length}/${cruisesOut.length} cruises match`);
      }

      // Cruises that already have cabin rows in the DB go LAST. Without this,
      // every capped deck pass re-fetched the same already-covered sailings in
      // list order and exhausted maxDeckCruises before ever reaching the ones
      // with no deck data at all — coverage sat still no matter how many runs
      // fired. (This, not any per-vendor scrape bug, is why "the sweep ran but
      // the missing cruises are still missing" kept happening.)
      const codesWithCabins = new Set(
        (await prisma.cruise.findMany({
          where: {
            vendor: { slug: "goccl" },
            cabinCategories: { some: { cabins: { some: {} } } }
          },
          select: { code: true }
        })).map((c) => c.code)
      );

      // A cruise with every rate marked "SLD" (sold out) has nothing bookable
      // to fetch cabins for — treating it as "missing decks" would let it
      // permanently hog the front of every capped run instead of the cruises
      // that actually have inventory (confirmed live on celestyal.js — same
      // bug there sent every run at a 100%-Waitlist sailing).
      const hasFetchableCategory = (c) => (c.cabinCategories ?? []).some((cc) => cc.avlResult === "OK");

      // Prefer cruises the rate-enrichment pass already proved are bookable —
      // going through search-results for a sailing that's "too close" (409)
      // wastes the full LOAD MORE budget since it can never be found there.
      // Fall back to the plain list order once the confirmed-bookable ones run out.
      const confirmedFps = new Set(rateMap.keys());
      const priority = (c) => {
        if (codesWithCabins.has(c.id)) return 2;    // already covered
        if (!hasFetchableCategory(c)) return 2;      // nothing bookable
        return 1;                                     // real gap
      };
      const bookableFirst = [...deckCandidates].sort((a, b) => {
        const aP = priority(a), bP = priority(b);
        if (aP !== bP) return aP - bP; // missing decks first
        const aOk = confirmedFps.has(buildCruiseFingerprint(a)) ? 0 : 1;
        const bOk = confirmedFps.has(buildCruiseFingerprint(b)) ? 0 : 1;
        return aOk - bOk;
      });
      const missingCount = bookableFirst.filter((c) => priority(c) === 1).length;
      console.log(`[goccl-decks] ${missingCount}/${deckCandidates.length} candidates lack cabin data — those go first`);

      const limit = Math.min(bookableFirst.length, maxDeckCruises);
      console.log(`[goccl] fetching per-cabin deck data for ${limit}/${cruisesOut.length} cruises`);
      let deckEnrichedCount = 0;
      const byId = new Map(cruisesOut.map((c, idx) => [c.id, idx]));

      // Save each cruise's deck data to the DB the moment it's fetched, rather
      // than waiting for the whole (possibly hours-long) deck pass to finish —
      // a crash/restart mid-run previously meant losing every completed cruise
      // along with the ones still pending, since nothing was persisted until
      // the very end.
      const vendor = await ensureVendor({ slug: "goccl", name: "GOCCL", url: "https://www.goccl.co.uk/" });

      for (let i = 0; i < limit; i++) {
        const target = bookableFirst[i];
        console.log(`[goccl-decks] [${i + 1}/${limit}] ${target.id}`);
        try {
          const cabinCategories = await fetchGocclDeckDataForSailing(session.page, target, { maxCategories, maxLoadMore: 6 });
          if (cabinCategories.length > 0) {
            const idx = byId.get(target.id);
            cruisesOut[idx] = { ...cruisesOut[idx], cabinCategories };
            deckEnrichedCount++;
            try {
              await ingestCruise(vendor.id, cruisesOut[idx]);
              console.log(`[goccl-decks] [${i + 1}/${limit}] ${target.id} saved to DB`);
            } catch (saveErr) {
              console.error(`[goccl-decks] [${i + 1}/${limit}] ${target.id} save failed: ${saveErr.message}`);
            }
          }
        } catch (err) {
          console.error(`[goccl-decks] [${i + 1}/${limit}] failed: ${err.message}`);
        }
      }
      console.log(`[goccl] deck pass complete: ${deckEnrichedCount}/${limit} cruises got cabin data`);
    }

    const typeSummary = cruisesOut
      .flatMap((cruise) => cruise.cabinCategories ?? [])
      .reduce((summary, cabin) => {
        const key = cabin.group ?? cabin.type ?? "Unknown";
        summary[key] = (summary[key] ?? 0) + 1;
        return summary;
      }, {});
    console.log("[goccl] cabin type summary", JSON.stringify(typeSummary));

    return {
      vendorKey: "goccl",
      source: "goccl",
      browserMode: session.mode,
      authentication: authResult,
      extracted: result.extracted,
      cruises: cruisesOut
    };
  } catch (error) {
    error.message = `GOCCL scraper failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}
