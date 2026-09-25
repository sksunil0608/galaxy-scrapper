import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";
import { ensureVendor, ingestCruise } from "../../services/cruiseIngestionService.js";
import prisma from "../../config/prisma.js";

dotenv.config();

const USERNAME = process.env.AZAMARA_USER;
const PASSWORD = process.env.AZAMARA_PASS;

const CONNECT_LOGIN_URL = "https://connect.azamara.com/login";
const SEAWARE_BASE      = "https://seaware.azamara.com";

// ── helpers ─────────────────────────────────────────────────────────────────

function unique(values = []) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Cabin classification (canonical: Suite | Balcony | Oceanview | Interior) ─

function mapGenericCategoryToType(code, description) {
  const c = String(code ?? "").toUpperCase();
  const d = String(description ?? "").toUpperCase();
  if (c.includes("BALCONY") || d.includes("BALCONY") || d.includes("VERANDA")) return "Balcony";
  if (c.includes("OUTSIDE") || d.includes("OUTSIDE") || c.includes("OCEAN") || d.includes("OCEAN") ||
      c.includes("EXTERIOR") || d.includes("EXTERIOR") || c.includes("WINDOW") || d.includes("WINDOW")) return "Exterior";
  if (c.includes("INSIDE") || d.includes("INSIDE") || c.includes("INTERIOR") || d.includes("INTERIOR")) return "Interior";
  if (c.includes("DELUXE") || d.includes("SUITE") || d.includes("DELUXE")) return "Suite";
  return null;
}

function inferCabinType(category) {
  const web   = category.genericCategoriesVal?.WEB;
  const pri   = category.genericCategoriesVal?.PRICING;
  const tav   = category.genericCategoriesVal?.["PRICING TRAVEL AGENT"];
  const desc  = category.ctgInfo?.description;
  return (
    mapGenericCategoryToType(web?.code, web?.description) ??
    mapGenericCategoryToType(pri?.code, pri?.description) ??
    mapGenericCategoryToType(tav?.code, tav?.description) ??
    mapGenericCategoryToType(category.ctgInfo?.code, desc) ??
    mapGenericCategoryToType(desc, desc)
  );
}

function inferCabinStatus(avlResult) {
  if (avlResult === "OK") return "Available";
  if (avlResult === "WTL") return "Waitlist";
  if (avlResult === "SLD") return "Sold Out";
  return avlResult ?? null;
}

function getInvoiceAmount(invoiceValues = [], code) {
  return invoiceValues
    .filter((entry) => entry.code === code)
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
}

function buildCategoryClassifications(category) {
  return Object.entries(category.genericCategoriesVal ?? {}).map(([linkType, value]) => ({
    linkType,
    code: value?.code ?? null,
    name: value?.name ?? null,
    description: value?.description ?? null,
    rank: normalizeInteger(value?.rankVal),
    shipCode: value?.ship ?? null
  })).filter((entry) => entry.code);
}

function inferCabinConfidence(category) {
  if (
    category.ctgInfo?.code &&
    category.ctgInfo?.description &&
    category.cabinPrice != null &&
    category.nofCabinsVal != null &&
    category.count != null
  ) return "High";
  if (category.ctgInfo?.code && category.cabinPrice != null) return "Medium";
  return "Low";
}

function buildCabinCategoriesFromCtgs(ctgsVal = []) {
  return ctgsVal
    .filter((category) => category.ctgInfo?.code)
    .map((category) => ({
      code: category.ctgInfo.code,
      name: category.ctgInfo.description ?? null,
      group: inferCabinType(category),
      status: inferCabinStatus(category.avlResultVal),
      avlResult: category.avlResultVal ?? null,
      total: normalizeInteger(category.nofCabinsVal),
      avail: normalizeInteger(category.count),
      cabinPrice: normalizeDecimal(category.cabinPrice),
      perPersonPrice: normalizeDecimal(category.perPersonPrice),
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

// ── Cruise normalization ────────────────────────────────────────────────────

function buildCruiseCode(item) {
  return item.pkg?.pkgCode ?? null;
}

function parseRouteLabel(item) {
  const portFrom = item.locFrom ?? item.pkg?.locFrom?.code ?? null;
  const portTo   = item.locTo   ?? item.pkg?.locTo?.code   ?? null;
  if (!portFrom && !portTo) return null;
  return `${portFrom ?? "Unknown"} -> ${portTo ?? "Unknown"}`;
}

function buildCruisePromotions(item) {
  return unique((item.ctgsVal ?? []).flatMap((c) => c.promoCodesVal ?? []));
}

function inferCruiseConfidence(item) {
  return (item.ctgsVal?.length ?? 0) > 0 ? "Medium" : "Low";
}

// /availability/pkgs returns `ship` as a bare 2-letter fleet code (JR/ON/PR/QS),
// not a display name — a manual DB backfill fixed this once, but every
// subsequent scrape re-ingested the raw code and silently reverted it back to
// "PR" etc, since normalizeAzamaraCruise never resolved it. Fixed here so it
// stays fixed regardless of how many times a cruise gets re-scraped.
const AZAMARA_SHIP_NAMES = {
  JR: "Azamara Journey", ON: "Azamara Onward", PR: "Azamara Pursuit", QS: "Azamara Quest",
};

function normalizeAzamaraCruise(item) {
  const id = buildCruiseCode(item);
  if (!id) return null;

  const portFrom = item.locFrom ?? item.pkg?.locFrom?.code ?? null;
  const portTo   = item.locTo   ?? item.pkg?.locTo?.code   ?? null;

  return {
    id,
    ship:        AZAMARA_SHIP_NAMES[item.ship] ?? item.ship ?? null,
    shipCode:    item.ship ?? null,
    shipDetails: null,
    package:     item.pkg?.pkgName ?? null,
    portFrom,
    portTo,
    routeLabel:  parseRouteLabel(item),
    nights:      normalizeInteger(item.sailLengthVal ?? item.pkg?.daysVal),
    startDate:   item.startDateVal?.utc ?? item.startDateVal?.local ?? null,
    endDate:     item.endDateVal?.utc   ?? item.endDateVal?.local   ?? null,
    seatsAvailable: normalizeInteger(item.avlGuestsVal),
    totalCapacity:  null,
    totalCabins:    null,
    trend:          null,
    confidence:     inferCruiseConfidence(item),
    pinned:         false,
    currency:       item.ctgsVal?.[0]?.currency ?? "GBP",
    promotions:     buildCruisePromotions(item),
    cabinCategories: buildCabinCategoriesFromCtgs(item.ctgsVal ?? []),
    rawPayload:     item
  };
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function ensureAzamaraAuthentication(session) {
  const { page } = session;

  if (!USERNAME || !PASSWORD) {
    throw new Error("AZAMARA_USER and AZAMARA_PASS must be set in .env before using the Azamara scraper.");
  }

  // Try the seaware app first — if our stored session is still valid, the SAML
  // SSO chain completes silently and we land on /touchb2b/?sign=...
  console.log("[azamara] trying seaware /touch/ (session reuse path)");
  await page.goto(`${SEAWARE_BASE}/touch/`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  await page.waitForURL((u) => {
    const s = u.toString();
    return s.includes("seaware.azamara.com/touchb2b/") || s.includes("connect.azamara.com/login") || s.includes("id.azamara.com");
  }, { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);
  if (page.url().includes("seaware.azamara.com/touchb2b/")) {
    console.log("[azamara] session reused, landed at:", page.url());
    return { success: true, alreadyLoggedIn: true, message: "Azamara session reused." };
  }

  // Otherwise we got bounced to Okta — do the full login flow
  console.log("[azamara] full login required, navigating to /login");
  await page.goto(CONNECT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  await Promise.race([
    page.waitForURL((u) => u.toString().includes("connect.azamara.com/home"), { timeout: 8000 }),
    page.locator('input[name="identifier"]').waitFor({ state: "visible", timeout: 8000 }),
  ]).catch(() => null);
  await page.waitForTimeout(2000);
  let url = page.url();
  console.log("[azamara] /login resolved to:", url);

  const onHome = url.includes("connect.azamara.com/home");
  const onLogin = url.includes("connect.azamara.com/login");

  if (!onHome) {
    // Need to fill the Okta form
    if (!onLogin) {
      // Sometimes lands on auth callback or other intermediate page
      await page.goto(CONNECT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(3000);
    }

    const usernameField = page.locator('input[name="identifier"]');
    await usernameField.waitFor({ state: "visible", timeout: 20000 });
    await usernameField.fill(USERNAME);
    await page.locator('input[type="submit"], button[type="submit"]').first().click();
    await page.waitForTimeout(3000);

    const passwordSelect = page.locator('div.authenticator-description:has(h3:has-text("Password")) a[data-se="button"]').first();
    if (await passwordSelect.isVisible().catch(() => false)) {
      await passwordSelect.click();
      await page.waitForTimeout(2000);
    }

    const passwordField = page.locator('input[name="credentials.passcode"], input[type="password"]').first();
    await passwordField.waitFor({ state: "visible", timeout: 15000 });
    await passwordField.fill(PASSWORD);
    await page.locator('input[type="submit"], button[type="submit"]').first().click();
    await page.waitForTimeout(8000);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => null);
    console.log("[azamara] post-login url:", page.url());
    await session.persistAuthState();
  } else {
    console.log("[azamara] Okta already authenticated");
  }

  // Trigger SAML SSO into seaware so the seaware cookies get established.
  // Visiting /touch/ from a signed-in connect session redirects through Okta
  // SAML and lands on seaware.azamara.com/touchb2b/?sign=...
  console.log("[azamara] establishing seaware session via SSO");
  await page.goto(`${SEAWARE_BASE}/touch/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForURL((u) => u.toString().includes("seaware.azamara.com/touchb2b/"), { timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(4000);
  console.log("[azamara] seaware SSO landed at:", page.url());
  await session.persistAuthState();

  return { success: true, alreadyLoggedIn: onHome, message: "Azamara authenticated." };
}

// ── Search via /availability/pkgs ───────────────────────────────────────────

// The Ship dropdown (e.g. "JR Azamara Journey", "QS Azamara Quest") sits right
// on the main voyage search form alongside From/To dates — found by its
// <label> text since GWT auto-generates the actual element id per session.
async function selectAzamaraShip(page, shipName) {
  const shipFilter = shipName.trim().toUpperCase();

  // The DOM holds TWO "Ship"-labeled <select> elements — a stale/decoy one
  // (zero-size, offsetParent null) left over from an earlier form render, and
  // the real jQuery-Mobile-enhanced one actually wired to the search. Picking
  // the first match (the decoy) meant selectOption "succeeded" on an element
  // with no effect on the real form's shipsVal — confirmed via the actual
  // search request payload coming back with shipsVal:[] despite the log
  // claiming success. Must filter to offsetParent !== null to get the live one.
  let matched = null;
  for (let attempt = 0; attempt < 10 && !matched; attempt++) {
    matched = await page.evaluate((filter) => {
      const selects = [...document.querySelectorAll('select')].filter(s => s.offsetParent !== null);
      const target = selects.find(s => {
        const lab = s.closest('label')?.innerText || document.querySelector(`label[for="${s.id}"]`)?.innerText;
        return lab && lab.trim().toLowerCase() === 'ship';
      });
      if (!target) return null;
      const opt = [...target.options].find(o => o.textContent.toUpperCase().includes(filter));
      return opt ? { selectId: target.id, value: opt.value, label: opt.textContent.trim() } : { selectId: target.id, value: null };
    }, shipFilter);
    if (!matched) await page.waitForTimeout(1000);
  }

  if (!matched) {
    console.log(`[azamara] ship filter "${shipName}" — Ship dropdown never appeared, leaving unfiltered`);
    return false;
  }
  if (!matched.value) {
    console.log(`[azamara] ship filter "${shipName}" — no matching option found in Ship dropdown, leaving unfiltered`);
    return false;
  }

  await page.locator(`#${matched.selectId}`).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(`#${matched.selectId}`).selectOption(matched.value, { timeout: 10000 });
  console.log(`[azamara] ship filter set: ${matched.label}`);
  return true;
}

async function fetchAvailabilityPkgs(page, options, expectFromDate = null) {
  const {
    fromDate,    // ISO date "2026-05-10"
    toDate,      // ISO date "2026-05-13"
    occupancy = 2,
    shipName = null, // optional, e.g. "Quest" — filters via the site's own Ship dropdown
  } = options;

  // Wait for the touchb2b SPA to fully bootstrap so the seaware session is
  // ready before we hit /availability/pkgs.
  await page.waitForResponse(
    (r) => r.url().includes("/touchb2b/rest/booking/history") && r.status() === 200,
    { timeout: 30000 }
  ).catch(() => null);
  await page.waitForTimeout(3000);

  // Intercept /availability/pkgs and flip returnOneCategory:true → false so
  // the response embeds all cabin categories per cruise (not just one).
  await page.route("**/touchb2b/rest/availability/pkgs", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    let body = req.postData() || "";
    try {
      const json = JSON.parse(body);
      json.returnOneCategory = false;
      json.minAvlResultCtgVal = "WTL";  // include waitlisted categories too
      body = JSON.stringify(json);
    } catch {}
    await route.continue({ postData: body });
  });

  // Background modal dismisser — Azamara pops random "Unexpected Error" modals
  // at unpredictable times. Keep clicking Close every 1.5s for the rest of
  // this function.
  const modalInterval = setInterval(async () => {
    try {
      const closeBtn = page.locator('a[role="button"]:has-text("Close"), .ui-dialog a.ui-icon-delete').first();
      if (await closeBtn.isVisible({ timeout: 200 }).catch(() => false)) {
        await closeBtn.click({ timeout: 1000 }).catch(() => {});
      }
    } catch {}
  }, 1500);

  // Close any "Unexpected Error" / dialog popups that block the page
  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator('a[role="button"]:has-text("Close"), .ui-dialog a.ui-icon-delete').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      console.log(`[azamara] closing modal (attempt ${i + 1})`);
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    } else break;
  }

  // /availability/pkgs requires an active booking session. Click "New Reservation"
  // in the SPA to create a temp booking → opens the cruise search form.
  console.log("[azamara] looking for New Reservation button");
  const newBookingButton = page.locator('a[role="button"]:has-text("New Reservation")').first();

  const responsePromise = page.waitForResponse(
    async (r) => {
      if (!r.url().includes("/touchb2b/rest/availability/pkgs") || r.status() !== 200) return false;
      if (!expectFromDate) return true;
      try {
        const body = JSON.parse(r.request().postData() || "{}");
        return (body.dateFromVal?.local || "").startsWith(expectFromDate);
      } catch { return false; }
    },
    { timeout: 90000 }
  );
  // Awaited much later (the Promise.race below). If anything between here and there
  // throws or stalls past 90s this rejects with nobody listening — an unhandled
  // rejection that used to kill the whole server process. Mark it handled; the
  // race still sees the rejection.
  responsePromise.catch(() => {});

  // The button lives at the bottom of the search-results panel — invoke its
  // click via JS directly to bypass viewport visibility checks.
  await newBookingButton.waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
  console.log("[azamara] clicking New Reservation via JS");
  const clicked = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[role="button"]')].find(x => (x.innerText || "").trim() === "New Reservation");
    if (!a) return false;
    a.scrollIntoView({ block: "center" });
    a.click();
    return true;
  });
  console.log("[azamara] JS click result:", clicked);
  await page.waitForTimeout(6000);

  // After New Reservation we land on /vx-guestsInfo (Guests tab + Continue button).
  // Strategy: click "Continue" to proceed to the cruise search step.
  // Fallback: click "Cruises" tab if Continue doesn't navigate.
  console.log("[azamara] post-NewRes URL:", page.url());

  // The Continue button can still be rendering right after New Reservation —
  // a single-shot click that finds nothing used to fall straight through to
  // filling date boxes on the wrong page (0 boxes found) and silently
  // submitting a doomed search that then hung for the full 90s response
  // timeout. Retry the click a few times before giving up.
  let contClicked = false;
  for (let attempt = 0; attempt < 4 && !contClicked; attempt++) {
    contClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a, button')]
        .find(el => /^continue$/i.test((el.innerText||"").trim()) && el.offsetParent !== null);
      if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
      return false;
    });
    if (!contClicked) await page.waitForTimeout(1500);
  }
  console.log("[azamara] Continue clicked:", contClicked);
  await page.waitForTimeout(6000);
  console.log("[azamara] post-Continue URL:", page.url());

  // If Continue didn't navigate away from guestsInfo, fall back to Cruises tab
  if ((await page.url()).includes("vx-guestsInfo")) {
    console.log("[azamara] still on guestsInfo — trying Cruises tab");
    let cruisesTabClicked = false;
    for (let attempt = 0; attempt < 4 && !cruisesTabClicked; attempt++) {
      cruisesTabClicked = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find(x => (x.innerText || "").trim() === "Cruises" && x.offsetParent !== null);
        if (a) { a.scrollIntoView({ block: "center" }); a.click(); return true; }
        return false;
      });
      if (!cruisesTabClicked) await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(6000);
    console.log("[azamara] post-Cruises-tab URL:", page.url(), "cruisesTabClicked:", cruisesTabClicked);
  }

  // Final guard: if we're STILL stuck on guestsInfo after all retries, this
  // search can never succeed (no date boxes will exist on this page) — fail
  // fast with a clear error instead of silently submitting a doomed search
  // that hangs for the full 90s response timeout with no diagnostic trace.
  if ((await page.url()).includes("vx-guestsInfo")) {
    throw new Error("Stuck on vx-guestsInfo after Continue/Cruises-tab retries — cannot reach voyage search form");
  }

  console.log(`[azamara] filling search form for ${fromDate} → ${toDate}`);

  // Close any modal that pops up after clicking New Reservation
  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator('a[role="button"]:has-text("Close"), .ui-dialog a.ui-icon-delete').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      console.log(`[azamara] post-NewRes modal close (attempt ${i + 1})`);
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    } else break;
  }

  // Drive the search form: fill date range via JS (bypass viewport check) and submit
  try {
    // Select the ship BEFORE filling dates — Celestyal's identical GWT form
    // was confirmed to reset the "To" date box back to a Month/Year picker
    // value when the Ship <select> fires its change event, silently collapsing
    // a wide search window to a single day. Doing the ship-select first avoids
    // that regardless of whether Azamara's form has the same reactive quirk.
    if (shipName) await selectAzamaraShip(page, shipName);

    const [fy, fm, fd] = fromDate.split("-");
    const [ty, tm, td] = toDate.split("-");
    const fromMDY = `${fm}/${fd}/${fy}`;
    const toMDY   = `${tm}/${td}/${ty}`;

    // Retry up to 15s waiting for date boxes — on fresh login the tab takes longer to render
    let filled = { ok: false, count: 0 };
    for (let attempt = 0; attempt < 15 && !filled.ok; attempt++) {
      filled = await page.evaluate(({ fromMDY, toMDY }) => {
        const boxes = [...document.querySelectorAll('input[data-role="datebox"]')]
          .filter(el => el.offsetParent !== null);
        if (boxes.length < 2) return { ok: false, count: boxes.length };
        const setVal = (el, v) => {
          el.scrollIntoView({ block: "center" });
          el.focus();
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        };
        setVal(boxes[0], fromMDY);
        setVal(boxes[1], toMDY);
        return { ok: true, count: boxes.length, ids: boxes.slice(0, 2).map(b => b.id) };
      }, { fromMDY, toMDY });
      if (!filled.ok) await page.waitForTimeout(1000);
    }
    console.log(`[azamara] dates filled ${fromMDY} -> ${toMDY} (visible boxes=${filled.count}, ids=${(filled.ids ?? []).join(",")})`);
    await page.waitForTimeout(1500);

    // Click search via JS
    const searchClicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a, button')]
        .filter(el => /search/i.test((el.innerText || el.value || "").trim()) && el.offsetParent !== null);
      const btn = candidates.find(el => /search\s*(cruises|sailings|voyages)/i.test(el.innerText || "")) ?? candidates[0];
      if (!btn) return false;
      btn.scrollIntoView({ block: "center" });
      btn.click();
      return btn.innerText?.trim() || btn.value;
    });
    console.log("[azamara] search clicked:", searchClicked);
  } catch (err) {
    console.log("[azamara] could not drive UI form:", err.message);
  }

  // Wait for the SPA's /availability/pkgs response that the search button fires.
  // A genuinely empty result set (e.g. a ship filter with no sailings in this
  // date window) never fires that request at all — same "no results" info-modal
  // pattern confirmed on Celestyal's identical GWT form. Race both so a real
  // 0-result search returns immediately instead of burning the full timeout.
  console.log("[azamara] waiting for /availability/pkgs response from SPA");
  try {
    const noResultsPromise = page.locator('text=did not match any results, text=No sailings found')
      .first()
      .waitFor({ state: "visible", timeout: 90000 })
      .then(() => "no-results");

    const outcome = await Promise.race([responsePromise, noResultsPromise]);
    if (outcome === "no-results") {
      console.log("[azamara] search matched 0 sailings");
      return [];
    }

    const pkgsResponse = outcome;
    const reqBody = pkgsResponse.request().postData() || "";
    console.log("[azamara] /availability/pkgs request body:", reqBody.slice(0, 800));
    const json = await pkgsResponse.json();
    return json;
  } finally {
    clearInterval(modalInterval);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function authenticateAzamara() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/azamara-user-data",
    storageStatePath: "./sessions/.auth/azamara-storage.json",
    headless:         false,
    slowMo:           0
  });
  try {
    const authResult = await ensureAzamaraAuthentication(session);
    return { vendorKey: "azamara", browserMode: session.mode, ...authResult };
  } catch (error) {
    error.message = `Azamara authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

// Internal: fetch per-cabin data for a single cruise via the booking wizard.
// Flow: results page → select row → Continue → category page → expand groups
// → click ivx-plus (non-guarantee category) → Continue → vx-cabinSelect
// → intercept availability/cabins response + direct API calls for other categories.
// Guarantee categories (inventoryResultVal=GTY) cannot have specific cabin data.
async function _fetchAzamaraCabinData(page, match, positionIndex = 0) {
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!match.startDate) return match;
  const dep = new Date(match.startDate);
  const departureDateFilter = `${dep.getDate()} ${MONTH_ABBR[dep.getMonth()]} ${dep.getFullYear()}`;
  const departureDateUS = `${String(dep.getMonth()+1).padStart(2,"0")}/${String(dep.getDate()).padStart(2,"0")}/${dep.getFullYear()}`;
  const departureDateUK = `${String(dep.getDate()).padStart(2,"0")}/${String(dep.getMonth()+1).padStart(2,"0")}/${dep.getFullYear()}`;

  const rowTexts = await page.evaluate(() =>
    [...document.querySelectorAll("table tbody tr")]
      .filter(r => window.getComputedStyle(r).display !== "none" && (r.textContent||"").trim().length > 5)
      .map(r => r.textContent?.trim().slice(0, 120))
  );
  console.log(`[azamara] ${match.id} table rows (${rowTexts.length}): ${JSON.stringify(rowTexts.slice(0,4))}`);

  async function selectSailingRow() {
    return page.evaluate(({ cruiseId, dateFilters, pk, rowIdx }) => {
      const dataRows = [...document.querySelectorAll("table tbody tr")]
        .filter(r => window.getComputedStyle(r).display !== "none" && !(r.textContent||"").includes("No data available") && (r.textContent||"").trim().length > 5);
      document.querySelectorAll('input[type="checkbox"]:checked, input.checkbox-rowsel:checked').forEach(cb => cb.click());
      if (cruiseId) {
        for (const row of dataRows) {
          if ((row.textContent||"").includes(cruiseId)) {
            const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
            if (cb) { cb.click(); return `code: ${row.textContent.trim().slice(0,120)}`; }
          }
        }
      }
      for (const ds of dateFilters) {
        if (!ds) continue;
        for (const row of dataRows) {
          const text = row.textContent||"";
          if (!text.includes(ds)) continue;
          if (pk && !text.includes(pk)) continue;
          const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
          if (cb) { cb.click(); return `date+pkg(${ds}): ${text.trim().slice(0,120)}`; }
        }
      }
      // No cruiseId or date+package match found — the table only ever shows
      // the ~10 nearest-date rows (no pagination driven here), so the target
      // cruise can genuinely be absent from this particular search window.
      // Selecting *some other* row by position previously caused real cabin
      // data to be silently merged onto the wrong cruise (confirmed live).
      // Refuse to guess: report failure so the caller can skip this cruise
      // instead of corrupting a different one.
      return `NOT_FOUND || DEBUG_ALL_ROWS: ${JSON.stringify(dataRows.map(r => r.textContent.trim().slice(0, 80)))}`;
    }, { cruiseId: match.id, dateFilters: [departureDateFilter, departureDateUS, departureDateUK], pk: match.package ?? null, rowIdx: positionIndex });
  }

  const rowClicked = await selectSailingRow();
  console.log(`[azamara] ${match.id} row selected: ${rowClicked}`);
  if (!rowClicked) throw new Error(`Could not find row for ${match.id}`);
  if (rowClicked.startsWith("NOT_FOUND")) throw new Error(`Sailing ${match.id} not present in this search window — ${rowClicked}`);
  await page.waitForTimeout(500);

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
    if (!rect) throw new Error(`Continue not found (${label})`);
    await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  // Continue → category page
  await clickContinue("search→categories");
  await page.waitForURL(/vx-genCtgAvailSearch|vx-voyageSearchInterval/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log(`[azamara] ${match.id}: URL after Continue: ${page.url()}`);

  if ((await page.url()).includes("vx-voyageSearchInterval")) {
    console.log(`[azamara] ${match.id}: voyage-interval after Continue — re-selecting`);
    await page.waitForTimeout(1500);
    await selectSailingRow();
    await page.waitForTimeout(800);
    await clickContinue("voyage-interval→categories");
    await page.waitForURL(/vx-genCtgAvailSearch/, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  const firstOkCode = (match.cabinCategories.find(c => c.avlResult === "OK"))?.code ?? null;
  if (!firstOkCode) {
    console.log(`[azamara] ${match.id}: no OK categories (all WTL/sold out), skipping cabin wizard`);
    return match;
  }

  // Azamara category page: wait for "Show Available Categories" buttons to appear,
  // then click one to expand the cabin group and reveal the ivx-plus buttons inside.
  let showCatsBtnFound = false;
  for (let attempt = 0; attempt < 35; attempt++) {
    showCatsBtnFound = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a, button")]
        .find(el => /show available categories/i.test(el.innerText||"") && el.getBoundingClientRect().width > 0);
      return !!btn;
    });
    if (showCatsBtnFound) break;
    await page.waitForTimeout(1000);
  }
  console.log(`[azamara] ${match.id}: "Show Available Categories" found=${showCatsBtnFound}`);

  if (showCatsBtnFound) {
    // Click ALL "Show Available Categories" buttons to expand all cabin groups
    const expanded = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("a, button")]
        .filter(el => /show available categories/i.test(el.innerText||"") && el.getBoundingClientRect().width > 0);
      btns.forEach(b => b.click());
      return btns.length;
    });
    console.log(`[azamara] ${match.id}: expanded ${expanded} cabin groups`);
    await page.waitForTimeout(3000);
  }

  // Now wait for ivx-plus buttons to become visible (max 15s more)
  let hasIvxPlus = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    hasIvxPlus = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a.ivx-plus")].find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return !!btn;
    });
    if (hasIvxPlus) break;
    await page.waitForTimeout(1000);
  }

  if (!hasIvxPlus) {
    console.log(`[azamara] ${match.id}: no visible ivx-plus after expanding — skipping cabin wizard`);
    return match;
  }
  console.log(`[azamara] ${match.id}: ivx-plus buttons visible, proceeding with wizard`);

  // Separate guarantee (GTY = no specific cabin) from specific categories
  const isGTY = (code) => (match.rawPayload?.ctgsVal ?? [])
    .find(c => c.ctgInfo?.code === code)?.inventoryResultVal === "GTY";
  const okCats    = match.cabinCategories.filter(c => c.avlResult === "OK");
  const wtlCats   = match.cabinCategories.filter(c => c.avlResult !== "OK");
  const specCats  = okCats.filter(c => !isGTY(c.code));   // specific (non-guarantee)
  console.log(`[azamara] ${match.id}: okCats=${okCats.map(c=>c.code).join(",")} specCats=${specCats.map(c=>c.code).join(",")}`);

  const cabinsByCategory = {};
  for (const cat of wtlCats)           cabinsByCategory[cat.code] = [];
  for (const cat of okCats.filter(c => isGTY(c.code))) {
    cabinsByCategory[cat.code] = [];
    console.log(`[azamara] ${cat.code}: guarantee category — no specific cabin data`);
  }

  if (specCats.length === 0) {
    console.log(`[azamara] ${match.id}: all OK categories are guarantees — no cabin wizard needed`);
    match.cabinCategories = match.cabinCategories.map(cat => ({ ...cat, cabins: cabinsByCategory[cat.code] ?? [] }));
    return match;
  }

  // Intercept availability/cabins responses fired by vx-cabinSelect page loads
  let capturedAvailUrl = null;
  const capturedCabinsByCtg = {};  // catCode → cabin[]
  let bookingResGUID = null, putBodyTemplate = null, bookingResId = null;

  const onPutReq = (req) => {
    if (!req.url().includes("/rest/booking/cabins/") || req.method() !== "PUT") return;
    try { putBodyTemplate = JSON.parse(req.postData()??"{}"); bookingResGUID = req.url().split("/rest/booking/cabins/")[1]; } catch {}
  };
  page.on("request", onPutReq);

  await page.route("**/rest/availability/cabins/**", async (route) => {
    // route.fetch() can time out under load — an unhandled rejection inside a
    // Playwright route handler crashes the whole process, not just this
    // request, so this must never be allowed to throw.
    try {
      const response = await route.fetch();
      const text = await response.text();
      capturedAvailUrl = route.request().url();
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data) && data.length > 0 && data[0].avlCabin) {
          // Determine which category this is for (from current booking context)
          // Store it keyed to the URL for now; we'll map it to category codes after
          const m = capturedAvailUrl.match(/\/availability\/cabins\/(-?\d+)/);
          if (m) bookingResId = parseInt(m[1]);
          // Store all cabins (we'll filter per-category later)
          capturedCabinsByCtg["__latest__"] = data.map(item => ({
            cabinNumber: String(item.avlCabin.cabinNumber),
            deckNumber:  item.avlCabin.deckVal != null ? Math.round(item.avlCabin.deckVal) : null,
            deckName:    item.avlCabin.deckVal != null ? `Deck ${Math.round(item.avlCabin.deckVal)}` : null,
            capacity:    item.avlCabin.ctgInfo?.capacityVal ?? null,
            status:      "Available"
          }));
          console.log(`[azamara] intercepted availability/cabins: ${data.length} cabins, url=${capturedAvailUrl.slice(-60)}`);
        }
      } catch {}
      await route.fulfill({ status: response.status(), headers: response.headers(), body: text });
    } catch (err) {
      console.log(`[azamara] route.fetch failed for availability/cabins: ${err.message} — passing through unmodified`);
      await route.continue().catch(() => {});
    }
  });

  const firstOkRawCat = match.rawPayload?.ctgsVal?.find(c => c.ctgInfo?.code === firstOkCode) ?? null;
  if (firstOkRawCat && putBodyTemplate == null) {
    // Route booking/cabins PUT to force first specific category selection
    const firstSpecRawCat = match.rawPayload?.ctgsVal?.find(c => !isGTY(c.ctgInfo?.code) && c.avlResultVal === "OK") ?? firstOkRawCat;
    await page.route("**/rest/booking/cabins/**", async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      let body; try { body = JSON.parse(route.request().postData()??"{}"); } catch { await route.continue(); return; }
      if (Array.isArray(body.cabinsVal) && body.cabinsVal[0]) {
        body.cabinsVal[0] = { ...body.cabinsVal[0], ctgInfo: firstSpecRawCat.ctgInfo, promotionsVal: firstSpecRawCat.promoCodesVal??[], cabinPrice: firstSpecRawCat.cabinPrice??0, inventoryResult: "OK", requestedCabin: null };
      }
      try {
        const response = await route.fetch({ postData: JSON.stringify(body) });
        const respText = await response.text();
        try {
          const scan = (obj, d=0) => { if (d>8||bookingResId!=null||!obj||typeof obj!=="object") return; for (const [,v] of Object.entries(obj)) { if (typeof v==="number"&&v<-10000){bookingResId=v;return;} if (typeof v==="object") scan(v,d+1); } };
          scan(JSON.parse(respText));
        } catch {}
        await route.fulfill({ status: response.status(), headers: response.headers(), body: respText });
      } catch (err) {
        console.log(`[azamara] route.fetch failed for booking/cabins PUT (specific category): ${err.message} — passing through unmodified`);
        await route.continue().catch(() => {});
      }
    });
  }

  // Click ivx-plus and navigate toward vx-cabinSelect
  const plusClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("a.ivx-plus")].filter(b => { const r = b.getBoundingClientRect(); return r.width>0&&r.height>0; });
    if (btns[0]) { btns[0].click(); return true; }
    return false;
  });
  // The availability/cabins interceptor can fire mid-navigation even when the
  // wizard never actually lands on vx-cabinSelect (confirmed live: some
  // single-specific-category sailings jump straight from
  // vx-genCtgAvailSearch to vx-guestsEdit, skipping vx-cabinSelect entirely).
  // Gating the mapping below on the vx-cabinSelect URL check meant that real,
  // already-captured cabin data was silently discarded whenever that skip
  // happened. Map it here — right after the click loop, regardless of which
  // URL the wizard ended up on — so any data the interceptor actually
  // captured always gets attached to a category.
  const mapLatestCapturedCabins = () => {
    if (capturedCabinsByCtg["__latest__"] && specCats.length > 0) {
      const ctgCode = specCats[0].code;
      cabinsByCategory[ctgCode] = capturedCabinsByCtg["__latest__"];
      delete capturedCabinsByCtg["__latest__"];
      console.log(`[azamara] ${ctgCode}: ${cabinsByCategory[ctgCode].length} cabins from intercepted response`);
    }
  };

  if (plusClicked) {
    await page.waitForTimeout(2000);
    // Navigate until we reach vx-cabinSelect (or guestsEdit if no cabin selection needed)
    for (let step = 0; step < 4; step++) {
      await clickContinue(`step-${step+1}`).catch(() => {});
      await page.waitForTimeout(4000);
      const url = await page.url();
      console.log(`[azamara] ${match.id}: navigation step ${step+1} → ${url.split("/").pop()}`);
      mapLatestCapturedCabins();
      if (url.includes("vx-cabinSelect")) {
        // On cabin select page — interceptor already fired, wait for it
        await page.waitForTimeout(3000);
        mapLatestCapturedCabins();
        // Try direct API calls for remaining specific categories
        const hasBookingContext = bookingResId && bookingResGUID && putBodyTemplate;
        if (specCats.length > 1 && !hasBookingContext) {
          console.log(`[azamara] ${match.id}: skipping ${specCats.length - 1} remaining specific categor${specCats.length - 1 === 1 ? "y" : "ies"} — missing bookingResId=${bookingResId} bookingResGUID=${!!bookingResGUID} putBodyTemplate=${!!putBodyTemplate}`);
        }
        if (hasBookingContext && specCats.length > 1) {
          const depRefId = putBodyTemplate?.depIdVal ?? match.rawPayload?.departureIdVal ?? null;
          const arrRefId = putBodyTemplate?.arrIdVal ?? match.rawPayload?.arrivalIdVal   ?? null;
          const shipParam = putBodyTemplate?.shipCode ?? match.shipCode ?? null;
          for (const cat of specCats.slice(1)) {
            try {
              const rawCat = (match.rawPayload?.ctgsVal??[]).find(c=>c.ctgInfo?.code===cat.code);
              const putBody = JSON.parse(JSON.stringify(putBodyTemplate));
              if (Array.isArray(putBody.cabinsVal) && putBody.cabinsVal[0] && rawCat) {
                putBody.cabinsVal[0] = { ...putBody.cabinsVal[0], ctgInfo: rawCat.ctgInfo, promotionsVal: rawCat.promoCodesVal??[], cabinPrice: rawCat.cabinPrice??0, inventoryResult:"OK", requestedCabin:null };
              }
              await page.evaluate(async ({ guid, body }) => {
                await fetch(`/touchb2b/rest/booking/cabins/${guid}`, { method:"PUT", credentials:"include", headers:{"Content-Type":"application/json",Accept:"application/json"}, body:JSON.stringify(body) });
              }, { guid: bookingResGUID, body: putBody });
              await page.waitForTimeout(1000);
              const availData = await page.evaluate(async ({ resId, ship, dep, arr }) => {
                try {
                  const url = `/touchb2b/rest/availability/cabins/${resId}?shipCode=${ship}&depRefId=${dep}&arrRefId=${arr}&withResCabins=true&showAllCabins=false&withConnectingCabins=false`;
                  const r = await fetch(url, { credentials:"include", headers:{ Accept:"application/json" } });
                  return r.ok ? await r.json() : null;
                } catch { return null; }
              }, { resId: bookingResId, ship: shipParam, dep: depRefId, arr: arrRefId });
              if (Array.isArray(availData) && availData.length > 0 && availData[0].avlCabin) {
                cabinsByCategory[cat.code] = availData.map(item => ({
                  cabinNumber: String(item.avlCabin.cabinNumber),
                  deckNumber: item.avlCabin.deckVal != null ? Math.round(item.avlCabin.deckVal) : null,
                  deckName: item.avlCabin.deckVal != null ? `Deck ${Math.round(item.avlCabin.deckVal)}` : null,
                  capacity: item.avlCabin.ctgInfo?.capacityVal ?? null, status: "Available"
                }));
                console.log(`[azamara] ${cat.code}: ${cabinsByCategory[cat.code].length} cabins (direct API on vx-cabinSelect)`);
              } else {
                cabinsByCategory[cat.code] = [];
              }
            } catch (e) { cabinsByCategory[cat.code] = []; }
          }
        }
        break;
      }
      if (url.includes("vx-guestsEdit") || url.includes("vx-passengersEdit")) break;
    }
  }

  await page.unroute("**/rest/availability/cabins/**").catch(() => {});
  await page.unroute("**/rest/booking/cabins/**").catch(() => {});
  page.off("request", onPutReq);

  // Fill in empty entries for spec cats that didn't get data
  for (const cat of specCats) {
    if (!(cat.code in cabinsByCategory)) cabinsByCategory[cat.code] = [];
  }

  match.cabinCategories = match.cabinCategories.map(cat => ({ ...cat, cabins: cabinsByCategory[cat.code] ?? [] }));
  return match;
}

// Cleanup after wizard: click "Exit Editing" or navigate home to reset state
async function _azamaraWizardCleanup(page) {
  try {
    const exitClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a, button")]
        .find(el => /exit\s*editing/i.test(el.innerText||"") && el.getBoundingClientRect().width > 0);
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (exitClicked) {
      await page.waitForTimeout(3000);
      console.log("[azamara] wizard cleanup: clicked Exit Editing");
    } else {
      console.log("[azamara] wizard cleanup: no Exit Editing button, navigating home");
    }
  } catch {}
  // Always navigate to home to ensure clean state
  await page.goto("https://seaware.azamara.com/touchb2b/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

// ── legacy wizard stub (kept so old callers don't break, immediately discarded) ──
async function _fetchAzamaraCabinData_wizard(page, match, positionIndex = 0) {
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!match.startDate) return match;
  const dep = new Date(match.startDate);
  const departureDateFilter = `${dep.getDate()} ${MONTH_ABBR[dep.getMonth()]} ${dep.getFullYear()}`;
  const departureDateUS = `${String(dep.getMonth()+1).padStart(2,"0")}/${String(dep.getDate()).padStart(2,"0")}/${dep.getFullYear()}`;
  const departureDateUK = `${String(dep.getDate()).padStart(2,"0")}/${String(dep.getMonth()+1).padStart(2,"0")}/${dep.getFullYear()}`;

  // Log current rows so we can see the date format
  const rowTexts = await page.evaluate(() =>
    [...document.querySelectorAll("table tbody tr")]
      .filter(r => window.getComputedStyle(r).display !== "none" && (r.textContent||"").trim().length > 5)
      .map(r => r.textContent?.trim().slice(0, 120))
  );
  console.log(`[azamara] ${match.id} table rows (${rowTexts.length}): ${JSON.stringify(rowTexts.slice(0,4))}`);

  async function selectSailingRow() {
    return page.evaluate(({ cruiseId, dateFilters, pk, rowIdx }) => {
      const dataRows = [...document.querySelectorAll("table tbody tr")]
        .filter(r => window.getComputedStyle(r).display !== "none" && !(r.textContent||"").includes("No data available") && (r.textContent||"").trim().length > 5);
      document.querySelectorAll('input[type="checkbox"]:checked, input.checkbox-rowsel:checked').forEach(cb => cb.click());

      // Primary: match by cruise code (always in row text)
      if (cruiseId) {
        for (const row of dataRows) {
          if ((row.textContent||"").includes(cruiseId)) {
            const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
            if (cb) { cb.click(); return `code: ${row.textContent.trim().slice(0,120)}`; }
          }
        }
      }
      // Secondary: match by departure date in any format
      for (const ds of dateFilters) {
        if (!ds) continue;
        for (const row of dataRows) {
          const text = row.textContent||"";
          if (!text.includes(ds)) continue;
          if (pk && !text.includes(pk)) continue;
          const cb = row.querySelector('input[type="checkbox"], input.checkbox-rowsel');
          if (cb) { cb.click(); return `date+pkg(${ds}): ${text.trim().slice(0,120)}`; }
        }
      }
      // Fallback: position
      // No cruiseId or date+package match found — the table only ever shows
      // the ~10 nearest-date rows (no pagination driven here), so the target
      // cruise can genuinely be absent from this particular search window.
      // Selecting *some other* row by position previously caused real cabin
      // data to be silently merged onto the wrong cruise (confirmed live).
      // Refuse to guess: report failure so the caller can skip this cruise
      // instead of corrupting a different one.
      return `NOT_FOUND || DEBUG_ALL_ROWS: ${JSON.stringify(dataRows.map(r => r.textContent.trim().slice(0, 80)))}`;
    }, { cruiseId: match.id, dateFilters: [departureDateFilter, departureDateUS, departureDateUK], pk: match.package ?? null, rowIdx: positionIndex });
  }

  const rowClicked = await selectSailingRow();
  console.log(`[azamara] ${match.id} row selected: ${rowClicked}`);
  if (!rowClicked) throw new Error(`Could not find row for ${match.id}`);
  if (rowClicked.startsWith("NOT_FOUND")) throw new Error(`Sailing ${match.id} not present in this search window — ${rowClicked}`);
  await page.waitForTimeout(500);

  // Continue helper (same jQM-aware logic as celestyal)
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
    if (!rect) throw new Error(`Continue not found (${label})`);
    await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  // Continue → category page
  await clickContinue("search→categories");
  await page.waitForURL(/vx-genCtgAvailSearch|vx-voyageSearchInterval/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  console.log(`[azamara] ${match.id}: URL after 1st Continue: ${page.url()}`);

  if ((await page.url()).includes("vx-voyageSearchInterval")) {
    console.log(`[azamara] ${match.id}: voyage-interval after Continue — re-selecting`);
    await page.waitForTimeout(1500);
    await selectSailingRow();
    await page.waitForTimeout(800);
    await clickContinue("voyage-interval→categories");
    await page.waitForURL(/vx-genCtgAvailSearch/, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    console.log(`[azamara] ${match.id}: URL after 2nd Continue: ${page.url()}`);
  }

  // Skip cabin wizard if no OK categories (all waitlisted) — nothing to book
  const firstOkCode    = (match.cabinCategories.find(c => c.avlResult === "OK"))?.code ?? null;
  if (!firstOkCode) {
    console.log(`[azamara] ${match.id}: no OK categories (all WTL/sold out), skipping cabin wizard`);
    return match;
  }
  const firstOkRawCat  = match.rawPayload?.ctgsVal?.find(c => c.ctgInfo?.code === firstOkCode) ?? null;
  const firstOkCtgInfo = firstOkRawCat?.ctgInfo ?? { ship: match.shipCode, code: firstOkCode, spaceTypeVal: "CABIN" };

  console.log(`[azamara] ${match.id}: category page URL=${page.url()}`);
  await page.screenshot({ path: `C:\\Users\\admin\\AppData\\Local\\Temp\\azamara-cat-${match.id.replace(/[:/]/g,"-")}.png` }).catch(() => {});

  let hasIvxPlus = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    hasIvxPlus = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a.ivx-plus")].find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return !!btn;
    });
    if (hasIvxPlus) break;
    await page.waitForTimeout(1000);
  }
  if (!hasIvxPlus) {
    console.log(`[azamara] ${match.id}: no ivx-plus buttons on category page — skipping`);
    return match;
  }

  let putBodyTemplate = null, bookingResGUID = null, bookingResId = null, entityCabinsTemplate = null;
  const onPutRequest = (req) => {
    if (!req.url().includes("/rest/booking/cabins/") || req.method() !== "PUT") return;
    try { putBodyTemplate = JSON.parse(req.postData()??"{}"); bookingResGUID = req.url().split("/rest/booking/cabins/")[1]; } catch {}
  };
  page.on("request", onPutRequest);

  if (firstOkCtgInfo) {
    await page.route("**/rest/booking/cabins/**", async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      let body; try { body = JSON.parse(route.request().postData()??"{}"); } catch { await route.continue(); return; }
      if (Array.isArray(body.cabinsVal) && body.cabinsVal[0]) {
        body.cabinsVal[0] = { ...body.cabinsVal[0], ctgInfo: firstOkCtgInfo, promotionsVal: firstOkRawCat?.promoCodesVal??[], cabinPrice: firstOkRawCat?.cabinPrice??0, inventoryResult: "OK", requestedCabin: null };
      }
      try {
        const response = await route.fetch({ postData: JSON.stringify(body) });
        const respText = await response.text();
        try {
          const scan = (obj, d=0) => { if (d>8||bookingResId!=null||!obj||typeof obj!=="object") return; for (const [,v] of Object.entries(obj)) { if (typeof v==="number"&&v<-10000){bookingResId=v;return;} if (typeof v==="object") scan(v,d+1); } };
          scan(JSON.parse(respText));
        } catch {}
        await route.fulfill({ status: response.status(), headers: response.headers(), body: respText });
      } catch (err) {
        console.log(`[azamara] route.fetch failed for booking/cabins PUT: ${err.message} — passing through unmodified`);
        await route.continue().catch(() => {});
      }
    });
  }

  await page.route("**/rest/entity/cabins*", async (route) => {
    if (!entityCabinsTemplate) { try { const j = JSON.parse(route.request().postData()??"{}"); entityCabinsTemplate = { shipCode: j.shipCode, sailDate: j.sailDate }; } catch {} }
    await route.continue();
  });

  let distribUrl = "";
  for (let plusAttempt = 0; plusAttempt < 3; plusAttempt++) {
    const plusClicked = await page.evaluate((n) => {
      const btns = [...document.querySelectorAll("a.ivx-plus")].filter(b => { const r = b.getBoundingClientRect(); return r.width>0&&r.height>0; });
      if (btns[n]) { btns[n].click(); return `nth:${n}`; }
      if (btns[0]) { btns[0].click(); return "first"; }
      return null;
    }, plusAttempt);
    if (!plusClicked) break;
    await page.waitForTimeout(2000);
    await clickContinue(`category→distribution #${plusAttempt+1}`);
    await page.waitForTimeout(5000);
    distribUrl = await page.url();
    if (distribUrl.includes("vx-cabinDistrib")) { await page.waitForTimeout(3000); break; }
  }

  if (firstOkCtgInfo) await page.unroute("**/rest/booking/cabins/**").catch(() => {});
  await page.unroute("**/rest/entity/cabins*").catch(() => {});
  page.off("request", onPutRequest);

  console.log(`[azamara] ${match.id}: distribUrl=${distribUrl}, PUT captured=${!!putBodyTemplate}`);
  if (!putBodyTemplate || !bookingResGUID) throw new Error(`PUT not captured for ${match.id} (last URL: ${distribUrl})`);

  // Per-category cabin fetch (identical to celestyal)
  const cabinsByCategory = {};
  const okCats  = match.cabinCategories.filter(c => c.avlResult === "OK");
  const wtlCats = match.cabinCategories.filter(c => c.avlResult !== "OK");
  for (const cat of wtlCats) cabinsByCategory[cat.code] = [];

  const entityCabinsByCategory = {};
  if (entityCabinsTemplate) {
    for (const cat of okCats) {
      try {
        const res = await page.evaluate(async (body) => {
          try { const r = await fetch("/touchb2b/rest/entity/cabins", { method:"POST", credentials:"include", headers:{"Content-Type":"application/json",Accept:"application/json"}, body:JSON.stringify(body) }); return r.ok ? await r.json() : null; } catch { return null; }
        }, { ...entityCabinsTemplate, category: cat.code });
        if (Array.isArray(res) && res.length > 0) {
          entityCabinsByCategory[cat.code] = res.map(item => ({ cabinNumber: String(item.cabinNumber), deckNumber: item.deckNumber!=null?Math.round(item.deckNumber):null, deckName: item.deckNumber!=null?`Deck ${Math.round(item.deckNumber)}`:null, capacity: item.capacity!=null?Math.round(item.capacity):null, status: "Available" }));
        }
      } catch {}
    }
  }

  const depRefId      = putBodyTemplate?.depIdVal ?? match.rawPayload?.departureIdVal ?? null;
  const arrRefId      = putBodyTemplate?.arrIdVal ?? match.rawPayload?.arrivalIdVal   ?? null;
  const shipCodeParam = putBodyTemplate?.shipCode ?? match.shipCode ?? null;
  const resIdInt      = bookingResId != null ? Math.round(bookingResId) : null;

  for (const cat of okCats) {
    try {
      if (putBodyTemplate && bookingResGUID) {
        const rawCat = (match.rawPayload?.ctgsVal??[]).find(c=>c.ctgInfo?.code===cat.code);
        const targetCtgInfo = rawCat?.ctgInfo ?? { ship: match.shipCode, code: cat.code, spaceTypeVal:"CABIN" };
        const putBody = JSON.parse(JSON.stringify(putBodyTemplate));
        if (Array.isArray(putBody.cabinsVal) && putBody.cabinsVal[0]) {
          putBody.cabinsVal[0] = { ...putBody.cabinsVal[0], ctgInfo: targetCtgInfo, promotionsVal: rawCat?.promoCodesVal??[], cabinPrice: rawCat?.cabinPrice??0, inventoryResult:"OK", requestedCabin:null };
        }
        await page.evaluate(async ({ guid, body }) => {
          await fetch(`/touchb2b/rest/booking/cabins/${guid}`, { method:"PUT", credentials:"include", headers:{"Content-Type":"application/json",Accept:"application/json"}, body:JSON.stringify(body) });
        }, { guid: bookingResGUID, body: putBody });
      }

      if (resIdInt && depRefId && arrRefId) {
        const availCabins = await page.evaluate(async ({ resId, ship, dep, arr }) => {
          try {
            const url = `/touchb2b/rest/availability/cabins/${resId}?shipCode=${ship}&depRefId=${dep}&arrRefId=${arr}&withResCabins=true&showAllCabins=false&withConnectingCabins=false`;
            const r = await fetch(url, { credentials:"include", headers:{ Accept:"application/json" } });
            return r.ok ? await r.json() : null;
          } catch { return null; }
        }, { resId: resIdInt, ship: shipCodeParam, dep: depRefId, arr: arrRefId });

        if (Array.isArray(availCabins) && availCabins.length > 0) {
          cabinsByCategory[cat.code] = availCabins.map(item => ({ cabinNumber: String(item.avlCabin.cabinNumber), deckNumber: item.avlCabin.deckVal!=null?Math.round(item.avlCabin.deckVal):null, deckName: item.avlCabin.deckVal!=null?`Deck ${Math.round(item.avlCabin.deckVal)}`:null, capacity: item.avlCabin.ctgInfo?.capacityVal??null, status:"Available" }));
          console.log(`[azamara] ${cat.code}: ${availCabins.length} available cabins`);
          continue;
        }
      }

      cabinsByCategory[cat.code] = entityCabinsByCategory[cat.code] ?? [];
      console.log(`[azamara] ${cat.code}: ${cabinsByCategory[cat.code].length} cabins (entity fallback)`);
    } catch (e) {
      cabinsByCategory[cat.code] = entityCabinsByCategory[cat.code] ?? [];
    }
  }

  match.cabinCategories = match.cabinCategories.map(cat => ({
    ...cat,
    cabins: cabinsByCategory[cat.code] ?? []
  }));

  return match;
}

// Kept open across requests — Chromium drops session-only cookies on browser
// close even with a persistent profile dir, so closing after every refresh
// forces a fresh login every time. Reusing one long-lived session avoids that.
let cachedAzamaraSession = null;
let azamaraQueue = Promise.resolve();

async function getOrCreateAzamaraSession() {
  if (cachedAzamaraSession) {
    const alive = await cachedAzamaraSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedAzamaraSession;
    await cachedAzamaraSession.close().catch(() => {});
    cachedAzamaraSession = null;
  }
  cachedAzamaraSession = await createScraperSession({
    userDataDir:      "./sessions/azamara-user-data",
    storageStatePath: "./sessions/.auth/azamara-storage.json",
    headless:         false,
    slowMo:           0
  });
  return cachedAzamaraSession;
}

function runExclusiveAzamara(fn) {
  const result = azamaraQueue.then(fn);
  azamaraQueue = result.catch(() => {});
  return result;
}

/**
 * On-demand single-voyage fetch for "Get Full Details" — narrows the search
 * to a 3-day window around the sailing's departure date, finds the matching
 * cruise by id, then runs the existing cabin/deck wizard for just that one.
 */
export async function fetchAzamaraVoyageByCode(cruiseCode, startDate, occupancy = 2) {
  return runExclusiveAzamara(async () => {
    const session = await getOrCreateAzamaraSession();
    await ensureAzamaraAuthentication(session);

    const dep      = new Date(startDate);
    // A ±1 day window came back with 0 sailings (or no /availability/pkgs response at
    // all) for sailings that are on sale, while month-wide windows — what the bulk run
    // uses — return them. Search a fortnight either side and match the sailing by code.
    const fromDate = new Date(dep.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const toDate   = new Date(dep.getTime() + 14 * 86400000).toISOString().slice(0, 10);

    const raw   = await fetchAvailabilityPkgs(session.page, { fromDate, toDate, occupancy }, fromDate);
    const items = Array.isArray(raw) ? raw : (raw?.data ?? []);
    const cruises = items.map(normalizeAzamaraCruise).filter((c) => c?.id);

    const positionIndex = cruises.findIndex((c) => c.id === cruiseCode);
    const match = cruises[positionIndex];
    if (!match) throw new Error(`Voyage ${cruiseCode} not found in Azamara search for ${fromDate} to ${toDate} (search returned ${cruises.length} sailings: ${cruises.slice(0, 6).map((c) => c.id).join(", ") || "none"})`);

    await session.page.waitForFunction(
      () => [...document.querySelectorAll("table tbody tr")]
        .filter(r => window.getComputedStyle(r).display !== "none" &&
                     !(r.textContent || "").includes("No data available") &&
                     (r.textContent || "").trim().length > 5)
        .length > 0,
      { timeout: 30000 }
    ).catch(() => {});
    await session.page.waitForTimeout(2000);

    const enriched = await _fetchAzamaraCabinData(session.page, match, Math.max(positionIndex, 0));
    await _azamaraWizardCleanup(session.page).catch(() => {});
    return enriched?.cabinCategories ?? null;
  });
}

export async function runAzamaraScraper(options = {}) {
  const {
    fromDate  = "2026-05-10",
    toDate    = "2026-05-13",
    occupancy = 2,
    listOnly  = true,
    shipName  = null, // optional, e.g. "Quest" — filters via the site's own Ship dropdown
    maxDeckCruises = Infinity, // was never read here — full detail mode tried
                                // EVERY sailing in the window every time, so any
                                // caller trying to bound a run (the sweep passed
                                // 60) was silently ignored.
  } = options;

  const session = await createScraperSession({
    userDataDir:      "./sessions/azamara-user-data",
    storageStatePath: "./sessions/.auth/azamara-storage.json",
    headless:         false,
    slowMo:           0
  });

  try {
    const authResult = await ensureAzamaraAuthentication(session);
    const raw = await fetchAvailabilityPkgs(session.page, { fromDate, toDate, occupancy, shipName });

    const items = Array.isArray(raw) ? raw : (raw?.data ?? []);
    console.log(`[azamara] /availability/pkgs returned ${items.length} sailings`);

    const cruises = items.map(normalizeAzamaraCruise).filter((c) => c?.id);
    console.log(`[azamara] normalized ${cruises.length} cruises`);

    if (!listOnly && cruises.length > 0) {
      // Cruises that already have cabin rows in the DB go LAST, and the pass
      // is capped at maxDeckCruises (previously ignored entirely — see the
      // option comment above). Without the cap, a run against a wide window
      // tried every sailing at ~1-1.5 min each with nothing written to the DB
      // until the very end, so any crash/timeout lost the whole pass; without
      // the ordering, a capped run kept re-fetching the same already-covered
      // sailings and never reached the gaps. Same failure class already found
      // and fixed in goccl.js and celestyal.js.
      const codesWithCabins = new Set(
        (await prisma.cruise.findMany({
          where: { vendor: { slug: "azamara" }, cabinCategories: { some: { cabins: { some: {} } } } },
          select: { code: true }
        })).map((c) => c.code)
      );
      // A cruise with no "OK" category (all WTL/SLD) has nothing bookable to
      // fetch cabins for — treating it as "missing decks" would let it
      // permanently hog the front of every capped run instead of cruises that
      // actually have inventory (confirmed live on celestyal.js: a 100%
      // Waitlist sailing got picked first on every run, 0 cabins possible).
      const hasFetchableCategory = (c) => (c.cabinCategories ?? []).some((cc) => cc.avlResult === "OK");
      const priority = (c) => {
        if (codesWithCabins.has(c.id)) return 2;   // already covered
        if (!hasFetchableCategory(c)) return 2;     // nothing bookable
        return 1;                                    // real gap
      };
      const ordered = [...cruises].sort((a, b) => priority(a) - priority(b));
      const missingCount = ordered.filter((c) => priority(c) === 1).length;
      console.log(`[azamara] ${missingCount}/${ordered.length} candidates lack cabin data — those go first`);

      const limit = Math.min(ordered.length, maxDeckCruises);
      const byId = new Map(cruises.map((c, idx) => [c.id, idx]));
      const vendor = await ensureVendor({ slug: "azamara", name: "Azamara", url: "https://www.azamara.com/" });

      console.log(`\n[azamara] Full detail mode — fetching cabin data for ${limit}/${ordered.length} cruises`);

      const waitForDataRows = async () => {
        await session.page.waitForFunction(
          () => [...document.querySelectorAll("table tbody tr")]
            .filter(r => window.getComputedStyle(r).display !== "none" &&
                         !(r.textContent||"").includes("No data available") &&
                         (r.textContent||"").trim().length > 5)
            .length > 0,
          { timeout: 30000 }
        ).catch(() => {});
        await session.page.waitForTimeout(2000);
      };

      await waitForDataRows();

      let deckEnrichedCount = 0;
      for (let i = 0; i < limit; i++) {
        const target = ordered[i];
        if (i > 0) {
          console.log(`[azamara] [${i+1}/${limit}] cleaning up wizard state`);
          await _azamaraWizardCleanup(session.page);

          // The results table only ever renders the first ~10 rows (nearest
          // sail-date first, no "load more"/pagination the scraper drives) —
          // a broad re-search across the FULL fromDate..toDate range silently
          // omits any target cruise beyond the 10 nearest dates. Confirmed
          // live: cabin data ended up merged onto the wrong cruise because the
          // real target never appeared in the table, and position-based
          // fallback picked whatever else was at that row index instead.
          // Narrow the re-search to a window around this specific cruise's own
          // sail date so it reliably lands within the first ~10 rows.
          const cruiseDate = target.startDate ? new Date(target.startDate) : null;
          let narrowFrom = fromDate, narrowTo = toDate;
          if (cruiseDate && !isNaN(cruiseDate)) {
            const pad = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
            const from = new Date(cruiseDate.getTime() - 14 * 86400000);
            const to   = new Date(cruiseDate.getTime() + 14 * 86400000);
            narrowFrom = pad(from);
            narrowTo   = pad(to);
          }
          console.log(`[azamara] [${i+1}/${limit}] re-running narrowed search (${narrowFrom} → ${narrowTo})`);
          try {
            await fetchAvailabilityPkgs(session.page, { fromDate: narrowFrom, toDate: narrowTo, occupancy });
            await waitForDataRows();
          } catch (err) {
            // A failure here (e.g. Continue button never rendered in time)
            // used to crash the ENTIRE run over one cruise — skip just this
            // one instead, the rest of the loop can still succeed.
            console.error(`[azamara] [${i+1}/${limit}] re-search failed, skipping this cruise: ${err.message}`);
            continue;
          }
        }

        console.log(`\n[azamara] [${i + 1}/${limit}] cabin fetch: ${target.id}`);
        try {
          const enriched = await _fetchAzamaraCabinData(session.page, target, i);
          if (enriched) {
            const idx = byId.get(target.id);
            cruises[idx] = enriched;
            deckEnrichedCount++;
            // Persist as soon as this cruise's cabins are fetched rather than
            // waiting for the whole pass — see the note above the loop.
            try {
              await ingestCruise(vendor.id, cruises[idx]);
              console.log(`[azamara] [${i + 1}/${limit}] ${target.id} saved to DB`);
            } catch (saveErr) {
              console.error(`[azamara] [${i + 1}/${limit}] ${target.id} save failed: ${saveErr.message}`);
            }
          }
        } catch (err) {
          console.error(`[azamara] [${i + 1}/${limit}] cabin fetch failed: ${err.message}`);
        }
      }
      console.log(`[azamara] deck pass complete: ${deckEnrichedCount}/${limit} cruises got cabin data`);

      // Final cleanup after last cruise
      await _azamaraWizardCleanup(session.page).catch(() => {});
    }

    return {
      vendorKey:      "azamara",
      source:         "azamara",
      browserMode:    session.mode,
      authentication: authResult,
      extracted:      items,
      cruises
    };
  } catch (error) {
    error.message = `Azamara scraper failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}
