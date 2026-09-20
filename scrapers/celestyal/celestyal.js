import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { createScraperSession } from "../runtime.js";
import { getCelestyalShipMetadata } from "./celestyalMetadata.js";
import { buildItineraryStops, fetchItineraryMap } from "./celestyalItinerary.js";
import prisma from "../../config/prisma.js";

dotenv.config();

const USERNAME = process.env.LOGIN_USER;
const PASSWORD = process.env.LOGIN_PASS;

async function saveDebugSnapshot(page, label) {
  const outputDir = path.resolve("output");
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `celestyal-${label}.png`);

  await page.screenshot({
    path: filePath,
    fullPage: true
  });

  return filePath;
}

function unique(values = []) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function buildCruiseCode(item) {
  return item.pkg?.pkgCode ?? null;
}

function buildRouteLabel(portFrom, portTo) {
  if (!portFrom && !portTo) {
    return null;
  }

  return `${portFrom ?? "Unknown"} -> ${portTo ?? "Unknown"}`;
}

function inferCabinType(code) {
  const normalizedCode = String(code ?? "").toUpperCase();

  if (!normalizedCode) {
    return null;
  }

  if (normalizedCode.startsWith("I")) {
    return "Interior";
  }

  if (normalizedCode.startsWith("X")) {
    return "Exterior";
  }

  if (normalizedCode.startsWith("B")) {
    return "Balcony";
  }

  if (normalizedCode.startsWith("S")) {
    return "Suite";
  }

  return null;
}

function mapGenericCategoryToType(code, description) {
  const normalizedCode = String(code ?? "").toUpperCase();
  const normalizedDescription = String(description ?? "").toUpperCase();

  if (
    normalizedCode.includes("BALCONY") ||
    normalizedDescription.includes("BALCONY")
  ) {
    return "Balcony";
  }

  if (
    normalizedCode.includes("OUTSIDE") ||
    normalizedDescription.includes("OUTSIDE") ||
    normalizedCode.includes("EXTERIOR") ||
    normalizedDescription.includes("EXTERIOR") ||
    normalizedCode.includes("OCEAN") ||
    normalizedDescription.includes("OCEAN")
  ) {
    return "Exterior";
  }

  if (
    normalizedCode.includes("INSIDE") ||
    normalizedDescription.includes("INSIDE") ||
    normalizedCode.includes("INTERIOR") ||
    normalizedDescription.includes("INTERIOR")
  ) {
    return "Interior";
  }

  if (
    normalizedCode.includes("DELUXE") ||
    normalizedDescription.includes("SUITE")
  ) {
    return "Suite";
  }

  return null;
}

function inferCabinStatus(avlResult) {
  if (avlResult === "OK") {
    return "Available";
  }

  if (avlResult === "WTL") {
    return "Waitlist";
  }

  return avlResult ?? null;
}

function getInvoiceAmount(invoiceValues = [], code) {
  return invoiceValues
    .filter((entry) => entry.code === code)
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
}

function buildCategoryClassifications(category) {
  return Object.entries(category.genericCategoriesVal ?? {}).map(
    ([linkType, value]) => ({
      linkType,
      code: value?.code ?? null,
      name: value?.name ?? null,
      description: value?.description ?? null,
      rank: normalizeInteger(value?.rankVal),
      shipCode: value?.ship ?? null
    })
  ).filter((entry) => entry.code);
}

function inferCategoryType(category) {
  const webCategory = category.genericCategoriesVal?.WEB;
  const pricingCategory = category.genericCategoriesVal?.PRICING;
  const pricingTravelAgentCategory =
    category.genericCategoriesVal?.["PRICING TRAVEL AGENT"];
  const categoryDescription = category.ctgInfo?.description;

  return (
    mapGenericCategoryToType(webCategory?.code, webCategory?.description) ??
    mapGenericCategoryToType(pricingCategory?.code, pricingCategory?.description) ??
    mapGenericCategoryToType(
      pricingTravelAgentCategory?.code,
      pricingTravelAgentCategory?.description
    ) ??
    mapGenericCategoryToType(category.ctgInfo?.code, categoryDescription) ??
    mapGenericCategoryToType(categoryDescription, categoryDescription) ??
    inferCabinType(category.ctgInfo?.code)
  );
}

function inferCabinConfidence(category) {
  if (
    category.ctgInfo?.code &&
    category.ctgInfo?.description &&
    category.cabinPrice !== null &&
    category.cabinPrice !== undefined &&
    category.nofCabinsVal !== null &&
    category.nofCabinsVal !== undefined &&
    category.count !== null &&
    category.count !== undefined
  ) {
    return "High";
  }

  if (category.ctgInfo?.code && category.cabinPrice !== null && category.cabinPrice !== undefined) {
    return "Medium";
  }

  return "Low";
}

function inferCruiseConfidence(item, shipDetails) {
  if (
    shipDetails?.totalCapacity &&
    shipDetails?.totalCabins &&
    item.avlGuestsVal !== null &&
    item.avlGuestsVal !== undefined &&
    (item.ctgsVal?.length ?? 0) > 0
  ) {
    return "High";
  }

  if ((item.ctgsVal?.length ?? 0) > 0) {
    return "Medium";
  }

  return "Low";
}

function buildCruisePromotions(item) {
  const classificationPromotions = (item.pkg?.classificationsVal ?? [])
    .filter((entry) => String(entry.type ?? "").toUpperCase().includes("PROMO"))
    .map((entry) => entry.code)
    .filter(Boolean);

  const cabinPromotions = (item.ctgsVal ?? []).flatMap((category) =>
    category.promoCodesVal ?? []
  );

  return unique([...classificationPromotions, ...cabinPromotions]);
}

function buildCabinCategories(item) {
  return (item.ctgsVal ?? [])
    .filter((category) => category.ctgInfo?.code)
    .map((category) => ({
      code: category.ctgInfo.code,
      name: category.ctgInfo.description ?? null,
      group: inferCategoryType(category),
      status: inferCabinStatus(category.avlResultVal),
      avlResult: category.avlResultVal ?? null,
      total: normalizeInteger(category.nofCabinsVal),
      avail: normalizeInteger(category.count),
      cabinPrice: category.cabinPrice ?? null,
      perPersonPrice: category.perPersonPrice ?? null,
      voyageFare: getInvoiceAmount(category.invoiceVal, "VOYAGE FARE"),
      portCharges: getInvoiceAmount(category.invoiceVal, "PORT CHARGES"),
      capacity: normalizeInteger(category.ctgInfo.capacityVal),
      childBeds: normalizeInteger(category.ctgInfo.childBedsVal),
      trend: null,
      range7d: null,
      confidence: inferCabinConfidence(category),
      promos: unique(category.promoCodesVal ?? []),
      classifications: buildCategoryClassifications(category)
    }));
}

function normalizeCelestyalCruise(item, itineraryMap = null) {
  const shipCode = item.ship ?? null;
  const shipDetails = getCelestyalShipMetadata(shipCode);
  const portFrom = item.locFrom ?? item.pkg?.locFrom?.code ?? null;
  const portTo = item.locTo ?? item.pkg?.locTo?.code ?? null;
  const shipCapacity = normalizeInteger(shipDetails?.totalCapacity);
  const availableGuests = normalizeInteger(item.avlGuestsVal);

  return {
    id: buildCruiseCode(item),
    ship: shipDetails?.name ?? shipCode,
    shipCode,
    shipDetails: shipDetails
      ? {
          name: shipDetails.name,
          cabins: shipDetails.totalCabins,
          guests: shipDetails.totalCapacity
        }
      : null,
    package: item.pkg?.pkgName ?? null,
    portFrom,
    portTo,
    routeLabel: buildRouteLabel(portFrom, portTo),
    nights: normalizeInteger(item.sailLengthVal ?? item.pkg?.daysVal),
    startDate: item.startDateVal?.utc ?? item.startDateVal?.local ?? null,
    endDate: item.endDateVal?.utc ?? item.endDateVal?.local ?? null,
    seatsAvailable:
      shipCapacity !== null && availableGuests !== null
        ? Math.min(availableGuests, shipCapacity)
        : availableGuests,
    totalCapacity: shipDetails?.totalCapacity ?? null,
    totalCabins: shipDetails?.totalCabins ?? null,
    trend: null,
    confidence: inferCruiseConfidence(item, shipDetails),
    pinned: false,
    currency: item.ctgsVal?.[0]?.currency ?? null,
    promotions: buildCruisePromotions(item),
    cabinCategories: buildCabinCategories(item),
    // The availability response's own portsVal is empty for every sailing —
    // stops come from the CMS package-type document instead (see
    // celestyalItinerary.js). Empty array when the map wasn't loaded or the
    // package type isn't published there.
    itineraryStops: buildItineraryStops(itineraryMap, {
      destinationCode: item.pkg?.destinationsVal?.[0],
      shipCode,
      portFrom,
      portTo
    }),
    rawPayload: item
  };
}

async function ensureCelestyalAuthentication(session) {
  const { page } = session;

  console.log("[celestyal] opening login page");
  await page.goto("https://sale.celestyal.com", {
    waitUntil: "load",
    timeout: 60000
  });
  console.log("[celestyal] login page loaded", await page.url());

  // Wait up to 10s for either logged-in indicator OR login button to appear.
  // isVisible() alone is a race — use waitFor on both and take whichever wins.
  const state = await Promise.race([
    page.locator("text=Logged in as:").waitFor({ state: "visible", timeout: 10000 })
      .then(() => "logged-in"),
    page.locator("text=CLICK to start a new Cruise Booking").waitFor({ state: "visible", timeout: 10000 })
      .then(() => "logged-in"),
    page.getByRole("button", { name: /^login$/i }).first().waitFor({ state: "visible", timeout: 10000 })
      .then(() => "need-login"),
  ]).catch(() => "unknown");

  console.log("[celestyal] auth state detected:", state);

  if (state === "logged-in") {
    // Verify we're not on an empty/error view
    const currentUrl = page.url();
    if (!currentUrl.includes("vx-emptyView") && !currentUrl.includes("error")) {
      console.log("[celestyal] existing session detected, skipping login");
      return {
        success: true,
        alreadyLoggedIn: true,
        message: "Celestyal session reused successfully."
      };
    }
    console.log("[celestyal] session appears broken (emptyView) — forcing re-login");
  }

  // state === "need-login" or "unknown" or broken session — navigate to login
  await page.goto("https://sale.celestyal.com", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const loginButton = page.getByRole("button", { name: /^login$/i }).first();
  await loginButton.click();
  console.log("[celestyal] login modal opened");

  const usernameField = page.locator('input[type="text"]:visible').last();
  const passwordField = page.locator('input[type="password"]:visible').first();

  await usernameField.waitFor({ state: "visible", timeout: 15000 });
  await passwordField.waitFor({ state: "visible", timeout: 15000 });

  await usernameField.fill(USERNAME);
  await passwordField.fill(PASSWORD);

  await Promise.all([
    page.waitForSelector("text=Logged in as:", { timeout: 30000 }),
    passwordField.press("Enter")
  ]);
  console.log("[celestyal] login successful");

  await session.persistAuthState();

  return {
    success: true,
    alreadyLoggedIn: false,
    message: "Celestyal login successful."
  };
}

// On-demand fetch for a single Celestyal cruise by its pkgCode.
// Full booking flow: search → select cruise → Continue → add category → Continue
// This naturally triggers /rest/entity/cabins (individual cabin+deck data).
export async function fetchCelestyalCruiseByCode(cruiseCode, { fromDate, toDate }) {
  const session = await createScraperSession({
    userDataDir:      "./sessions/celestyal-user-data",
    storageStatePath: "./sessions/.auth/celestyal-storage.json",
    headless:         false,
    slowMo:           80,
  });

  const { page } = session;

  try {
    await ensureCelestyalAuthentication(session);

    console.log("[celestyal] navigating to booking flow");
    await page.getByText("CLICK to start a new Cruise Booking").click();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    console.log("[celestyal] booking page loaded", await page.url());

    const advancedBtn = page.getByText("Advanced");
    await advancedBtn.waitFor({ state: "visible" });
    await advancedBtn.click();

    // Narrow the UI search to the cruise's departure date window so the result
    // table has 1-4 rows (avoids paginating through 50+ results to find the row).
    // Derive the departure date directly from the cruise code suffix (YYMMDD).
    const MONTH_ABBR_UI = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let uiFromDate = fromDate;
    let uiToDate   = toDate;
    let departureDateFilterEarly = null; // "20 Jul 2026" derived before pkgs response
    const cmCode = cruiseCode.match(/(\d{2})(\d{2})(\d{2})$/);
    if (cmCode) {
      const yy = parseInt(cmCode[1], 10), mm = parseInt(cmCode[2], 10), dd = parseInt(cmCode[3], 10);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        const depDate = new Date(2000 + yy, mm - 1, dd);
        const endDate = new Date(2000 + yy, mm - 1, dd + 7);
        const fmt = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
        uiFromDate = fmt(depDate);
        uiToDate   = fmt(endDate);
        departureDateFilterEarly = `${dd} ${MONTH_ABBR_UI[mm - 1]} ${2000 + yy}`;
        console.log(`[celestyal] narrow search: ${uiFromDate} → ${uiToDate} (date filter: "${departureDateFilterEarly}")`);
      }
    }

    const dateboxes = page.locator('input[data-role="datebox"]');
    await dateboxes.first().waitFor({ state: "visible" });
    await dateboxes.nth(0).fill(uiFromDate);
    await dateboxes.nth(0).press("Tab");
    await dateboxes.nth(1).fill(uiToDate);
    await dateboxes.nth(1).press("Tab");
    console.log("[celestyal] dates filled", { uiFromDate, uiToDate });


    const pkgsPromise = page.waitForResponse(
      (resp) => resp.url().includes("/rest/availability/pkgs") && resp.status() === 200,
      { timeout: 120000 }
    );
    await page.getByText("Search Cruises", { exact: true }).click();
    console.log("[celestyal] search submitted");

    const pkgsResponse = await pkgsPromise;
    const extracted = await pkgsResponse.json();
    const itineraryMap = await fetchItineraryMap(page).catch(() => null);
    const cruises = (extracted || []).map((item) => normalizeCelestyalCruise(item, itineraryMap));
    console.log(`[celestyal] ${cruises.length} cruises returned, IDs:`, cruises.map((c) => c.id).filter(Boolean));

    const matchIndex = cruises.findIndex((cruise) => cruise.id === cruiseCode);
    const match = matchIndex >= 0 ? cruises[matchIndex] : null;
    if (!match) return null;

    // Departure date filter string ("20 Jul 2026") — used to confirm the correct row.
    // Prefer match.startDate from pkgs API; fall back to the code-derived value computed above.
    const MONTH_ABBR = MONTH_ABBR_UI;
    let departureDateFilter = departureDateFilterEarly;
    if (match.startDate) {
      const dm = match.startDate.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
      if (dm) departureDateFilter = `${dm[1]} ${dm[2]} ${dm[3]}`;
    }

    // ── Step 1: select this cruise in the voyage-interval table ───────────────
    // After "Search Cruises", GWT navigates to vx-voyageSearchInterval — a DataTables
    // table paginated 10 rows/page. checkboxes[index] is undefined for rows off page 1.
    // We filter the table by departure date ("20 Jul 2026") so only the target sailing
    // remains visible, then click its checkbox. This correctly identifies the sailing
    // even when multiple cruises share the same package name.
    console.log(`[celestyal] selecting cruise for ${cruiseCode} (${match.package}) - target date: "${departureDateFilter}"`);
    await page.waitForTimeout(1500); // let voyage-interval table render
    await saveDebugSnapshot(page, "search-results");

    async function selectSailingRow() {
      console.log(`[celestyal] selectSailingRow: index=${matchIndex} date="${departureDateFilter}"`);

      // With the narrow date search, the table has only a few rows on page 1.
      // Select by date text (pass 1) or by position (pass 2 fallback).
      return page.evaluate(({ ds, pk, rowIdx }) => {
        const visibleRows = [...document.querySelectorAll("table tbody tr")]
          .filter(r => window.getComputedStyle(r).display !== "none");
        document.querySelectorAll('input[type="checkbox"]:checked, input.checkbox-rowsel:checked')
          .forEach(cb => cb.click());
        // Pass 1: find by departure date text in row
        if (ds) {
          for (const row of visibleRows) {
            const text = row.textContent || "";
            if (!text.includes(ds)) continue;
            if (pk && !text.includes(pk)) continue;
            const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
            if (cb) { cb.click(); return `date+pkg: ${text.trim().slice(0, 120)}`; }
          }
          for (const row of visibleRows) {
            if ((row.textContent || "").includes(ds)) {
              const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
              if (cb) { cb.click(); return `date-only: ${row.textContent.trim().slice(0, 120)}`; }
            }
          }
        }
        // Pass 2: position fallback (matchIndex within narrow result set)
        if (visibleRows[rowIdx]) {
          const row = visibleRows[rowIdx];
          const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
          if (cb) { cb.click(); return `pos-${rowIdx}: ${row.textContent.trim().slice(0, 120)}`; }
        }
        if (visibleRows[0]) {
          const cb = visibleRows[0].querySelector('input[type="checkbox"], input.checkbox-rowsel');
          if (cb) { cb.click(); return `first-row: ${visibleRows[0].textContent.trim().slice(0, 120)}`; }
        }
        return null;
      }, { ds: departureDateFilter, pk: match.package ?? null, rowIdx: matchIndex });
    }

    const clicked = await selectSailingRow();
    console.log(`[celestyal] cruise row selected: ${clicked}`);
    if (!clicked) throw new Error("Could not find cruise row in search results");
    await page.waitForTimeout(500);

    // Helper: click the on-screen "Continue" button by bounding rect.
    // jQuery Mobile marks many <a> elements as hidden in CSS so Playwright
    // locators fail — we find the element's rendered position and use mouse.click().
    //
    // After clicking a category's + button, GWT renders a panel Continue (x ≈ 644)
    // that correctly navigates to distribution. The main-nav Continue (x ≈ 1158) does
    // something different. Poll up to 6s preferring the panel Continue.
    async function clickContinue(label) {
      let rect = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        rect = await page.evaluate(() => {
          const all = [];
          for (const el of document.querySelectorAll("a, button")) {
            if (!/continue/i.test(el.textContent?.trim())) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) all.push({ x: r.x, y: r.y, w: r.width, h: r.height });
          }
          if (!all.length) return null;
          // Prefer panel Continue (x < 900) over far-right navigation Continue
          return all.find(c => c.x < 900) ?? all[0];
        });
        if (rect?.x < 900) break; // found the panel button — stop polling
        await page.waitForTimeout(1000);
      }
      if (!rect) throw new Error(`Continue button not found on screen (${label})`);
      console.log(`[celestyal] clicking Continue (${label}) at`, rect);
      await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    }

    // ── Step 2: Continue → category selection page ────────────────────────────
    await clickContinue("search→categories");
    console.log("[celestyal] continue clicked, waiting for category or voyage-interval page");
    // GWT may show vx-voyageSearchInterval (date-picker) before vx-genCtgAvailSearch
    await page.waitForURL(/vx-genCtgAvailSearch|vx-voyageSearchInterval/, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    if ((await page.url()).includes("vx-voyageSearchInterval")) {
      // Landed on voyage-interval AFTER Continue: re-run date-based selection and continue again
      console.log("[celestyal] voyage-interval appeared after Continue — re-selecting target sailing");
      await saveDebugSnapshot(page, "voyage-interval-2nd");
      await page.waitForTimeout(1500);
      const reSelected = await selectSailingRow();
      console.log(`[celestyal] voyage-interval (2nd) row selected: ${reSelected}`);
      await page.waitForTimeout(800);
      await clickContinue("voyage-interval→categories");
      await page.waitForURL(/vx-genCtgAvailSearch/, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    await saveDebugSnapshot(page, "category-page");
    console.log("[celestyal] category page URL:", await page.url());

    // Log all REST requests to trace what fires when
    page.on("request", (req) => {
      if (!req.url().includes("/rest/")) return;
      const path = new URL(req.url()).pathname;
      const body = req.postData();
      console.log(`[celestyal] REQ ${req.method()} ${path}${body ? " BODY:" + body.slice(0, 200) : ""}`);
    });

    // ── Steps 3+4: click +, intercept navigation PUT → force firstOkCode, Continue → Distribution ──
    // GWT always sends the auto-selected category (often WTL) in the navigation PUT body.
    // We intercept that PUT and rewrite ctgInfo to the first OK category so the server
    // sets up the booking with an OK category → distribution renders "Change Staterooms".
    const firstOkCode = (match.cabinCategories.find(c => c.avlResult === "OK"))?.code ?? null;
    const firstOkRawCat = firstOkCode ? (match.rawPayload.ctgsVal ?? []).find(c => c.ctgInfo?.code === firstOkCode) : null;
    const firstOkCtgInfo = firstOkRawCat?.ctgInfo ?? (firstOkCode ? { ship: match.shipCode, code: firstOkCode, spaceTypeVal: "CABIN" } : null);
    console.log(`[celestyal] waiting for ivx-plus to render (forcing OK category: ${firstOkCode})`);

    for (let attempt = 0; attempt < 20; attempt++) {
      const hasRect = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("a.ivx-plus")]
          .find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        return !!btn;
      });
      if (hasRect) break;
      await page.waitForTimeout(1000);
    }

    let putBodyTemplate = null;
    let bookingResGUID = null;
    const onPutRequest = (req) => {
      if (!req.url().includes("/rest/booking/cabins/") || req.method() !== "PUT") return;
      try {
        putBodyTemplate = JSON.parse(req.postData() ?? "{}");
        bookingResGUID = req.url().split("/rest/booking/cabins/")[1];
      } catch {}
    };
    page.on("request", onPutRequest);

    let bookingResId = null; // numeric booking-session ID for GET /rest/availability/cabins/{resId}
    let entityCabinsTemplate = null; // {shipCode, sailDate} captured from entity/cabins POST

    // Wildcard interceptor: rewrites the navigation PUT to firstOkCode so the
    // distribution page renders with an OK category (shows "Change Staterooms").
    // Also inspects the PUT response to capture the numeric booking session ID (bookingResId)
    // needed for GET /rest/availability/cabins/{bookingResId}.
    if (firstOkCtgInfo) {
      await page.route("**/rest/booking/cabins/**", async (route) => {
        if (route.request().method() !== "PUT") { await route.continue(); return; }
        let body;
        try { body = JSON.parse(route.request().postData() ?? "{}"); } catch { await route.continue(); return; }
        if (Array.isArray(body.cabinsVal) && body.cabinsVal[0]) {
          body.cabinsVal[0] = {
            ...body.cabinsVal[0],
            ctgInfo:         firstOkCtgInfo,
            promotionsVal:   firstOkRawCat?.promoCodesVal ?? [],
            cabinPrice:      firstOkRawCat?.cabinPrice ?? 0,
            inventoryResult: "OK",
            requestedCabin:  null
          };
        }
        // route.fetch() can time out under load — an unhandled rejection
        // inside a Playwright route handler crashes the whole process, not
        // just this request, so this must never be allowed to throw.
        try {
          const response = await route.fetch({ postData: JSON.stringify(body) });
          const respText = await response.text();
          console.log(`[celestyal] initial PUT resp(600): ${respText.slice(0, 600)}`);
          try {
            const json = JSON.parse(respText);
            const scan = (obj, depth = 0) => {
              if (depth > 8 || bookingResId != null) return;
              if (!obj || typeof obj !== "object") return;
              for (const [k, v] of Object.entries(obj)) {
                if (typeof v === "number" && v < -10000) {
                  bookingResId = v;
                  console.log(`[celestyal] initial PUT: bookingResId found in "${k}" = ${v}`);
                  return;
                }
                if (typeof v === "object") scan(v, depth + 1);
              }
            };
            scan(json);
          } catch {}
          await route.fulfill({ status: response.status(), headers: response.headers(), body: respText });
        } catch (err) {
          console.log(`[celestyal] route.fetch failed for initial booking/cabins PUT: ${err.message} — passing through unmodified`);
          await route.continue().catch(() => {});
        }
      });
    }

    // Intercept entity/cabins POST during initial navigation:
    // - Capture the request body template (shipCode + sailDate) for reuse per-category
    // - entity/cabins returns the cabin list directly as [{cabinNumber, deckNumber, capacity,...}]
    //   so we can POST it per-category skipping all UI navigation
    await page.route("**/rest/entity/cabins*", async (route) => {
      if (!entityCabinsTemplate) {
        try {
          const reqJson = JSON.parse(route.request().postData() ?? "{}");
          entityCabinsTemplate = { shipCode: reqJson.shipCode, sailDate: reqJson.sailDate };
          console.log(`[celestyal] entity/cabins template captured: ship=${reqJson.shipCode} sailDate=${JSON.stringify(reqJson.sailDate)}`);
        } catch {}
      }
      await route.continue();
    });

    let distribUrl = "";
    for (let plusAttempt = 0; plusAttempt < 3; plusAttempt++) {
      // Click any visible ivx-plus (the interceptor handles the category)
      const clicked = await page.evaluate((n) => {
        const btns = [...document.querySelectorAll("a.ivx-plus")]
          .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (btns[n]) { btns[n].click(); return `nth:${n}`; }
        if (btns[0]) { btns[0].click(); return "first"; }
        return null;
      }, plusAttempt);
      console.log(`[celestyal] ivx-plus click attempt ${plusAttempt + 1}: ${clicked}`);
      if (!clicked) break;
      await page.waitForTimeout(2000); // wait for GWT panel to render before clickContinue

      await clickContinue(`category→distribution #${plusAttempt + 1}`);
      await page.waitForTimeout(5000);

      distribUrl = await page.url();
      console.log(`[celestyal] after Continue attempt ${plusAttempt + 1}: URL = ${distribUrl}`);
      await saveDebugSnapshot(page, `after-continue-${plusAttempt + 1}`);

      if (distribUrl.includes("vx-cabinDistrib")) {
        // Log ALL API responses that fire on the distribution page to discover
        // any cabin-availability endpoint we may not be capturing yet.
        const distribResponses = [];
        const distribRespHandler = (resp) => {
          const url = resp.url();
          if (url.includes("/touchb2b/") && !url.match(/\.(png|jpg|gif|css|js|ico|woff)/i))
            distribResponses.push(`${resp.status()} ${new URL(url).pathname}`);
        };
        page.on("response", distribRespHandler);
        await page.waitForTimeout(3000);
        page.off("response", distribRespHandler);
        if (distribResponses.length)
          console.log(`[celestyal] distribution page responses: ${distribResponses.join(" | ")}`);
        break;
      }
      console.log("[celestyal] still on category page, retrying +→Continue");
    }

    // Remove navigation interceptors — per-category interceptors are set up in the loop below
    if (firstOkCtgInfo) {
      await page.unroute("**/rest/booking/cabins/**").catch(() => {});
    }
    await page.unroute("**/rest/entity/cabins*").catch(() => {});
    page.off("request", onPutRequest);
    console.log(`[celestyal] entityCabinsTemplate: ${JSON.stringify(entityCabinsTemplate)}`);

    if (!putBodyTemplate || !bookingResGUID) {
      await saveDebugSnapshot(page, "distribution-no-put");
      throw new Error(`PUT /rest/booking/cabins not captured (last URL: ${distribUrl})`);
    }

    console.log(`[celestyal] bookingResGUID: ${bookingResGUID}`);

    // ── Step 5: Per-category cabin availability via direct API calls ─────────
    //
    // For each OK category:
    //   1. PUT /rest/booking/cabins/{guid} (via fetch) — sets category in session
    //   2. GET /rest/availability/cabins/{resId}?... (via fetch) — returns available cabins
    // No UI navigation, no clicking buttons. Falls back to entity/cabins if GET returns nothing.
    const cabinsByCategory = {};

    const okCategories  = match.cabinCategories.filter(c => c.avlResult === "OK");
    const wtlCategories = match.cabinCategories.filter(c => c.avlResult !== "OK");
    for (const cat of wtlCategories) cabinsByCategory[cat.code] = [];

    // Entity/cabins fallback — full physical inventory (used if availability GET returns nothing)
    const entityCabinsByCategory = {};
    if (entityCabinsTemplate) {
      console.log(`[celestyal] pre-collecting entity/cabins fallback for ${okCategories.length} OK categories`);
      for (const cat of okCategories) {
        try {
          const entityResult = await page.evaluate(async (body) => {
            try {
              const r = await fetch("/touchb2b/rest/entity/cabins", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(body)
              });
              if (!r.ok) return null;
              return await r.json();
            } catch { return null; }
          }, { ...entityCabinsTemplate, category: cat.code });

          if (Array.isArray(entityResult) && entityResult.length > 0) {
            entityCabinsByCategory[cat.code] = entityResult.map(item => ({
              cabinNumber: String(item.cabinNumber),
              deckNumber:  item.deckNumber != null ? Math.round(item.deckNumber) : null,
              deckName:    item.deckNumber != null ? `Deck ${Math.round(item.deckNumber)}` : null,
              capacity:    item.capacity   != null ? Math.round(item.capacity)   : null,
              status:      "Available"
            }));
            console.log(`[celestyal] ${cat.code}: ${entityCabinsByCategory[cat.code].length} entity/cabins (fallback ready)`);
          }
        } catch (e) {
          console.log(`[celestyal] ${cat.code}: entity/cabins pre-collect error – ${e.message}`);
        }
      }
    }

    // Extract dep/arr IDs from the captured PUT body — same values used in the GET query string
    const depRefId     = putBodyTemplate?.depIdVal ?? match.rawPayload?.departureIdVal ?? null;
    const arrRefId     = putBodyTemplate?.arrIdVal ?? match.rawPayload?.arrivalIdVal   ?? null;
    const shipCodeParam = putBodyTemplate?.shipCode ?? match.shipCode ?? cruiseCode.substring(0, 2);
    const resIdInt      = bookingResId != null ? Math.round(bookingResId) : null;

    console.log(`[celestyal] cabin fetch params: resId=${resIdInt}, ship=${shipCodeParam}, dep=${depRefId}, arr=${arrRefId}`);
    console.log(`[celestyal] fetching ${okCategories.length} OK categories via direct API`);

    for (const cat of okCategories) {
      try {
        // PUT: update booking session to select this category
        if (putBodyTemplate && bookingResGUID) {
          const rawCat       = (match.rawPayload.ctgsVal ?? []).find(c => c.ctgInfo?.code === cat.code);
          const targetCtgInfo = rawCat?.ctgInfo ?? { ship: match.shipCode, code: cat.code, spaceTypeVal: "CABIN" };

          const putBody = JSON.parse(JSON.stringify(putBodyTemplate));
          if (Array.isArray(putBody.cabinsVal) && putBody.cabinsVal[0]) {
            putBody.cabinsVal[0] = {
              ...putBody.cabinsVal[0],
              ctgInfo:         targetCtgInfo,
              promotionsVal:   rawCat?.promoCodesVal ?? [],
              cabinPrice:      rawCat?.cabinPrice    ?? 0,
              inventoryResult: "OK",
              requestedCabin:  null
            };
          }

          const putResult = await page.evaluate(async ({ guid, body }) => {
            try {
              const r = await fetch(`/touchb2b/rest/booking/cabins/${guid}`, {
                method: "PUT", credentials: "include",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(body)
              });
              return { status: r.status };
            } catch (e) { return { error: e.message }; }
          }, { guid: bookingResGUID, body: putBody });

          if (putResult.error) console.log(`[celestyal] ${cat.code}: PUT error – ${putResult.error}`);
          else console.log(`[celestyal] ${cat.code}: PUT ${putResult.status}`);
        }

        // GET: fetch available cabins for the now-selected category
        if (resIdInt && depRefId && arrRefId) {
          const availCabins = await page.evaluate(async ({ resId, ship, dep, arr }) => {
            try {
              const url = `/touchb2b/rest/availability/cabins/${resId}?shipCode=${ship}&depRefId=${dep}&arrRefId=${arr}&withResCabins=true&showAllCabins=false&withConnectingCabins=false`;
              const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
              if (!r.ok) return null;
              return await r.json();
            } catch { return null; }
          }, { resId: resIdInt, ship: shipCodeParam, dep: depRefId, arr: arrRefId });

          if (Array.isArray(availCabins) && availCabins.length > 0) {
            cabinsByCategory[cat.code] = availCabins.map(item => ({
              cabinNumber: String(item.avlCabin.cabinNumber),
              deckNumber:  item.avlCabin.deckVal != null ? Math.round(item.avlCabin.deckVal) : null,
              deckName:    item.avlCabin.deckVal != null ? `Deck ${Math.round(item.avlCabin.deckVal)}` : null,
              capacity:    item.avlCabin.ctgInfo?.capacityVal ?? null,
              status:      "Available"
            }));
            console.log(`[celestyal] ${cat.code}: ${availCabins.length} available cabins (direct GET)`);
            continue;
          }
        }

        // Fallback to entity/cabins
        const entityFallback = entityCabinsByCategory[cat.code] ?? [];
        cabinsByCategory[cat.code] = entityFallback;
        console.log(`[celestyal] ${cat.code}: ${entityFallback.length} cabins (entity/cabins fallback)`);

      } catch (e) {
        console.log(`[celestyal] ${cat.code}: error – ${e.message}`);
        cabinsByCategory[cat.code] = entityCabinsByCategory[cat.code] ?? [];
      }
    }

    console.log(`[celestyal] ${Object.keys(cabinsByCategory).length} categories with cabin data:`,
      Object.entries(cabinsByCategory).map(([k, v]) => `${k}:${v.length}`).join(", "));

    // Enrich each cabin category with its individual cabins
    match.cabinCategories = match.cabinCategories.map(cat => ({
      ...cat,
      cabins: cabinsByCategory[cat.code] ?? []
    }));

    return match;
  } finally {
    await session.close();
  }
}

export async function authenticateCelestyal() {
  const session = await createScraperSession({
    userDataDir: "./sessions/celestyal-user-data",
    storageStatePath: "./sessions/.auth/celestyal-storage.json",
    headless: false,
    slowMo: 80
  });

  try {
    const authResult = await ensureCelestyalAuthentication(session);

    return {
      vendorKey: "celestyal",
      browserMode: session.mode,
      ...authResult
    };
  } catch (error) {
    error.message = `Celestyal authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

// Navigates back to the cruise search results page (vx-voyageSearchInterval) from anywhere
// in the wizard (category page, distribution page, etc.) using browser history.
async function goBackToCelestyalResults(page) {
  const isOnResults = () => page.url().includes("vx-voyageSearchInterval");
  const tableVisible = () => page.locator("table tbody tr").first().isVisible().catch(() => false);

  if (isOnResults()) {
    await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    return;
  }
  // Table already visible at current URL (e.g. post-search form URL for first cruise)
  if (await tableVisible()) {
    console.log("[celestyal] goBackToCelestyalResults: table already visible at", page.url());
    return;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (isOnResults() || await tableVisible()) {
      await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      console.log(`[celestyal] goBackToCelestyalResults: back on results at ${page.url()} (attempt ${attempt + 1})`);
      return;
    }
  }
  console.warn("[celestyal] goBackToCelestyalResults: could not return to results, url:", page.url());
}

// Same wizard-state cleanup pattern used by Azamara (same SeaWare/Infor booking
// platform, same jQM "Exit Editing" affordance): click Exit Editing if present,
// then navigate to the booking-engine home to guarantee a clean slate before
// re-searching.
async function _celestyalWizardCleanup(page) {
  try {
    const exitClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a, button")]
        .find(el => /exit\s*editing/i.test(el.innerText || "") && el.getBoundingClientRect().width > 0);
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (exitClicked) {
      await page.waitForTimeout(3000);
      console.log("[celestyal] wizard cleanup: clicked Exit Editing");
    } else {
      console.log("[celestyal] wizard cleanup: no Exit Editing button, navigating home");
    }
  } catch {}
  await page.goto("https://sale.celestyal.com/touchb2b/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

// Runs the full "start a new Cruise Booking → Advanced → fill dates → Search"
// flow and waits for the results table. Root-caused live: page.goBack() returns
// to a results page whose jQM event bindings/AJAX handlers are left stale after
// the previous cruise's checkbox-click + Continue submission — row selection
// still "succeeds" (plain DOM query) but Continue never triggers real navigation
// afterward, for every cruise past the first. Re-running the actual search flow
// (same fix already proven working for Azamara, same underlying platform) gives
// each cruise a freshly-bound results page, matching the one path (cruise #1,
// loaded straight from search) that has always worked reliably.
async function runCelestyalSearch(page, fromDate, toDate) {
  await page.getByText("CLICK to start a new Cruise Booking").click();
  await page.waitForLoadState("networkidle");

  const advancedBtn = page.getByText("Advanced");
  await advancedBtn.waitFor({ state: "visible" });
  await advancedBtn.click();

  const dateboxes = page.locator('input[data-role="datebox"]');
  await dateboxes.first().waitFor({ state: "visible" });

  const fromDateInput = dateboxes.nth(0);
  const toDateInput = dateboxes.nth(1);

  await fromDateInput.fill(fromDate);
  await fromDateInput.press("Tab");

  await toDateInput.fill(toDate);
  await toDateInput.press("Tab");

  const responsePromise = page.waitForResponse(
    (resp) => resp.url().includes("/rest/availability/pkgs") && resp.status() === 200,
    { timeout: 120000 }
  );

  await page.getByText("Search Cruises", { exact: true }).click();
  await responsePromise;
  await page.waitForURL(/vx-voyageSearchInterval/, { timeout: 20000 }).catch(() => {});

  // The results table can take longer to render than 20s after many repeated
  // searches in one session (observed live: reliable for the first ~20
  // re-searches in a run, then the table intermittently renders zero rows at
  // the original 20s budget — looks like server-side slowdown under repeated
  // load, not a one-off). Poll for a real row instead of a single wait-and-
  // silently-continue, so callers get an honest signal instead of a false
  // "ready" log immediately followed by "row selected: null".
  let rowCount = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    rowCount = await page.locator("table tbody tr").count().catch(() => 0);
    if (rowCount > 0) break;
    console.log(`[celestyal] runCelestyalSearch: 0 rows after attempt ${attempt + 1}, retrying wait`);
  }
  console.log(`[celestyal] runCelestyalSearch: results page ready, url: ${page.url()}, rows=${rowCount}`);
}

// Internal: given an authenticated page and a normalized cruise match, navigate to
// the booking wizard, select the cruise, and fetch per-cabin data for each category.
// Reuses the existing page — no new browser session opened.
async function _fetchCabinDataForCruise(page, match, fallbackIndex = 0, searchDates = null) {
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Derive departure date filter for row selection from cruise code or startDate
  let departureDateFilter = null;
  const cmCode = (match.id ?? "").match(/(\d{2})(\d{2})(\d{2})$/);
  if (cmCode) {
    const yy = parseInt(cmCode[1], 10), mm = parseInt(cmCode[2], 10), dd = parseInt(cmCode[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      departureDateFilter = `${dd} ${MONTH_ABBR[mm - 1]} ${2000 + yy}`;
    }
  }
  if (!departureDateFilter && match.startDate) {
    const dep = new Date(match.startDate);
    departureDateFilter = `${dep.getDate()} ${MONTH_ABBR[dep.getMonth()]} ${dep.getFullYear()}`;
  }
  if (!departureDateFilter) return match;

  // Get back to a results page for this cruise.
  //
  // ROOT CAUSE (confirmed live via network trace): page.goBack() returns to
  // the SAME results page DOM that the previous cruise already interacted
  // with (checkbox click + Continue submission). That page's jQM event
  // bindings/AJAX handlers are left stale after the transition attempt —
  // row selection still "succeeds" (it's a plain DOM query + .click()) but
  // the Continue click no longer triggers real navigation, so execution gets
  // stuck on vx-voyageSearchInterval for every cruise past the first. This
  // is NOT server-side booking state (that theory was wrong) and NOT
  // specific to cruises sharing a departure date.
  // Fix: for the first cruise, the results page came straight from the live
  // search and is freshly bound — just wait for it. For every cruise after
  // that, re-run the actual search flow (new booking → Advanced → dates →
  // Search) to get a freshly-bound results page, instead of relying on
  // browser history.
  // Celestyal's results table is paginated at ~10-11 rows (confirmed live —
  // see runCelestyalSearch's "rows=11" log). A broad batch-wide re-search
  // (searchDates.fromDate/toDate spanning the whole run) puts later cruises
  // past the first page, where neither date-text matching (their row simply
  // isn't rendered) nor position fallback (matchIndex is the cruise's index
  // in the full batch, not a valid index into an 11-row table) can find them
  // — this is what "Could not find row" meant for cruises past ~row 11.
  // Fix: narrow the re-search to a ~7-day window around THIS cruise's own
  // departure date (same technique already proven in the single-cruise fetch
  // path, fetchCelestyalCruiseByCode) so the table only ever has a handful of
  // rows, and reset matchIndex to 0 since fallbackIndex no longer means
  // anything relative to this narrow result set.
  let matchIndexForRow = fallbackIndex;
  if (fallbackIndex === 0) {
    await goBackToCelestyalResults(page);
  } else if (searchDates) {
    await _celestyalWizardCleanup(page);
    const cmCodeNarrow = (match.id ?? "").match(/(\d{2})(\d{2})(\d{2})$/);
    let narrowFrom = searchDates.fromDate, narrowTo = searchDates.toDate;
    if (cmCodeNarrow) {
      const yy = parseInt(cmCodeNarrow[1], 10), mm = parseInt(cmCodeNarrow[2], 10), dd = parseInt(cmCodeNarrow[3], 10);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        const depDate = new Date(2000 + yy, mm - 1, dd - 3);
        const endDate = new Date(2000 + yy, mm - 1, dd + 7);
        const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        narrowFrom = fmt(depDate);
        narrowTo = fmt(endDate);
      }
    }
    await runCelestyalSearch(page, narrowFrom, narrowTo);
    matchIndexForRow = 0;
  } else {
    await goBackToCelestyalResults(page);
  }
  console.log(`[celestyal] ${match.id}: on results page, dateFilter="${departureDateFilter}" idx=${matchIndexForRow}`);

  // Use the original match data directly (no narrow re-search needed)
  const refreshed  = match;
  const matchIndex = matchIndexForRow;

  // Row selection helper
  await page.waitForTimeout(1500);
  async function selectSailingRow() {
    return page.evaluate(({ ds, pk, rowIdx }) => {
      const visibleRows = [...document.querySelectorAll("table tbody tr")]
        .filter(r => window.getComputedStyle(r).display !== "none");
      document.querySelectorAll('input[type="checkbox"]:checked, input.checkbox-rowsel:checked')
        .forEach(cb => cb.click());
      if (ds) {
        for (const row of visibleRows) {
          const text = row.textContent || "";
          if (!text.includes(ds)) continue;
          if (pk && !text.includes(pk)) continue;
          const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
          if (cb) { cb.click(); return `date+pkg: ${text.trim().slice(0, 120)}`; }
        }
        for (const row of visibleRows) {
          if ((row.textContent || "").includes(ds)) {
            const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
            if (cb) { cb.click(); return `date-only: ${row.textContent.trim().slice(0, 120)}`; }
          }
        }
      }
      if (visibleRows[rowIdx]) {
        const cb = visibleRows[rowIdx].querySelector('input[type="checkbox"], input.checkbox-rowsel');
        if (cb) { cb.click(); return `pos-${rowIdx}: ${visibleRows[rowIdx].textContent.trim().slice(0, 120)}`; }
      }
      if (visibleRows[0]) {
        const cb = visibleRows[0].querySelector('input[type="checkbox"], input.checkbox-rowsel');
        if (cb) { cb.click(); return `first-row: ${visibleRows[0].textContent.trim().slice(0, 120)}`; }
      }
      return null;
    }, { ds: departureDateFilter, pk: refreshed.package ?? null, rowIdx: matchIndex });
  }

  const rowClicked = await selectSailingRow();
  console.log(`[celestyal] ${match.id} row selected: ${rowClicked}`);
  if (!rowClicked) throw new Error(`Could not find row for ${match.id}`);
  await page.waitForTimeout(500);

  // Continue helper (same jQM-aware logic as fetchCelestyalCruiseByCode)
  async function clickContinue(label) {
    let rect = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      rect = await page.evaluate(() => {
        const all = [];
        for (const el of document.querySelectorAll("a, button")) {
          if (!/continue/i.test(el.textContent?.trim())) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) all.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        }
        if (!all.length) return null;
        return all.find(c => c.x < 900) ?? all[0];
      });
      if (rect?.x < 900) break;
      await page.waitForTimeout(1000);
    }
    if (!rect) throw new Error(`Continue button not found (${label})`);
    await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  // Continue → category page
  await clickContinue("search→categories");
  await page.waitForURL(/vx-genCtgAvailSearch|vx-voyageSearchInterval/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // The voyage-interval fallback (re-select row + Continue) previously had no
  // verification that the Continue click actually navigated anywhere — a
  // silently-swallowed waitForURL timeout here (root-caused live: the click
  // sometimes lands before the re-selected row's checkbox state registers)
  // left execution on vx-voyageSearchInterval while every downstream step
  // assumed it was on the category page. That's the actual cause of "still on
  // category page, retrying" for cruises after the first in a batch — not
  // server-side booking state as originally suspected. Retry the whole
  // re-select+Continue sequence (up to 3x) until the URL genuinely changes.
  for (let reselectAttempt = 0; reselectAttempt < 3; reselectAttempt++) {
    if (!(await page.url()).includes("vx-voyageSearchInterval")) break;
    console.log(`[celestyal] ${match.id}: voyage-interval after Continue — re-selecting (attempt ${reselectAttempt + 1})`);
    await page.waitForTimeout(1500);
    const reSelected = await selectSailingRow();
    console.log(`[celestyal] re-selected: ${reSelected}`);
    await page.waitForTimeout(800);
    await clickContinue("voyage-interval→categories");
    await page.waitForURL(/vx-genCtgAvailSearch/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (!(await page.url()).includes("vx-voyageSearchInterval")) {
      console.log(`[celestyal] ${match.id}: reached category page on reselect attempt ${reselectAttempt + 1}`);
      break;
    }
    console.log(`[celestyal] ${match.id}: still on voyage-interval after Continue click — retrying`);
  }

  // Wait for ivx-plus buttons to render
  const firstOkCode     = (refreshed.cabinCategories.find(c => c.avlResult === "OK"))?.code ?? null;
  const firstOkRawCat   = firstOkCode ? (refreshed.rawPayload?.ctgsVal ?? []).find(c => c.ctgInfo?.code === firstOkCode) : null;
  const firstOkCtgInfo  = firstOkRawCat?.ctgInfo ?? (firstOkCode ? { ship: refreshed.shipCode, code: firstOkCode, spaceTypeVal: "CABIN" } : null);

  let ivxPlusFound = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const visibleCount = await page.evaluate(() =>
      [...document.querySelectorAll("a.ivx-plus")]
        .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length
    );
    if (visibleCount > 0) { ivxPlusFound = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!ivxPlusFound) console.log(`      [celestyal] gave up after 20s — no visible ivx-plus button ever appeared`);

  let putBodyTemplate = null, bookingResGUID = null, bookingResId = null, entityCabinsTemplate = null;

  const onPutRequest = (req) => {
    if (!req.url().includes("/rest/booking/cabins/") || req.method() !== "PUT") return;
    try { putBodyTemplate = JSON.parse(req.postData() ?? "{}"); bookingResGUID = req.url().split("/rest/booking/cabins/")[1]; } catch {}
  };
  page.on("request", onPutRequest);

  if (firstOkCtgInfo) {
    await page.route("**/rest/booking/cabins/**", async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      let body;
      try { body = JSON.parse(route.request().postData() ?? "{}"); } catch { await route.continue(); return; }
      if (Array.isArray(body.cabinsVal) && body.cabinsVal[0]) {
        body.cabinsVal[0] = { ...body.cabinsVal[0], ctgInfo: firstOkCtgInfo, promotionsVal: firstOkRawCat?.promoCodesVal ?? [], cabinPrice: firstOkRawCat?.cabinPrice ?? 0, inventoryResult: "OK", requestedCabin: null };
      }
      // route.fetch() can time out under load (observed live: 30s timeout
      // crashed the whole process — an unhandled rejection inside a Playwright
      // route handler is fatal, not just a failed request). Fall back to
      // passing the request through unmodified rather than crashing; the
      // caller's existing retry/failure-per-cruise handling covers the case
      // where this cabin ends up without the injected ctgInfo.
      try {
        const response = await route.fetch({ postData: JSON.stringify(body) });
        const respText = await response.text();
        try {
          const scan = (obj, d = 0) => { if (d > 8 || bookingResId != null || !obj || typeof obj !== "object") return; for (const [,v] of Object.entries(obj)) { if (typeof v === "number" && v < -10000) { bookingResId = v; return; } if (typeof v === "object") scan(v, d + 1); } };
          scan(JSON.parse(respText));
        } catch {}
        await route.fulfill({ status: response.status(), headers: response.headers(), body: respText });
      } catch (err) {
        console.log(`[celestyal] route.fetch failed for booking/cabins PUT: ${err.message} — passing through unmodified`);
        await route.continue().catch(() => {});
      }
    });
  }

  await page.route("**/rest/entity/cabins*", async (route) => {
    if (!entityCabinsTemplate) {
      try { const j = JSON.parse(route.request().postData() ?? "{}"); entityCabinsTemplate = { shipCode: j.shipCode, sailDate: j.sailDate }; } catch {}
    }
    await route.continue();
  });

  let distribUrl = "";
  for (let plusAttempt = 0; plusAttempt < 3; plusAttempt++) {
    const plusClicked = await page.evaluate((n) => {
      const btns = [...document.querySelectorAll("a.ivx-plus")].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (btns[n]) { btns[n].click(); return `nth:${n}`; }
      if (btns[0]) { btns[0].click(); return "first"; }
      return null;
    }, plusAttempt);
    if (!plusClicked) break;
    await page.waitForTimeout(2000);
    await clickContinue(`category→distribution #${plusAttempt + 1}`);
    await page.waitForTimeout(5000);
    distribUrl = await page.url();
    if (distribUrl.includes("vx-cabinDistrib")) { await page.waitForTimeout(3000); break; }
    console.log(`[celestyal] ${match.id}: still on category page, retrying`);
  }

  if (firstOkCtgInfo) await page.unroute("**/rest/booking/cabins/**").catch(() => {});
  await page.unroute("**/rest/entity/cabins*").catch(() => {});
  page.off("request", onPutRequest);

  if (!putBodyTemplate || !bookingResGUID) {
    throw new Error(`PUT /rest/booking/cabins not captured for ${match.id} (last URL: ${distribUrl})`);
  }

  // Per-category cabin fetch via direct API calls
  const cabinsByCategory = {};
  const okCategories  = refreshed.cabinCategories.filter(c => c.avlResult === "OK");
  const wtlCategories = refreshed.cabinCategories.filter(c => c.avlResult !== "OK");
  for (const cat of wtlCategories) cabinsByCategory[cat.code] = [];

  const entityCabinsByCategory = {};
  if (entityCabinsTemplate) {
    for (const cat of okCategories) {
      try {
        const res = await page.evaluate(async (body) => {
          try {
            const r = await fetch("/touchb2b/rest/entity/cabins", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
            return r.ok ? await r.json() : null;
          } catch { return null; }
        }, { ...entityCabinsTemplate, category: cat.code });
        if (Array.isArray(res) && res.length > 0) {
          entityCabinsByCategory[cat.code] = res.map(item => ({ cabinNumber: String(item.cabinNumber), deckNumber: item.deckNumber != null ? Math.round(item.deckNumber) : null, deckName: item.deckNumber != null ? `Deck ${Math.round(item.deckNumber)}` : null, capacity: item.capacity != null ? Math.round(item.capacity) : null, status: "Available" }));
          console.log(`[celestyal] ${cat.code}: ${entityCabinsByCategory[cat.code].length} entity/cabins (fallback ready)`);
        }
      } catch {}
    }
  }

  const depRefId      = putBodyTemplate?.depIdVal ?? refreshed.rawPayload?.departureIdVal ?? null;
  const arrRefId      = putBodyTemplate?.arrIdVal ?? refreshed.rawPayload?.arrivalIdVal   ?? null;
  const shipCodeParam = putBodyTemplate?.shipCode ?? refreshed.shipCode ?? null;
  const resIdInt      = bookingResId != null ? Math.round(bookingResId) : null;

  console.log(`[celestyal] ${match.id}: fetching ${okCategories.length} OK categories (resId=${resIdInt})`);

  for (const cat of okCategories) {
    try {
      if (putBodyTemplate && bookingResGUID) {
        const rawCat = (refreshed.rawPayload?.ctgsVal ?? []).find(c => c.ctgInfo?.code === cat.code);
        const targetCtgInfo = rawCat?.ctgInfo ?? { ship: refreshed.shipCode, code: cat.code, spaceTypeVal: "CABIN" };
        const putBody = JSON.parse(JSON.stringify(putBodyTemplate));
        if (Array.isArray(putBody.cabinsVal) && putBody.cabinsVal[0]) {
          putBody.cabinsVal[0] = { ...putBody.cabinsVal[0], ctgInfo: targetCtgInfo, promotionsVal: rawCat?.promoCodesVal ?? [], cabinPrice: rawCat?.cabinPrice ?? 0, inventoryResult: "OK", requestedCabin: null };
        }
        await page.evaluate(async ({ guid, body }) => {
          await fetch(`/touchb2b/rest/booking/cabins/${guid}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
        }, { guid: bookingResGUID, body: putBody });
      }

      if (resIdInt && depRefId && arrRefId) {
        const availCabins = await page.evaluate(async ({ resId, ship, dep, arr }) => {
          try {
            const url = `/touchb2b/rest/availability/cabins/${resId}?shipCode=${ship}&depRefId=${dep}&arrRefId=${arr}&withResCabins=true&showAllCabins=false&withConnectingCabins=false`;
            const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
            return r.ok ? await r.json() : null;
          } catch { return null; }
        }, { resId: resIdInt, ship: shipCodeParam, dep: depRefId, arr: arrRefId });

        if (Array.isArray(availCabins) && availCabins.length > 0) {
          cabinsByCategory[cat.code] = availCabins.map(item => ({ cabinNumber: String(item.avlCabin.cabinNumber), deckNumber: item.avlCabin.deckVal != null ? Math.round(item.avlCabin.deckVal) : null, deckName: item.avlCabin.deckVal != null ? `Deck ${Math.round(item.avlCabin.deckVal)}` : null, capacity: item.avlCabin.ctgInfo?.capacityVal ?? null, status: "Available" }));
          console.log(`[celestyal] ${cat.code}: ${availCabins.length} available cabins`);
          continue;
        }
      }

      const fallback = entityCabinsByCategory[cat.code] ?? [];
      cabinsByCategory[cat.code] = fallback;
      console.log(`[celestyal] ${cat.code}: ${fallback.length} cabins (entity fallback)`);
    } catch (e) {
      cabinsByCategory[cat.code] = entityCabinsByCategory[cat.code] ?? [];
      console.log(`[celestyal] ${cat.code}: error – ${e.message}`);
    }
  }

  refreshed.cabinCategories = refreshed.cabinCategories.map(cat => ({
    ...cat,
    cabins: cabinsByCategory[cat.code] ?? []
  }));

  return refreshed;
}

// The ship dropdown ("CD Celestyal Discovery" / "CJ Celestyal Journey") sits
// right on the main Voyage modal (not inside Advanced) — found by its <label>
// text since GWT auto-generates the actual element id per session.
async function selectCelestyalShip(page, shipName) {
  const shipFilter = shipName.trim().toUpperCase();
  const matched = await page.evaluate((filter) => {
    // Filter to offsetParent !== null — GWT forms can hold a stale/decoy
    // "Ship"-labeled select from an earlier render alongside the real live one
    // (confirmed on Azamara's identical form family), and selecting on the
    // decoy silently has no effect on the actual search request.
    const selects = [...document.querySelectorAll('select')].filter(s => s.offsetParent !== null);
    const target = selects.find(s => {
      const lab = s.closest('label')?.innerText || document.querySelector(`label[for="${s.id}"]`)?.innerText;
      return lab && lab.trim().toLowerCase() === 'ship';
    });
    if (!target) return null;
    const opt = [...target.options].find(o => o.textContent.toUpperCase().includes(filter));
    return opt ? { selectId: target.id, value: opt.value, label: opt.textContent.trim() } : { selectId: target.id, value: null };
  }, shipFilter);

  if (!matched?.value) {
    console.log(`[celestyal] ship filter "${shipName}" — no matching option found in Ship dropdown, leaving unfiltered`);
    return false;
  }
  try {
    await page.locator(`#${matched.selectId}`).selectOption(matched.value, { timeout: 10000 });
  } catch (err) {
    // Same GWT form family as Azamara — native selectOption can time out on a
    // select that's visible/attached but not "actionable" by Playwright's
    // strict checks. Fall back to a direct value-set + change event.
    console.log(`[celestyal] native selectOption failed (${err.message.split("\n")[0]}) — falling back to JS value-set`);
    await page.evaluate(({ selectId, value }) => {
      const el = document.getElementById(selectId);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { selectId: matched.selectId, value: matched.value });
  }
  console.log(`[celestyal] ship filter set: ${matched.label}`);
  return true;
}

export async function runCelestyalScraper(options = {}) {
  const {
    fromDate = "10/05/2026",
    toDate   = "20/07/2026",
    listOnly = true,
    maxDeckCruises = Infinity,
    shipName = null, // optional, e.g. "Discovery" or "Journey" — filters via the site's own Ship dropdown
  } = options;

  const session = await createScraperSession({
    userDataDir: "./sessions/celestyal-user-data",
    storageStatePath: "./sessions/.auth/celestyal-storage.json",
    headless: false,
    slowMo: 80
  });

  const { page } = session;

  try {
    const authResult = await ensureCelestyalAuthentication(session);

    console.log("[celestyal] starting booking flow");
    await page.getByText("CLICK to start a new Cruise Booking").click();
    await page.waitForLoadState("networkidle");
    console.log("[celestyal] booking page loaded", await page.url());

    const advancedBtn = page.getByText("Advanced");
    await advancedBtn.waitFor({ state: "visible" });
    await advancedBtn.click();
    console.log("[celestyal] advanced search opened");

    // Select the ship BEFORE filling dates — selecting an option in the Ship
    // dropdown triggers the form's own reactive sync and resets the "To" date
    // box back to whatever the Month/Year picker shows, silently collapsing
    // the search window to a single day if dates were filled first (verified:
    // this caused runs to hang waiting for a response that never came).
    if (shipName) await selectCelestyalShip(page, shipName);

    const dateboxes = page.locator('input[data-role="datebox"]');
    await dateboxes.first().waitFor({ state: "visible" });

    const fromDateInput = dateboxes.nth(0);
    const toDateInput = dateboxes.nth(1);

    await fromDateInput.fill(fromDate);
    await fromDateInput.press("Tab");

    await toDateInput.fill(toDate);
    await toDateInput.press("Tab");
    console.log("[celestyal] dates filled", { fromDate, toDate });

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/rest/availability/pkgs") && resp.status() === 200,
      { timeout: 120000 }
    );
    // A genuinely empty result set (e.g. a ship filter that has no sailings in
    // this date window) never fires /rest/availability/pkgs at all — the site
    // shows a plain "Your search did not match any results" info modal instead.
    // Race both so a real 0-result search returns immediately instead of
    // burning the full 120s timeout before failing the whole run.
    const noResultsPromise = page.locator('text=Your search did not match any results')
      .waitFor({ state: "visible", timeout: 120000 })
      .then(() => "no-results");

    await page.getByText("Search Cruises", { exact: true }).click();
    console.log("[celestyal] search submitted, waiting for availability response");

    const outcome = await Promise.race([responsePromise, noResultsPromise]);
    if (outcome === "no-results") {
      console.log(`[celestyal] search matched 0 cruises${shipName ? ` (ship filter "${shipName}")` : ""}`);
      await page.getByRole("button", { name: "Close" }).click().catch(() => {});
      return {
        vendorKey: "celestyal",
        source: "celestyal",
        browserMode: session.mode,
        authentication: authResult,
        extracted: [],
        cruises: [],
      };
    }

    const response = outcome;
    console.log("[celestyal] availability response received", response.url());
    // Wait for the results table to appear before starting cabin loop
    await page.waitForURL(/vx-voyageSearchInterval/, { timeout: 20000 }).catch(() => {});
    await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    console.log("[celestyal] results page ready, url:", page.url());

    const extracted = await response.json();
    // One CMS fetch per run supplies stops for every sailing below.
    const itineraryMap = await fetchItineraryMap(page).catch((err) => {
      console.log(`[celestyal] itinerary CMS fetch failed (${err.message.split("\n")[0]}) — continuing without stops`);
      return null;
    });
    const cruises = (extracted || [])
      .map((item) => normalizeCelestyalCruise(item, itineraryMap))
      .filter((cruise) => cruise.id);

    if (!listOnly && cruises.length > 0) {
      // Cruises that already have cabin rows in the DB go LAST. Without this,
      // a capped run always re-fetched the same already-covered sailings in
      // list order and never reached the ones with no deck data at all — the
      // same bug found in GOCCL's deck pass (see goccl.js), just not yet hit
      // here because Celestyal's list order happened to put gaps early.
      const codesWithCabins = new Set(
        (await prisma.cruise.findMany({
          where: { vendor: { slug: "celestyal" }, cabinCategories: { some: { cabins: { some: {} } } } },
          select: { code: true }
        })).map((c) => c.code)
      );
      // A cruise that's 100% Waitlist has nothing bookable to fetch cabins
      // for — treating it as "missing decks" made it permanently hog the
      // front of every capped run (confirmed live: CD04260901, all 9
      // categories WTL, chosen first every time, 0 cabins possible). Only
      // cruises with at least one OK category are real deck-fetch targets.
      const hasFetchableCategory = (c) => (c.cabinCategories ?? []).some((cc) => cc.avlResult === "OK");
      const priority = (c) => {
        if (codesWithCabins.has(c.id)) return 2;       // already covered
        if (!hasFetchableCategory(c)) return 2;         // nothing bookable
        return 1;                                        // real gap
      };
      const ordered = [...cruises].sort((a, b) => priority(a) - priority(b));
      const missingCount = ordered.filter((c) => priority(c) === 1).length;
      console.log(`[celestyal] ${missingCount}/${ordered.length} candidates lack cabin data — those go first`);

      const limit = Math.min(ordered.length, maxDeckCruises);
      console.log(`\n[celestyal] Full detail mode — fetching cabin data for ${limit}/${ordered.length} cruises`);
      const byId = new Map(cruises.map((c, idx) => [c.id, idx]));
      for (let i = 0; i < limit; i++) {
        console.log(`\n[celestyal] [${i + 1}/${limit}] cabin fetch: ${ordered[i].id}`);
        try {
          const enriched = await _fetchCabinDataForCruise(page, ordered[i], i, { fromDate, toDate });
          if (enriched) cruises[byId.get(ordered[i].id)] = enriched;
        } catch (err) {
          console.error(`[celestyal] [${i + 1}/${limit}] cabin fetch failed: ${err.message}`);
        }
        if (i < limit - 1) await page.waitForTimeout(2000);
      }
    }

    return {
      vendorKey: "celestyal",
      source: "celestyal",
      browserMode: session.mode,
      authentication: authResult,
      extracted,
      cruises
    };
  } catch (error) {
    try {
      const screenshotPath = await saveDebugSnapshot(page, "failure");
      console.error("[celestyal] debug screenshot saved:", screenshotPath);
      console.error("[celestyal] current url:", await page.url());
    } catch (snapshotError) {
      console.error("[celestyal] failed to save debug screenshot:", snapshotError.message);
    }

    error.message = `Celestyal scraper failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}
