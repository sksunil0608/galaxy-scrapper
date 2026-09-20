import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";

dotenv.config();

const USERNAME = process.env.FIRSTMATES_USER;
const PASSWORD = process.env.FIRSTMATES_PASS;

const LOGIN_URL   = "https://www.firstmates.com/login";
const CANVAS_URL  = "https://www.firstmates.com/portal/sw-canvas?newBooking=1&forceSamlLogin=true";
const SWT_BASE    = "https://swt.firstmates.com/fmlogin";

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

function mapGenericCategoryToType(code, description) {
  const c = String(code ?? "").toUpperCase();
  const d = String(description ?? "").toUpperCase();
  if (c.includes("BALCONY") || d.includes("BALCONY") || d.includes("VERANDA") || d.includes("TERRACE")) return "Balcony";
  if (c.includes("OUTSIDE") || d.includes("OUTSIDE") || c.includes("OCEAN") || d.includes("OCEAN") ||
      c.includes("EXTERIOR") || d.includes("EXTERIOR") || c.includes("WINDOW") || d.includes("WINDOW")) return "Exterior";
  if (c.includes("INSIDE") || d.includes("INSIDE") || c.includes("INTERIOR") || d.includes("INTERIOR") || d.includes("SOCIAL")) return "Interior";
  if (d.includes("SUITE") || d.includes("QUARTERS") || d.includes("ROCKSTAR")) return "Suite";
  return null;
}

function inferCabinType(category) {
  const web  = category.genericCategoriesVal?.WEB;
  const meta = category.genericCategoriesVal?.META;
  const desc = category.ctgInfo?.description;
  return (
    mapGenericCategoryToType(web?.code, web?.description) ??
    mapGenericCategoryToType(meta?.code, meta?.description) ??
    mapGenericCategoryToType(category.ctgInfo?.code, desc)
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
      portCharges: getInvoiceAmount(category.invoiceVal, "TAXES & FEES"),
      capacity: normalizeInteger(category.ctgInfo.capacityVal),
      childBeds: normalizeInteger(category.ctgInfo.childBedsVal),
      trend: null,
      range7d: null,
      confidence: inferCabinConfidence(category),
      promos: unique(category.promoCodesVal ?? []),
      classifications: buildCategoryClassifications(category)
    }));
}

function buildCruisePromotions(item) {
  return unique((item.ctgsVal ?? []).flatMap((c) => c.promoCodesVal ?? []));
}

function inferCruiseConfidence(item) {
  return (item.ctgsVal?.length ?? 0) > 0 ? "Medium" : "Low";
}

function normalizeFirstMatesCruise(item) {
  const id = item.pkg?.pkgCode ?? null;
  if (!id) return null;

  const portFrom = item.locFrom ?? item.pkg?.locFrom?.code ?? null;
  const portTo   = item.locTo   ?? item.pkg?.locTo?.code   ?? null;

  return {
    id,
    ship:        item.ship ?? null,
    shipCode:    item.ship ?? null,
    shipDetails: null,
    package:     item.pkg?.pkgName ?? null,
    portFrom,
    portTo,
    routeLabel:  (portFrom || portTo) ? `${portFrom ?? "Unknown"} -> ${portTo ?? "Unknown"}` : null,
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
    // kept for the cabin/deck wizard: departure/arrival ref ids + raw ctgsVal
    departureIdVal: item.departureIdVal ?? null,
    arrivalIdVal:   item.arrivalIdVal ?? null,
    rawPayload:     item
  };
}

// ── Auth (Keycloak SSO) ─────────────────────────────────────────────────────

async function ensureLoggedIn(page) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(5000);
  if (!page.url().includes("auth.firstmates.com")) return;

  const userField = page.locator('input[type="email"], input[name="username"], input#username').first();
  const visible = await userField.isVisible({ timeout: 15000 }).catch(() => false);
  if (!visible) return;

  await userField.fill(USERNAME);
  await page.locator('input[type="password"], input#password').first().fill(PASSWORD);
  await Promise.allSettled([
    page.waitForURL((u) => !u.toString().includes("auth.firstmates.com"), { timeout: 30000 }),
    page.locator('button[type="submit"], input[type="submit"]').first().click({ force: true })
  ]);
  await page.waitForTimeout(4000);
}

async function ensureFirstMatesAuthentication(session) {
  const { page } = session;
  if (!USERNAME || !PASSWORD) {
    throw new Error("FIRSTMATES_USER and FIRSTMATES_PASS must be set in .env before using the FirstMates scraper.");
  }

  console.log("[firstmates] logging in / verifying session");
  await ensureLoggedIn(page);
  await session.persistAuthState();

  return { success: true, message: "FirstMates authenticated." };
}

// ── Navigate to the voyage search step, run the search, capture /availability/pkgs ──

// The sw-canvas GWT navigation is intermittently flaky — an iframe sometimes
// fails to render — so retry the whole reach-and-search before giving up.
//
// Two back-to-back attempts weren't enough: the failure is session-wide rather
// than per-month (one run searched 12 months without a miss, the next failed
// all 9 with "voyage search frame never appeared"), so an immediate retry just
// re-uses the same wedged canvas. Back off between attempts and, from the
// second onwards, force a re-login so the last try gets a fresh session.
const REACH_ATTEMPTS = 3;

async function reachVoyageSearchAndSearch(page, shipName = null, period = null) {
  let lastErr;
  for (let attempt = 1; attempt <= REACH_ATTEMPTS; attempt++) {
    try {
      return await reachVoyageSearchAndSearchOnce(page, shipName, period);
    } catch (err) {
      lastErr = err;
      if (attempt === REACH_ATTEMPTS) break;

      const backoffMs = 5000 * attempt;
      console.log(`[firstmates] reach-and-search failed (${err.message}) — attempt ${attempt}/${REACH_ATTEMPTS}, retrying in ${backoffMs / 1000}s`);
      await page.waitForTimeout(backoffMs);

      if (attempt >= 2) {
        console.log("[firstmates] resetting session before final attempt");
        await ensureLoggedIn(page).catch(() => {});
      }
    }
  }
  throw lastErr;
}

// The Ship dropdown (e.g. "BR Brilliant Lady", "SC Scarlet Lady") lives inside
// the vx-voyageSearchInterval iframe alongside Brand/Month/Year — found by its
// <label> text since GWT auto-generates the actual element id per session.
async function selectFirstMatesShip(frame, shipName) {
  const shipFilter = shipName.trim().toUpperCase();
  const matched = await frame.evaluate((filter) => {
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
    console.log(`[firstmates] ship filter "${shipName}" — no matching option found in Ship dropdown, leaving unfiltered`);
    return false;
  }
  try {
    await frame.locator(`#${matched.selectId}`).selectOption(matched.value, { timeout: 10000 });
  } catch (err) {
    // Same GWT form family as Azamara/Celestyal — native selectOption can time
    // out on a select that's visible/attached but not "actionable" by
    // Playwright's strict checks. Fall back to a direct value-set + change event.
    console.log(`[firstmates] native selectOption failed (${err.message.split("\n")[0]}) — falling back to JS value-set`);
    await frame.evaluate(({ selectId, value }) => {
      const el = document.getElementById(selectId);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { selectId: matched.selectId, value: matched.value });
  }
  console.log(`[firstmates] ship filter set: ${matched.label}`);
  return true;
}

// The search form's Month/Year dropdowns were never touched, so every run
// searched whichever month the form happened to default to — which is why this
// vendor kept coming back with 0-1 sailings. Same label-based lookup as the
// Ship select above (GWT regenerates element ids per session).
async function selectFirstMatesMonthYear(frame, monthIndex, year) {
  const MONTHS = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const wanted = { Month: MONTHS[monthIndex], Year: String(year) };
  const applied = {};

  for (const [labelText, optionText] of Object.entries(wanted)) {
    const matched = await frame.evaluate(({ labelText, optionText }) => {
      const selects = [...document.querySelectorAll("select")].filter(s => s.offsetParent !== null);
      const target = selects.find(s => {
        const lab = s.closest("label")?.innerText
          || document.querySelector(`label[for="${s.id}"]`)?.innerText;
        return lab && lab.trim().toLowerCase() === labelText.toLowerCase();
      });
      if (!target) return null;
      const opt = [...target.options].find(o =>
        o.textContent.trim().toLowerCase() === optionText.toLowerCase()
      );
      return opt ? { selectId: target.id, value: opt.value } : null;
    }, { labelText, optionText });

    if (!matched) continue;

    try {
      await frame.locator(`#${matched.selectId}`).selectOption(matched.value, { timeout: 10000 });
    } catch {
      // Same GWT quirk the Ship select hits — fall back to a direct value-set.
      await frame.evaluate(({ selectId, value }) => {
        const el = document.getElementById(selectId);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { selectId: matched.selectId, value: matched.value });
    }
    applied[labelText] = optionText;
  }

  const done = Object.keys(applied).length === 2;
  console.log(`[firstmates] search period: ${applied.Month ?? "?"} ${applied.Year ?? "?"}${done ? "" : " (dropdown not found — using form default)"}`);
  return done;
}

async function reachVoyageSearchAndSearchOnce(page, shipName = null, period = null) {
  // Attach the auth-token listener BEFORE navigating — session/hosting-params
  // (which carries the SwToken) fires during the initial sw-canvas page load,
  // so a listener attached later would miss it.
  let authToken = null;
  const onAuthResponse = async (res) => {
    if (/session\/hosting-params/.test(res.url()) && !authToken) {
      try { authToken = (await res.json())?.session?.authToken ?? null; } catch {}
    }
  };
  page.on("response", onAuthResponse);

  await page.goto(CANVAS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  if (page.url().includes("auth.firstmates.com")) {
    console.log("[firstmates] bounced to Keycloak mid-navigation — logging in again");
    await ensureLoggedIn(page);
    await page.goto(CANVAS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  }

  let wizardFrame = null;
  for (let i = 0; i < 25; i++) {
    wizardFrame = page.frames().find((f) => f.url().includes("vx-guestsInfo"));
    if (wizardFrame) break;
    await page.waitForTimeout(2000);
  }
  if (wizardFrame) {
    const contBtn = wizardFrame.locator('a:has-text("Continue")').last();
    if (await contBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await contBtn.click({ force: true });
      await page.waitForTimeout(4000);
    }
  }

  let searchFrame = null;
  for (let i = 0; i < 20; i++) {
    searchFrame = page.frames().find((f) => f.url().includes("vx-voyageSearchInterval"));
    if (searchFrame) break;
    await page.waitForTimeout(2000);
  }
  if (!searchFrame) throw new Error("FirstMates voyage search frame never appeared");

  if (shipName) await selectFirstMatesShip(searchFrame, shipName);
  if (period) await selectFirstMatesMonthYear(searchFrame, period.monthIndex, period.year);

  let pkgsResponse = null;
  const onResponse = async (res) => {
    if (/swt\.firstmates\.com\/fmlogin\/rest\/availability\/pkgs/.test(res.url()) && !pkgsResponse) {
      try { pkgsResponse = await res.json(); } catch {}
    }
  };
  page.on("response", onResponse);

  try {
    await searchFrame.locator('a:has-text("Search Voyages")').first().click({ force: true });
    await page.waitForTimeout(6000);
    for (let i = 0; i < 6 && !pkgsResponse; i++) {
      await searchFrame.locator('a:has-text("Search Voyages")').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  } finally {
    page.off("response", onResponse);
    page.off("response", onAuthResponse);
  }

  if (!pkgsResponse) throw new Error("FirstMates /availability/pkgs never returned a response");

  // Fallback: on a warm/reused browser profile, the app can skip re-fetching
  // hosting-params on load (already cached client-side), so the passive
  // listener above sometimes never fires. Call the endpoint ourselves —
  // it's a plain session-scoped GET, safe to call anytime post-login.
  if (!authToken) {
    const fmFrame = page.frames().find((f) => f.url().includes("swt.firstmates.com")) || searchFrame;
    try {
      authToken = await fmFrame.evaluate(async () => {
        const r = await fetch("/fmlogin/rest/session/hosting-params", { credentials: "include", headers: { Accept: "application/json" } });
        if (!r.ok) return null;
        const j = await r.json();
        return j?.session?.authToken ?? null;
      });
      if (authToken) console.log("[firstmates] authToken recovered via direct fetch fallback");
    } catch {}
  }

  return { searchFrame, pkgsResponse, authToken };
}

// Click the real (visible) "Continue" span — this DOM has multiple hidden
// dialog-template "Continue" <a> duplicates elsewhere on the page, so we must
// filter by actual visibility + a non-zero bounding box, not just text match.
async function clickRealContinue(frame, page) {
  const spanLocs = frame.locator('span:text-is("Continue")');
  const count = await spanLocs.count();
  for (let i = 0; i < count; i++) {
    const loc = spanLocs.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 0) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
  }
  return false;
}

async function selectVoyageAndContinue(searchFrame, page, pkgCode) {
  // searchFrame may be a stale reference if the caller is re-invoking this
  // after a Discard cycle (which navigates back to the results page in a
  // brand new iframe) — always re-poll for the live frame first.
  let freshFrame = page.frames().find((f) => f.url().includes("vx-voyageSearchInterval")) || searchFrame;
  for (let w = 0; w < 10; w++) {
    const hasRows = await freshFrame.evaluate(() => document.querySelectorAll("table tr").length > 0).catch(() => false);
    if (hasRows) break;
    await page.waitForTimeout(1000);
    freshFrame = page.frames().find((f) => f.url().includes("vx-voyageSearchInterval")) || freshFrame;
  }

  await freshFrame.evaluate((code) => {
    const rows = [...document.querySelectorAll("table tr")];
    const row = rows.find((r) => (r.textContent || "").includes(code));
    const cb = row?.querySelector('input[type="checkbox"]');
    if (cb) cb.click();
  }, pkgCode).catch(() => {});
  await page.waitForTimeout(1500);

  freshFrame = page.frames().find((f) => f.url().includes("vx-voyageSearchInterval")) || freshFrame;
  const clicked = await clickRealContinue(freshFrame, page);
  if (!clicked) throw new Error(`FirstMates: could not click Continue for voyage ${pkgCode}`);

  let ctgFrame = null;
  for (let i = 0; i < 15; i++) {
    ctgFrame = page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch"));
    if (ctgFrame) break;
    await page.waitForTimeout(1500);
  }
  if (!ctgFrame) throw new Error(`FirstMates: Cabins page never appeared for voyage ${pkgCode}`);
  await ctgFrame.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3000);
  return page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch")) || ctgFrame;
}

// Read the category codes actually rendered on the Cabins page right now.
// The bulk /availability/pkgs search can return a slightly different set of
// rate-plan codes (e.g. a promo-only code) than what the live booking page
// shows once a real occupancy/date context is active, so the codes we drive
// the "+" clicks with must come from the DOM, not the earlier search response.
async function readVisibleCategoryCodes(ctgFrame) {
  const page = ctgFrame.page();
  for (let attempt = 0; attempt < 8; attempt++) {
    const freshFrame = page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch")) || ctgFrame;
    const codes = await freshFrame.evaluate(() => {
      const found = new Set();
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length !== 0) continue;
        const text = (el.textContent || "").trim();
        if (!/^[A-Z]{1,3}[0-9]?$/.test(text)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.width > 60 || r.height < 8) continue;
        // must have a "+" stepper somewhere among its row/section ancestors
        let anc = el, hasPlus = false;
        for (let depth = 0; depth < 8 && anc && !hasPlus; depth++) {
          hasPlus = [...anc.querySelectorAll("*")].some(
            (e) => e.children.length === 0 && (e.textContent || "").trim() === "+"
          );
          anc = anc.parentElement;
        }
        if (hasPlus) found.add(text);
      }
      return [...found];
    }).catch(() => []);
    if (codes.length) return codes;
    await page.waitForTimeout(1000).catch(() => {});
  }
  return [];
}

// Expand every "Show Available Categories" group on the Cabins page so every
// category's "+" stepper becomes clickable.
async function expandAllCategoryGroups(ctgFrame) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await ctgFrame.evaluate(() => {
      const btns = [...document.querySelectorAll("a, button")]
        .filter((el) => /show available categories/i.test(el.textContent || "") && el.getBoundingClientRect().width > 0);
      btns.forEach((b) => b.click());
      return btns.length;
    }).catch(() => 0);
    if (!clicked) break;
  }
}

// Find and click the "+" stepper button for a given category code.
//
// The badge-ancestor-walk (find the element whose own text is exactly the
// category code, then walk up until an ancestor also contains a "+" glyph)
// is done inside the frame via evaluate() — but getBoundingClientRect() from
// inside an iframe returns FRAME-LOCAL coordinates, not page coordinates, and
// this iframe is offset within the outer page. Tag the found element with a
// temporary marker attribute instead, then use Playwright's own
// locator.boundingBox() (which resolves the iframe offset internally via
// CDP) to get real page coordinates — the same fix that was needed for the
// "Continue" button. Polls for a few seconds since the Cabins page can still
// be rendering when we first arrive.
async function clickPlusButton(ctgFrame, code) {
  const page = ctgFrame.page();
  const MARKER = "data-fm-plus-target";
  for (let attempt = 0; attempt < 10; attempt++) {
    const freshFrame = page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch")) || ctgFrame;
    const tagged = await freshFrame.evaluate(({ categoryCode, marker }) => {
      document.querySelectorAll(`[${marker}]`).forEach((e) => e.removeAttribute(marker));
      const badge = [...document.querySelectorAll("*")].find(
        (e) => e.children.length === 0 && (e.textContent || "").trim() === categoryCode
      );
      if (!badge) return false;
      let anc = badge;
      for (let depth = 0; depth < 8 && anc; depth++) {
        const candidates = [...anc.querySelectorAll("*")].filter(
          (e) => e.children.length === 0 && (e.textContent || "").trim() === "+"
        );
        if (candidates.length) {
          const r = candidates[0].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { candidates[0].setAttribute(marker, "1"); return true; }
        }
        anc = anc.parentElement;
      }
      return false;
    }, { categoryCode: code, marker: MARKER }).catch(() => false);

    if (tagged) {
      const box = await freshFrame.locator(`[${MARKER}]`).boundingBox().catch(() => null);
      if (box && box.width > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  return false;
}

// Click "Discard" (top action bar) to cancel the temporary SHOPPING booking
// created by selecting a voyage + adding a cabin. This is the FirstMates
// equivalent of Azamara's "Exit Editing" wizard cleanup.
async function firstMatesWizardCleanup(page) {
  try {
    const ctgFrame = page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch") || f.url().includes("vx-"));
    if (ctgFrame) {
      const discardClicked = await ctgFrame.evaluate(() => {
        const btn = [...document.querySelectorAll("a, button")]
          .find((el) => /^discard$/i.test((el.textContent || "").trim()) && el.getBoundingClientRect().width > 0);
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (discardClicked) {
        await page.waitForTimeout(2000);
        // Confirm any "Are you sure?" dialog that follows
        const confirmClicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll("a, button")]
            .find((el) => /^(yes|discard|ok|confirm)$/i.test((el.textContent || "").trim()) && el.getBoundingClientRect().width > 0);
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(() => false);
        if (confirmClicked) await page.waitForTimeout(2000);
        console.log("[firstmates] wizard cleanup: clicked Discard");
        return;
      }
    }
  } catch {}
  console.log("[firstmates] wizard cleanup: Discard not found, navigating home");
}

function toCabinsFromEntity(list) {
  return (list ?? []).map((item) => ({
    cabinNumber: String(item.cabinNumber),
    deckNumber:  item.deckNumber != null ? Math.round(item.deckNumber) : null,
    deckName:    item.deckNumber != null ? `Deck ${Math.round(item.deckNumber)}` : null,
    capacity:    item.capacity != null ? Math.round(item.capacity) : null,
    status:      "Available"
  }));
}

// Internal: fetch per-cabin (cabinNumber + deckNumber) data for every category
// of a single voyage.
//
// The fast path (no per-category UI clicking): the swt.firstmates.com app
// authorizes its own /entity/cabins calls with an `Authorization: SwToken
// token=<authToken>` header, where authToken comes from the session/
// hosting-params response captured at page load. We do ONE real "+" + Continue
// UI cycle to (a) establish the booking session the endpoint needs and
// (b) capture the exact working request body (its sailDate is in a specific
// GMT-string format the server expects, easier to replay verbatim than to
// reconstruct). That first cycle yields the first category's cabins directly;
// every remaining category is then a plain direct fetch() with the auth header
// and the captured body — category swapped, no more clicking. ~80s for a whole
// voyage regardless of category count.
async function fetchFirstMatesCabinData(page, match) {
  const { searchFrame, pkgsResponse, authToken } = await reachVoyageSearchAndSearchCached(page);

  // Live availability can shift between the original bulk search and this
  // (possibly re-run) search — re-derive the category list from THIS exact
  // search response for the voyage, not the stale one the caller built earlier.
  const items = Array.isArray(pkgsResponse) ? pkgsResponse : [];
  const freshItem = items.find((item) => item.pkg?.pkgCode === match.id);
  if (freshItem) {
    const freshMatch = normalizeFirstMatesCruise(freshItem);
    if (freshMatch) match = { ...match, ...freshMatch, cabinCategories: freshMatch.cabinCategories };
  }

  const ctgFrame = await selectVoyageAndContinue(searchFrame, page, match.id);
  await expandAllCategoryGroups(ctgFrame);

  // Codes actually rendered on the live Cabins page are the source of truth
  // for which categories are bookable — not the bulk search's ctgsVal, which
  // can list a different rate-plan snapshot.
  const visibleCodes = await readVisibleCategoryCodes(ctgFrame);
  console.log(`[firstmates] ${match.id}: visible category codes on page: ${visibleCodes.join(", ")}`);

  const byCode = new Map(match.cabinCategories.map((c) => [c.code, c]));
  const okCats = visibleCodes.length
    ? visibleCodes.map((code) => byCode.get(code) ?? { code, name: null, status: "Available", avlResult: "OK" })
    : match.cabinCategories.filter((c) => c.avlResult === "OK");
  const wtlCats = match.cabinCategories.filter((c) => c.avlResult !== "OK" && !visibleCodes.includes(c.code));
  const cabinsByCategory = {};
  for (const cat of wtlCats) cabinsByCategory[cat.code] = [];

  if (okCats.length === 0) {
    console.log(`[firstmates] ${match.id}: no OK categories, skipping cabin fetch`);
    await firstMatesWizardCleanup(page);
    match.cabinCategories = match.cabinCategories.map((cat) => ({ ...cat, cabins: cabinsByCategory[cat.code] ?? [] }));
    return match;
  }

  // Capture the first successful /entity/cabins request — both its data (for
  // that category) and its body (the reusable template for direct fetches).
  let workingBody = null;
  const entityCabinsByCategory = {};
  const onResponse = async (res) => {
    const url = res.url();
    if (url.endsWith("/rest/entity/cabins") && res.request().method() === "POST" && res.status() === 200) {
      try {
        const reqBody = JSON.parse(res.request().postData() ?? "{}");
        if (!workingBody) workingBody = reqBody;
        const cat = reqBody.category;
        if (cat && !entityCabinsByCategory[cat]) {
          const json = await res.json();
          if (Array.isArray(json)) {
            entityCabinsByCategory[cat] = toCabinsFromEntity(json);
            console.log(`[firstmates] ${cat}: ${entityCabinsByCategory[cat].length} cabins captured (UI cycle)`);
          }
        }
      } catch {}
    }
  };
  page.on("response", onResponse);

  // One UI cycle on the first category to prime the booking session + capture
  // the working request template. Retry once for this app's inherent flakiness.
  // Wait for the CABIN DATA (not just workingBody, which is set synchronously
  // before the response body is awaited) so we don't redundantly re-fetch the
  // first category in the direct-fetch loop below.
  const firstCat = okCats[0];
  for (let retry = 0; retry < 2 && !entityCabinsByCategory[firstCat.code]; retry++) {
    const clicked = await clickPlusButton(ctgFrame, firstCat.code);
    if (!clicked) { console.log(`[firstmates] ${match.id}: "+" not found for ${firstCat.code} (attempt ${retry + 1})`); continue; }
    await page.waitForTimeout(1000);
    const frameForContinue = page.frames().find((f) => f.url().includes("vx-genCtgAvailSearch")) || ctgFrame;
    await clickRealContinue(frameForContinue, page);
    for (let w = 0; w < 24 && !entityCabinsByCategory[firstCat.code]; w++) await page.waitForTimeout(500);
  }
  page.off("response", onResponse);

  if (!workingBody || !authToken) {
    console.log(`[firstmates] ${match.id}: could not prime session (workingBody=${!!workingBody}, authToken=${!!authToken}) — only first category captured`);
  } else {
    // Fast path: direct fetch every remaining category with the SwToken header.
    const authHeader = `SwToken token=${authToken}`;
    const fmFrame = page.frames().find((f) => f.url().includes("swt.firstmates.com")) || ctgFrame;
    for (const cat of okCats) {
      if (entityCabinsByCategory[cat.code]) continue; // already have it (the primed one)
      try {
        const result = await fmFrame.evaluate(async ({ body, auth }) => {
          try {
            const r = await fetch("/fmlogin/rest/entity/cabins", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain", "Authorization": auth },
              body: JSON.stringify(body)
            });
            if (!r.ok) return { ok: false, status: r.status };
            return { ok: true, data: await r.json() };
          } catch (e) { return { ok: false, status: -1, error: e.message }; }
        }, { body: { ...workingBody, category: cat.code }, auth: authHeader });

        if (result.ok && Array.isArray(result.data)) {
          entityCabinsByCategory[cat.code] = toCabinsFromEntity(result.data);
          console.log(`[firstmates] ${cat.code}: ${entityCabinsByCategory[cat.code].length} cabins (direct fetch + SwToken)`);
        } else {
          console.log(`[firstmates] ${cat.code}: direct fetch failed (status=${result.status})`);
        }
      } catch (e) {
        console.log(`[firstmates] ${cat.code}: direct fetch error – ${e.message}`);
      }
    }
  }

  // Discard the temporary booking we created to prime the session.
  await firstMatesWizardCleanup(page);

  for (const cat of okCats) cabinsByCategory[cat.code] = entityCabinsByCategory[cat.code] ?? cabinsByCategory[cat.code] ?? [];

  // Merge back: keep every originally-known category (enriched with cabins
  // where we have them) plus any codes that only showed up live on the Cabins
  // page and weren't in the original bulk search response.
  const knownCodes = new Set(match.cabinCategories.map((c) => c.code));
  const extraCats = okCats.filter((c) => !knownCodes.has(c.code));
  match.cabinCategories = [
    ...match.cabinCategories.map((cat) => ({ ...cat, cabins: cabinsByCategory[cat.code] ?? [] })),
    ...extraCats.map((cat) => ({ ...cat, cabins: cabinsByCategory[cat.code] ?? [] }))
  ];
  return match;
}

// ── Session reuse (kept open across requests, same pattern as Azamara) ──────

let cachedFirstMatesSession = null;
let firstMatesQueue = Promise.resolve();
let cachedSearchState = null; // { searchFrame, pkgsResponse } for the current bulk search

async function getOrCreateFirstMatesSession() {
  if (cachedFirstMatesSession) {
    const alive = await cachedFirstMatesSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedFirstMatesSession;
    await cachedFirstMatesSession.close().catch(() => {});
    cachedFirstMatesSession = null;
  }
  cachedFirstMatesSession = await createScraperSession({
    userDataDir:      "./sessions/firstmates-user-data",
    storageStatePath: "./sessions/.auth/firstmates-storage.json",
    headless:         false,
    slowMo:           0
  });
  return cachedFirstMatesSession;
}

function runExclusiveFirstMates(fn) {
  const result = firstMatesQueue.then(fn);
  firstMatesQueue = result.catch(() => {});
  return result;
}

// Cached wrapper so a run of multiple voyages against the SAME broad search
// window only searches once, then re-selects a different row per voyage.
async function reachVoyageSearchAndSearchCached(page, shipName = null) {
  if (cachedSearchState) return cachedSearchState;
  cachedSearchState = await reachVoyageSearchAndSearch(page, shipName);
  return cachedSearchState;
}

function invalidateSearchCache() {
  cachedSearchState = null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function authenticateFirstMates() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/firstmates-user-data",
    storageStatePath: "./sessions/.auth/firstmates-storage.json",
    headless:         false,
    slowMo:           0
  });
  try {
    const authResult = await ensureFirstMatesAuthentication(session);
    return { vendorKey: "firstmates", browserMode: session.mode, ...authResult };
  } catch (error) {
    error.message = `FirstMates authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

/**
 * On-demand single-voyage fetch for "Get Full Details" — re-runs the bulk
 * search, finds the matching cruise by code, then fetches real cabin+deck
 * data for every category via the confirmed active-booking flow.
 */
export async function fetchFirstMatesVoyageByCode(cruiseCode) {
  return runExclusiveFirstMates(async () => {
    const session = await getOrCreateFirstMatesSession();
    await ensureFirstMatesAuthentication(session);
    invalidateSearchCache();

    const { pkgsResponse } = await reachVoyageSearchAndSearchCached(session.page);
    const items = Array.isArray(pkgsResponse) ? pkgsResponse : [];
    const cruises = items.map(normalizeFirstMatesCruise).filter((c) => c?.id);

    const match = cruises.find((c) => c.id === cruiseCode);
    if (!match) throw new Error(`Voyage ${cruiseCode} not found in FirstMates search results`);

    const enriched = await fetchFirstMatesCabinData(session.page, match);
    invalidateSearchCache();
    return enriched?.cabinCategories ?? null;
  });
}

export async function runFirstMatesScraper(options = {}) {
  // monthsAhead walks the Month/Year dropdowns. The form only ever searches a
  // single month, so without this the run returns just that month's sailings
  // (0-1 rows once the current month is nearly over).
  const { listOnly = true, maxDeckCruises = Infinity, shipName = null, monthsAhead = 12 } = options;

  const session = await createScraperSession({
    userDataDir:      "./sessions/firstmates-user-data",
    storageStatePath: "./sessions/.auth/firstmates-storage.json",
    headless:         false,
    slowMo:           0
  });

  try {
    const authResult = await ensureFirstMatesAuthentication(session);

    // Search month by month and merge — one search covers exactly one month.
    const months = Math.max(1, Number(monthsAhead) || 1);
    const cursor = new Date();
    const items = [];
    const seenKeys = new Set();

    for (let i = 0; i < months; i++) {
      const period = { monthIndex: cursor.getMonth(), year: cursor.getFullYear() };
      try {
        invalidateSearchCache();
        const { pkgsResponse } = await reachVoyageSearchAndSearch(session.page, shipName, period);
        const rows = Array.isArray(pkgsResponse) ? pkgsResponse : [];
        // The same sailing can surface in adjacent months' results.
        let added = 0;
        for (const row of rows) {
          const key = JSON.stringify([row?.pkg?.pkgCode ?? row?.pkgCode, row?.startDateVal?.utc ?? row?.startDate]);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          items.push(row);
          added++;
        }
        console.log(`[firstmates] ${period.monthIndex + 1}/${period.year}: ${rows.length} sailings (${added} new)`);
      } catch (err) {
        // A month that fails shouldn't cost the rest of the horizon.
        console.log(`[firstmates] ${period.monthIndex + 1}/${period.year}: failed (${err.message.split("\n")[0]})`);
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    console.log(`[firstmates] /availability/pkgs returned ${items.length} sailings across ${months} month(s)`);

    const cruises = items.map(normalizeFirstMatesCruise).filter((c) => c?.id);
    console.log(`[firstmates] normalized ${cruises.length} cruises`);

    if (!listOnly && cruises.length > 0) {
      const limit = Math.min(cruises.length, maxDeckCruises);
      console.log(`\n[firstmates] Full detail mode — fetching cabin data for ${limit}/${cruises.length} cruises`);

      for (let i = 0; i < limit; i++) {
        console.log(`\n[firstmates] [${i + 1}/${limit}] cabin fetch: ${cruises[i].id}`);
        try {
          invalidateSearchCache();
          const enriched = await fetchFirstMatesCabinData(session.page, cruises[i]);
          if (enriched) cruises[i] = enriched;
        } catch (err) {
          console.error(`[firstmates] [${i + 1}/${limit}] cabin fetch failed: ${err.message}`);
        }
      }
    }

    return {
      vendorKey:      "firstmates",
      source:         "firstmates",
      browserMode:    session.mode,
      authentication: authResult,
      extracted:      items,
      cruises
    };
  } catch (error) {
    error.message = `FirstMates scraper failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}
