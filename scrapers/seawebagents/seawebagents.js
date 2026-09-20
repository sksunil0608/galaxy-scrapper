import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";
dotenv.config();

const USERNAME  = process.env.NCL_USER;
const PASSWORD  = process.env.NCL_PASS;
const LOGIN_URL = "https://seawebagents.ncl.com/Security/login/";

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseMDY(dateStr) {
  if (!dateStr) return null;
  const [month, day, year] = String(dateStr).split("/");
  if (!month || !day || !year) return null;
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function addDays(isoStr, days) {
  if (!isoStr || !days) return null;
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function toTitleCase(str) {
  if (!str) return str;
  return str.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function parseItineraryPorts(itinerary) {
  if (!itinerary) return { portFrom: null, portTo: null, routeLabel: null };

  // "FROM X TO Y" — one-way routes
  const fromTo = itinerary.match(/FROM\s+(.+?)\s+TO\s+([^:,]+)/i);
  if (fromTo) {
    const portFrom = toTitleCase(fromTo[1].trim());
    const portTo   = toTitleCase(fromTo[2].trim());
    return { portFrom, portTo, routeLabel: `${portFrom} -> ${portTo}` };
  }

  // "ROUND-TRIP PORT" or "ROUND TRIP PORT" — homeport round trip
  const roundTrip = itinerary.match(/ROUND[- ]TRIP\s+([^:,]+)/i);
  if (roundTrip) {
    const port = toTitleCase(roundTrip[1].trim());
    return { portFrom: port, portTo: port, routeLabel: `${port} -> ${port}` };
  }

  // "FROM X" only
  const fromOnly = itinerary.match(/FROM\s+(.+?)(?:\s*[:|,]|$)/i);
  if (fromOnly) {
    const port = toTitleCase(fromOnly[1].trim());
    return { portFrom: port, portTo: port, routeLabel: `${port} -> ${port}` };
  }

  return { portFrom: null, portTo: null, routeLabel: null };
}

function mapCabinStatus(raw) {
  if (!raw) return { status: "Sold Out", avlResult: "" };
  const v = String(raw).toUpperCase();
  if (v === "OK")  return { status: "Available", avlResult: "OK" };
  if (v === "GTY") return { status: "Guarantee", avlResult: "GTY" };
  return { status: "Sold Out", avlResult: raw };
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function jitter(minMs = 1500, maxMs = 3000) {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function ensureAuthentication(session) {
  const { page } = session;
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await sleep(2000);

  const alreadyLoggedIn = await page.locator("text=My Reservations").isVisible().catch(() => false);
  if (alreadyLoggedIn) {
    console.log("✅ Session reused.");
    return { success: true, alreadyLoggedIn: true };
  }

  await page.fill("#LoginForm_LoginForm_Email",    USERNAME);
  await page.fill("#LoginForm_LoginForm_Password", PASSWORD);
  await page.click("#LoginForm_LoginForm_action_doLogin");
  await sleep(5000);
  console.log("✅ Logged in. URL:", page.url());
  await session.persistAuthState();
  return { success: true, alreadyLoggedIn: false };
}

// ── Navigation helpers ────────────────────────────────────────────────────────

async function navigateToVacationForm(page) {
  await page.goto("https://seawebagents.ncl.com/tva/new/", { waitUntil: "domcontentloaded" });
  await sleep(1500);

  const vacLink = page.locator('a[href="/tva/new/search/"]').first();
  if (await vacLink.isVisible().catch(() => false)) {
    await vacLink.click();
    await sleep(1500);
  }

  // Must land on the search FORM, not the doform results page
  const onForm = page.url().replace(/\/$/, "") === "https://seawebagents.ncl.com/tva/new/search";
  if (!onForm) {
    await page.goto("https://seawebagents.ncl.com/tva/new/search/", { waitUntil: "domcontentloaded" });
    await sleep(1500);
  }

  await page.waitForSelector('input[name="From"]', { timeout: 15000 });
}

async function setDateField(page, selector, dateValue) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.click(selector, { clickCount: 3 });
    await sleep(200);
    await page.keyboard.type(dateValue, { delay: 40 });
    await sleep(200);
    await page.keyboard.press("Tab");
    await sleep(500);
    const actual = await page.inputValue(selector);
    if (actual === dateValue) return;
    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = val;
      ["input", "change", "blur"].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
    }, { sel: selector, val: dateValue });
    await sleep(400);
  }
}

// Targeted single-cruise search — same as reloadVoyageList but optionally fills
// the Ship selector to narrow results to just that ship's sailings.
async function reloadVoyageListForSingleCruise(page, fromDate, toDate, shipCode = null) {
  await navigateToVacationForm(page);

  // Fill date range
  await setDateField(page, 'input[name="From"]', fromDate); await sleep(300);
  await setDateField(page, 'input[name="To"]',   toDate);   await sleep(300);

  // Try to fill ship selector if shipCode is known
  if (shipCode) {
    const shipSelect = page.locator('select[name="Ship"], select[name="ship"], select[id*="ship" i]').first();
    if (await shipSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await shipSelect.selectOption({ value: shipCode }).catch(() =>
        shipSelect.selectOption({ label: new RegExp(shipCode, "i") }).catch(() => {})
      );
      console.log(`[seawebagents] ship filter set: ${shipCode}`);
      await sleep(200);
    }
  }

  const submitBtn = page.locator(
    '#SWXMLForm_SearchVacation_action_DoSearchVacation, input[value="Start Search"], form [type="submit"]'
  ).first();
  await submitBtn.waitFor({ state: "visible", timeout: 10000 });
  await submitBtn.click({ noWaitAfter: true });
  await Promise.race([
    page.waitForURL(url => url.toString().includes("/doform/"), { timeout: 35000 }),
    page.waitForSelector('.slick-row, input[name="voyage"]', { timeout: 35000 }),
    page.waitForSelector("text=Please narrow your search", { timeout: 35000 }),
  ]).catch(() => {});
  await sleep(1200);
  await page.waitForSelector('input[name="voyage"], .slick-row', { timeout: 15000 }).catch(() => {});
}

// ── Stage 1: Voyage list for one chunk ───────────────────────────────────────

// Re-submit the vacation search form so the voyage results list is freshly loaded.
// The NCL agent portal loses Select-button state after wizard navigation, so we
// must reload results before clicking Select on each voyage (except the first).
async function reloadVoyageList(page, fromDate, toDate) {
  await navigateToVacationForm(page);
  // Only type dates if they are not already set — saves time between voyages
  const curFrom = await page.inputValue('input[name="From"]').catch(() => '');
  const curTo   = await page.inputValue('input[name="To"]').catch(() => '');
  if (curFrom !== fromDate) {
    await setDateField(page, 'input[name="From"]', fromDate);
    await sleep(400);
  }
  if (curTo !== toDate) {
    await setDateField(page, 'input[name="To"]', toDate);
    await sleep(400);
  }
  const submitBtn = page.locator(
    '#SWXMLForm_SearchVacation_action_DoSearchVacation, input[value="Start Search"], form [type="submit"]'
  ).first();
  await submitBtn.waitFor({ state: "visible", timeout: 10000 });
  await submitBtn.click({ noWaitAfter: true });
  await Promise.race([
    page.waitForURL(url => url.toString().includes("/doform/"), { timeout: 35000 }),
    page.waitForSelector('.slick-row, input[name="voyage"]', { timeout: 35000 }),
    page.waitForSelector("text=Please narrow your search", { timeout: 35000 }),
  ]).catch(() => {});
  await sleep(2000);
  await page.waitForSelector('input[name="voyage"], .slick-row', { timeout: 15000 }).catch(() => {});
}

async function fetchVoyageChunk(page, fromDate, toDate, chunkIndex) {
  console.log(`\n[Chunk ${chunkIndex}] ${fromDate} → ${toDate}`);

  await reloadVoyageList(page, fromDate, toDate);

  const errorVisible = await page.locator("text=Please narrow your search").isVisible().catch(() => false);
  if (errorVisible) {
    console.log(`  ❌ Backend rejected range`);
    return [];
  }

  // Try JSON input
  const voyageData = await page.evaluate(() => {
    const input = document.querySelector('input[name="voyage"]');
    if (!input || !input.value) return [];
    try {
      const parsed = JSON.parse(input.value);
      return parsed.data ?? [];
    } catch (e) { return []; }
  });

  if (voyageData.length > 0) {
    console.log(`  ✅ JSON: ${voyageData.length} voyages`);
    return voyageData;
  }

  // Fallback: DOM slick-grid rows (scroll-through to handle virtual rendering)
  function extractDomRows(cells) {
    return null; // evaluated in-page below
  }

  const domRowMap = new Map(); // packageId → row

  const snapshotVoyageRows = async () => {
    const rows = await page.evaluate(() => {
      function parsePrice(text) {
        if (!text) return null;
        const n = parseFloat(text.replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : null;
      }
      return Array.from(document.querySelectorAll('.slick-row')).map(row => {
        const cells    = Array.from(row.querySelectorAll('.slick-cell'));
        const viewEl   = cells[4]?.querySelector('a');
        const viewHref = viewEl?.href ?? viewEl?.getAttribute('href') ?? '';
        const base     = viewHref.startsWith('http') ? viewHref : 'https://seawebagents.ncl.com' + viewHref;
        let params;
        try { params = new URL(base).searchParams; } catch { params = new URLSearchParams(); }
        return {
          ship:            cells[0]?.innerText.trim() || null,
          date:            cells[1]?.innerText.trim() || null,
          nights:          cells[3]?.innerText.trim() || null,
          itinerary:       cells[5]?.innerText.trim() || null,
          packageId:       params.get('packageId'),
          shipCode:        params.get('shipCode'),
          destination:     params.get('destination'),
          dateFrom:        params.get('from'),
          dateTo:          params.get('to'),
          shipName:        params.get('shipName'),
          itineraryUrl:    viewHref || null,
          priceHavenSuite: parsePrice(cells[7]?.innerText),
          priceSuite:      parsePrice(cells[8]?.innerText),
          priceBalcony:    parsePrice(cells[9]?.innerText),
          priceOutside:    parsePrice(cells[10]?.innerText),
          priceInside:     parsePrice(cells[11]?.innerText),
        };
      });
    });
    for (const r of rows) {
      if (r.packageId && !domRowMap.has(r.packageId)) domRowMap.set(r.packageId, r);
    }
  };

  await snapshotVoyageRows();

  // Scroll through voyage list to capture all virtual rows
  const { scrollHeight: vSH, clientHeight: vCH } = await page.evaluate(() => {
    const vp = document.querySelector('.slick-viewport');
    return vp ? { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight } : { scrollHeight: 0, clientHeight: 0 };
  });
  if (vSH > vCH) {
    const step = Math.max(30, Math.floor(vCH * 0.5));
    for (let pos = step; pos <= vSH + step; pos += step) {
      await page.evaluate(p => { const vp = document.querySelector('.slick-viewport'); if (vp) vp.scrollTop = p; }, pos);
      await sleep(100);
      await snapshotVoyageRows();
    }
    await page.evaluate(() => { const vp = document.querySelector('.slick-viewport'); if (vp) vp.scrollTop = 0; });
  }

  const domRows = [...domRowMap.values()];
  console.log(`  DOM rows: ${domRows.length}`);
  return domRows;
}

// ── Stage 2+3: Categories + Staterooms via wizard ────────────────────────────
//
// IMPORTANT: The NCL agent portal is a wizard state machine.
// Direct URL navigation to /agent-select-category/ returns 404.
// Correct flow:
//   voyage list → click "Select" → category page (_form_12)
//     → click first available category "Select" → stateroom page
//       → click "Show All Categories" (form submit)
//       → select ALL <option>s in swlistbox + click "Apply Parameters"
//       → extract _form_19 (all staterooms across all categories)
//     → click "Voyage" breadcrumb → back to voyage list

// Normalizes a category row read from the NCL DOM slick grid.
// confidence is left null so the ingestion service derives the real level:
//   High  = totalCabins + avail + cabinPrice all present (full stateroom data)
//   Medium = cabinPrice present but no totalCabins
//   Low   = no price (should not happen in full mode)
function normalizeCategoryItemFromDOM(row) {
  const code = row.code;
  if (!code) return null;

  const { status, avlResult } = mapCabinStatus(row.avlResult);

  const availStr = (row.avail ?? "").replace(/[^0-9]/g, "");
  const avail    = availStr !== "" ? parseInt(availStr, 10) : null;

  const promos = row.promos
    ? row.promos.split(/\s*\|\s*/).map(p => p.trim()).filter(Boolean)
    : [];

  return {
    code,
    name:           row.name || code,
    status,
    avlResult,
    totalCabins:    null,  // filled in from _form_19 staterooms after merge
    avail,
    available:      avail,
    cabinPrice:     row.cabinPrice,
    perPersonPrice: row.perPersonPrice,
    capacity:       row.capacity ? (parseInt(row.capacity, 10) || null) : null,
    confidence:     null,  // derived by ingestion based on completeness
    promos,
    cabins:         [],
    decks:          []
  };
}

function buildCabinDecksFromStateroomList(staterooms) {
  // staterooms: [{ Stateroom, Category, Deck, DeckName, Rank, Capacity, Rollaways }, ...]
  // Returns: Map<categoryCode, { totalCabins, decks: [{ number, name, staterooms }] }>
  const byCat = new Map();
  for (const s of staterooms) {
    const cat = s.Category;
    if (!cat) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const deckMap = byCat.get(cat);
    const dk = s.Deck ?? 0;
    if (!deckMap.has(dk)) deckMap.set(dk, { number: dk, name: s.DeckName ?? `DECK ${dk}`, staterooms: [] });
    deckMap.get(dk).staterooms.push(s.Stateroom);
  }

  const result = new Map();
  for (const [cat, deckMap] of byCat) {
    const decks = [...deckMap.values()].sort((a, b) => a.number - b.number);
    const totalCabins = decks.reduce((sum, d) => sum + d.staterooms.length, 0);
    result.set(cat, { totalCabins, decks });
  }
  return result;
}

// "cruises found" and "Grouping:" are static header elements always present on the
// voyage list page, regardless of virtual rendering. Use these — not slick rows.
async function isOnVoyageList(page) {
  // Check by URL — input[name="voyage"] also exists on stateroom/category pages
  // so text/DOM checks give false positives. The voyage list lives at the voyage
  // base URL or the doform POST-result URL.
  const url = page.url();
  return url.includes("/tva/new/voyage/") && !url.includes("/agent-select-");
}

async function goBackToVoyageList(page) {
  // If already on voyage list, nothing to do.
  if (await isOnVoyageList(page)) return;

  // The "Voyage" breadcrumb item is <li class="disabled"> on the voyage list
  // page (no href). On deeper pages (category/stateroom) the breadcrumb may
  // or may not be a link. The only reliable way back is a direct GET to the
  // base /tva/new/voyage/ URL — the user confirmed this restores the session's
  // voyage results without re-entering dates.
  await page.goto("https://seawebagents.ncl.com/tva/new/voyage/", { waitUntil: "domcontentloaded" });

  // Wait for the URL to be the voyage list page (not a wizard sub-page)
  await page.waitForURL(
    url => url.toString().includes("/tva/new/voyage/") && !url.toString().includes("/agent-select-"),
    { timeout: 20000 }
  ).catch(() => {});

  // Wait for slick-grid rows with actual packageId href links (not empty shells)
  await page.waitForSelector('.slick-row a[href*="packageId="]', { timeout: 15000 }).catch(() => {});
  await sleep(800);
}

async function fetchAllStateroomsOnPage(page) {
  // We're on /agent-select-stateroom/ — click "Show All Categories" (form submit)
  const showAllBtn = page.locator(
    '#SWXMLForm_SelectStateroom_selectAll, button[name*="DoShowAllCategories"], a:has-text("Show All Categories"), button:has-text("Show All Categories")'
  ).first();

  const showAllVisible = await showAllBtn.isVisible().catch(() => false);
  if (!showAllVisible) {
    console.log(`    No "Show All Categories" button found, skipping full stateroom scan`);
    // Extract whatever _form_19 has (just the one selected category)
    return await page.evaluate(() => {
      try { const d = window.VX?.get('_form_19'); return Array.isArray(d) ? d : []; } catch (_) { return []; }
    });
  }

  // Submit "Show All Categories" form
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
    showAllBtn.click()
  ]);
  await sleep(1000);

  // Select all category options in the <select.swlistbox>
  await page.evaluate(() => {
    const sel = document.querySelector('select.swlistbox');
    if (sel) [...sel.options].forEach(o => { o.selected = true; });
  });

  // Click "Apply Parameters" to submit the filter
  const applyBtn = page.locator(
    'input[id*="apply" i], button:has-text("Apply"), input[value="Apply Parameters"], button:has-text("Apply Parameters")'
  ).first();

  if (await applyBtn.isVisible().catch(() => false)) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
      applyBtn.click()
    ]);
    await sleep(1000);
  }

  const staterooms = await page.evaluate(() => {
    try { const d = window.VX?.get('_form_19'); return Array.isArray(d) ? d : []; } catch (_) { return []; }
  });
  console.log(`    Staterooms [vx:_form_19, all cats]: ${staterooms.length}`);
  return staterooms;
}

// Scrolls through the slick-grid viewport to force all virtual rows to render,
// collecting each unique category row as it appears. Returns array of row objects.
async function readAllCategoryRowsViaScroll(page) {
  const found = new Map(); // code → row data

  const snapshot = async () => {
    const rows = await page.evaluate(() => {
      function parsePrice(text) {
        if (!text) return null;
        const n = parseFloat(text.replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : null;
      }
      const out = [];
      document.querySelectorAll('.slick-row').forEach(row => {
        const cells = Array.from(row.querySelectorAll('.slick-cell')).map(c => c.innerText?.trim() ?? "");
        const code  = cells[0] ?? "";
        if (!code) return;
        const hasSelect = Array.from(row.querySelectorAll('a')).some(
          a => (a.innerText?.trim() ?? "").toLowerCase() === 'select'
        );
        if (!hasSelect) return;
        out.push({
          code,
          name:          cells[3] ?? "",
          capacity:      cells[4] ?? "",
          avlResult:     cells[6] ?? "",
          avail:         cells[7] ?? "",
          promos:        cells[8] ?? "",
          cabinPrice:    parsePrice(cells[9]),
          perPersonPrice: parsePrice(cells[10]),
        });
      });
      return out;
    });
    for (const r of rows) {
      if (r.code && !found.has(r.code)) found.set(r.code, r);
    }
  };

  // Collect what's initially rendered
  await snapshot();

  // Scroll through the viewport in small steps to trigger virtual row rendering
  const { scrollHeight, clientHeight } = await page.evaluate(() => {
    const vp = document.querySelector('.slick-viewport');
    return vp
      ? { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight }
      : { scrollHeight: 0, clientHeight: 0 };
  });

  if (scrollHeight > clientHeight) {
    const step = Math.max(30, Math.floor(clientHeight * 0.5));
    for (let pos = step; pos <= scrollHeight + step; pos += step) {
      await page.evaluate(p => {
        const vp = document.querySelector('.slick-viewport');
        if (vp) vp.scrollTop = p;
      }, pos);
      await sleep(120);
      await snapshot();
    }
    // Reset to top
    await page.evaluate(() => {
      const vp = document.querySelector('.slick-viewport');
      if (vp) vp.scrollTop = 0;
    });
    await sleep(300);
  }

  return [...found.values()];
}

// Scroll the voyage list slick-viewport until the target packageId row enters the DOM.
// Slick-grid uses virtual rendering — rows outside the viewport are removed from DOM.
async function scrollVoyageListToPackage(page, packageId) {
  const { scrollHeight, clientHeight } = await page.evaluate(() => {
    const vp = document.querySelector('.slick-viewport');
    return vp
      ? { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight }
      : { scrollHeight: 0, clientHeight: 0 };
  });
  if (scrollHeight <= clientHeight) return;

  const step = Math.max(40, Math.floor(clientHeight * 0.4));
  for (let pos = 0; pos <= scrollHeight + step; pos += step) {
    await page.evaluate(p => {
      const vp = document.querySelector('.slick-viewport');
      if (vp) vp.scrollTop = p;
    }, pos);
    await sleep(80);
    const found = await page.locator(
      `.slick-row:has(a[href*="packageId=${packageId}"])`
    ).first().isVisible().catch(() => false);
    if (found) return;
  }
  await page.evaluate(() => { const vp = document.querySelector('.slick-viewport'); if (vp) vp.scrollTop = 0; });
}

async function fetchCategoriesViaSelect(page, packageId) {
  // Scroll voyage list so the target row enters the DOM (virtual rendering).
  await scrollVoyageListToPackage(page, packageId);

  const selectBtn = page.locator(
    `.slick-row:has(a[href*="packageId=${packageId}"]) a:has-text("Select")`
  ).first();

  const visible = await selectBtn.isVisible().catch(() => false);
  if (!visible) {
    console.warn(`    No Select button found for packageId=${packageId}`);
    return { categories: [], cabinDeckMap: new Map() };
  }

  await selectBtn.click();
  await page.waitForURL(
    url => url.toString().includes('/agent-select-category/') || url.toString().includes('/agent-select-stateroom/'),
    { timeout: 20000 }
  ).catch(() => {});
  await sleep(1000);

  // NCL sometimes skips category page and lands directly on stateroom page
  if (page.url().includes('/agent-select-stateroom/')) {
    console.log(`    NCL skipped category page — reading staterooms directly`);
    const staterooms   = await fetchAllStateroomsOnPage(page);
    const cabinDeckMap = buildCabinDecksFromStateroomList(staterooms);
    await goBackToVoyageList(page);
    return { categories: [], cabinDeckMap };
  }

  // --- Category page ---
  // The slick-grid uses virtual rendering — only rows visible in the viewport
  // exist in the DOM at any time. Scroll through to collect ALL category rows.
  const rawDomRows = await readAllCategoryRowsViaScroll(page);
  console.log(`    Categories [DOM scroll-collect]: ${rawDomRows.length}`);

  // Click any one available category Select to reach the stateroom page.
  // fetchAllStateroomsOnPage selects ALL category options in the filter, so
  // a single visit yields staterooms for ALL categories via _form_19.
  const firstAvail = rawDomRows.find(r => r.avlResult === "OK")
                  ?? rawDomRows.find(r => r.avlResult === "GTY")
                  ?? rawDomRows[0];

  let cabinDeckMap = new Map();

  if (firstAvail) {
    // The first visible Select button after scroll-reset targets the top row
    const catSelectBtn = page.locator('.slick-row a:has-text("Select")').first();
    if (await catSelectBtn.isVisible().catch(() => false)) {
      console.log(`    Fetching staterooms via cat ${firstAvail.code}...`);
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 25000 }),
        catSelectBtn.click()
      ]);
      await sleep(1000);

      if (page.url().includes('/agent-select-stateroom/')) {
        const staterooms = await fetchAllStateroomsOnPage(page);
        console.log(`    Staterooms from _form_19: ${staterooms.length}`);
        cabinDeckMap = buildCabinDecksFromStateroomList(staterooms);
      }
    }
  }

  // Navigate back to voyage list
  await goBackToVoyageList(page);

  // Build category list from DOM rows
  const categories = rawDomRows.map(normalizeCategoryItemFromDOM).filter(Boolean);

  // Safety net: categories present in stateroom data but not found in DOM
  // (virtual rendering may have missed some). Add them with code-only data.
  const domCodes = new Set(categories.map(c => c.code));
  for (const [catCode, deckData] of cabinDeckMap) {
    if (!domCodes.has(catCode)) {
      console.log(`    Safety net category from staterooms: ${catCode}`);
      categories.push({
        code:          catCode,
        name:          catCode,
        status:        "Available",
        avlResult:     "OK",
        totalCabins:   deckData.totalCabins,
        avail:         deckData.totalCabins,
        available:     deckData.totalCabins,
        cabinPrice:    null,
        perPersonPrice: null,
        capacity:      null,
        confidence:    "Medium",
        promos:        [],
        cabins:        deckData.decks.flatMap(deck =>
          deck.staterooms.map(sr => ({
            cabinNumber: sr,
            deckNumber:  deck.number,
            deckName:    deck.name,
            capacity:    null,
            status:      null
          }))
        ),
        decks: deckData.decks
      });
    }
  }

  // Merge deck/stateroom data into DOM-derived categories
  for (const cat of categories) {
    if (cat.decks?.length > 0) continue; // already set by safety net
    const deckData = cabinDeckMap.get(cat.code);
    if (deckData) {
      // deckData.totalCabins is "staterooms the _form_19 call listed", not the
      // category's real inventory — when that list comes back partial it lands
      // BELOW the DOM-reported avail, producing impossible available>totalCabins
      // rows (40 seawebagents + 2 firstmates in the DB). Only claim it as the
      // total when it's at least as large as avail; otherwise leave it unknown.
      cat.totalCabins = (cat.avail == null || deckData.totalCabins >= cat.avail)
        ? deckData.totalCabins
        : null;
      cat.decks       = deckData.decks;
      cat.cabins = deckData.decks.flatMap(deck =>
        deck.staterooms.map(sr => ({
          cabinNumber: sr,
          deckNumber:  deck.number,
          deckName:    deck.name,
          capacity:    null,
          status:      null
        }))
      );
    }
  }

  return { categories, cabinDeckMap };
}

// ── Process one chunk end-to-end ──────────────────────────────────────────────

const fmtMMDDYYYY = (d) => d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

function getDateChunks(startDate, endDate, chunkDays = 15) {
  const chunks = [];
  let current  = new Date(startDate);
  const end    = new Date(endDate);
  while (current < end) {
    const chunkEnd = new Date(current);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ from: fmtMMDDYYYY(current), to: fmtMMDDYYYY(chunkEnd) });
    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }
  return chunks;
}

// Build synthetic cabin categories from lead-in prices (list-only mode).
// These give enough data to display prices in search results until the user
// clicks "Get Full Details" to fetch real category/cabin/deck data.
function buildLeadInCategories(row) {
  const priceMap = [
    { code: "SH", name: "Haven Suite", price: row.priceHavenSuite },
    { code: "SU", name: "Suite",       price: row.priceSuite      },
    { code: "BL", name: "Balcony",     price: row.priceBalcony    },
    { code: "OC", name: "Outside",     price: row.priceOutside    },
    { code: "IC", name: "Inside",      price: row.priceInside     },
  ];
  return priceMap
    .filter(({ price }) => price != null && price > 0)
    .map(({ code, name, price }) => ({
      code,
      name,
      status:        "Available",
      avlResult:     "OK",
      totalCabins:   null,
      avail:         null,
      available:     null,
      cabinPrice:    price,
      perPersonPrice: price,
      capacity:      null,
      confidence:    "Low",  // marks as summary-only — full details needed
      promos:        [],
      cabins:        [],
      decks:         []
    }));
}

async function processChunk(page, fromDate, toDate, chunkIndex, seenIds, listOnly = false, maxVoyages = null, shipName = null) {
  // Step 1: navigate to search and get voyage list
  const voyageRows = await fetchVoyageChunk(page, fromDate, toDate, chunkIndex);
  if (voyageRows.length === 0) return [];

  // Dedupe within chunk
  let rows = voyageRows.filter(row => {
    const key = row.packageId ?? row.PackageID ?? `${row.shipCode ?? row.ship}:${row.date ?? row.dateFrom}`;
    if (!key || seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });

  if (shipName) {
    const shipFilter = shipName.trim().toUpperCase();
    const before = rows.length;
    rows = rows.filter(row => (row.ship ?? row.shipCode ?? "").toUpperCase().includes(shipFilter));
    console.log(`  shipName="${shipName}" — ${rows.length}/${before} voyages match`);
  }

  if (maxVoyages != null) rows = rows.slice(0, maxVoyages);

  // ── List-only mode: skip the category/stateroom wizard ────────────────────
  if (listOnly) {
    console.log(`  List-only: ${rows.length} voyages (using lead-in prices, no category fetch)`);
    return rows.map(row => ({
      ...row,
      cabinCategories: buildLeadInCategories(row)
    }));
  }

  // ── Full mode: fetch categories + staterooms per voyage ───────────────────
  console.log(`  Processing ${rows.length} unique voyages (categories + staterooms)...`);
  const processed = [];

  for (let i = 0; i < rows.length; i++) {
    const row       = rows[i];
    const packageId = row.packageId ?? row.PackageID ?? null;
    if (!packageId) continue;

    console.log(`\n  [${i + 1}/${rows.length}] packageId=${packageId}`);

    try {
      if (i > 0) {
        // Dates entered ONCE at chunk start. After wizard, use the Voyage
        // breadcrumb tab (href-based) to return to voyage list — no date re-entry.
        await goBackToVoyageList(page);
      }

      console.log(`    Stage 2+3: categories + staterooms...`);
      const { categories: cabinCategories } = await fetchCategoriesViaSelect(page, packageId);

      await jitter(1500, 2500);

      processed.push({ ...row, cabinCategories });
    } catch (err) {
      console.error(`    [${packageId}] FAILED: ${err.message}`);
      processed.push({ ...row, cabinCategories: [] });
    }
  }

  return processed;
}

// ── Normalize for ingestion ───────────────────────────────────────────────────

function normalizeSeawebagentsCruise(row) {
  const packageId = row.packageId ?? row.PackageID ?? null;
  if (!packageId) return null;

  const nights    = normalizeInteger(row.nights ?? row.Nights);
  const startDate = row.dateFrom
    ? new Date(row.dateFrom).toISOString()
    : parseMDY(row.date ?? row.DateFrom);
  const endDate   = row.dateTo
    ? new Date(row.dateTo).toISOString()
    : addDays(startDate, nights);

  const itinerary       = row.itinerary ?? row.PackageName ?? null;
  const cabinCategories = (row.cabinCategories ?? []).filter(Boolean);

  const { portFrom, portTo, routeLabel } = parseItineraryPorts(itinerary);

  return {
    id:             `seawebagents:${packageId}`,
    ship:           row.shipName ?? row.ship ?? row.ShipName ?? null,
    shipCode:       row.shipCode ?? row.ShipCode ?? null,
    package:        itinerary,
    routeLabel,
    portFrom,
    portTo,
    nights,
    startDate,
    endDate,
    trend:          null,
    confidence:     cabinCategories.length > 0 ? "Medium" : "Low",
    pinned:         false,
    currency:       "GBP",
    promotions:     [],
    itineraryStops: [],
    cabinCategories,
    deckCoverage:   cabinCategories.some(c => c.decks?.length > 0)
  };
}

// ── On-demand single voyage fetch ─────────────────────────────────────────────
// Fetches live cabin categories + staterooms for ONE packageId without running
// the full scrape. fromDate/toDate should bracket the voyage's departure date.

export async function fetchSeawebVoyageByPackageId(packageId, { fromDate, toDate, shipCode = null }) {
  const session = await createScraperSession({
    userDataDir:      "./sessions/seawebagents-user-data",
    storageStatePath: "./sessions/.auth/seawebagents-storage.json",
    headless:         false,
    slowMo:           0,
  });

  const { page } = session;

  try {
    await ensureAuthentication(session);
    await reloadVoyageListForSingleCruise(page, fromDate, toDate, shipCode);
    const { categories, cabinDeckMap } = await fetchCategoriesViaSelect(page, packageId);
    return { packageId, categories, cabinDeckMap: Object.fromEntries(cabinDeckMap) };
  } finally {
    await session.close();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runSeawebagentsScraper(options = {}) {
  const {
    horizonDays = 15,
    chunkDays   = 15,
    maxChunks   = null,   // null = process all chunks derived from horizonDays
    maxVoyages  = null,   // null = all; set e.g. 2 for a quick test run
    listOnly    = true,   // false = full category+stateroom wizard per voyage
    startDate   = null,   // YYYY-MM-DD; null = today
    shipName    = null,   // optional, e.g. "BREAKAWAY" — narrows the full-mode wizard pass to matching voyages only
  } = options;

  // Build date range. startDate from UI is YYYY-MM-DD; convert to MM/DD/YYYY for NCL.
  const start = startDate ? (() => { const [y, m, d] = startDate.split("-"); return new Date(Number(y), Number(m) - 1, Number(d)); })() : new Date();
  const end   = new Date(start);
  end.setDate(end.getDate() + horizonDays);
  const fromDate = fmtMMDDYYYY(start);
  const toDate   = fmtMMDDYYYY(end);

  const session = await createScraperSession({
    userDataDir:      "./sessions/seawebagents-user-data",
    storageStatePath: "./sessions/.auth/seawebagents-storage.json",
    headless:         false,
    slowMo:           0
  });

  const { page } = session;

  try {
    const authResult = await ensureAuthentication(session);
    const chunks     = getDateChunks(fromDate, toDate, chunkDays);
    const allChunks  = maxChunks != null ? chunks.slice(0, maxChunks) : chunks;
    const seenIds    = new Set();
    const allVoyages = [];

    console.log(`\n[seawebagents] ${listOnly ? "List-only" : "Full"} run: ${fromDate} → ${toDate} (${allChunks.length} chunk(s))`);

    for (let i = 0; i < allChunks.length; i++) {
      try {
        const chunkVoyages = await processChunk(
          page,
          allChunks[i].from, allChunks[i].to,
          i + 1,
          seenIds,
          listOnly,
          maxVoyages,
          shipName
        );
        allVoyages.push(...chunkVoyages);
        console.log(`\n  Chunk ${i + 1} complete: ${chunkVoyages.length} voyages. Total: ${allVoyages.length}`);

        if (i < allChunks.length - 1) {
          await jitter(2000, 3500);
        }
      } catch (err) {
        console.error(`  [Chunk ${i + 1}] FAILED: ${err.message}`);
      }
    }

    const cruises = allVoyages.map(normalizeSeawebagentsCruise).filter(Boolean);
    console.log(`\n✅ Done! ${cruises.length} cruises ready for ingestion (listOnly=${listOnly}).`);

    return {
      vendorKey:      "seawebagents",
      browserMode:    session.mode,
      authentication: authResult,
      totalChunks:    allChunks.length,
      extracted:      allVoyages,
      cruises
    };
  } catch (error) {
    error.message = `Seawebagents scraper failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

export async function authenticateSeawebagents() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/seawebagents-user-data",
    storageStatePath: "./sessions/.auth/seawebagents-storage.json",
    headless:         false,
    slowMo:           0
  });
  try {
    const authResult = await ensureAuthentication(session);
    await session.page.goto("https://seawebagents.ncl.com/tva/search/", { waitUntil: "domcontentloaded" });
    return { vendorKey: "seawebagents", ...authResult };
  } catch (error) {
    error.message = `Seawebagents authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}
