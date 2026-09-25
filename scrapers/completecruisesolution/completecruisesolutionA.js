import fs from "node:fs";
import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";

dotenv.config();

const DEFAULT_ACCOUNT_A = {
  vendorKey:        "completecruisesolutionA",
  user:             process.env.CCS_USER,
  pass:             process.env.CCS_PASS,
  userDataDir:      "./sessions/ccs-user-data",
  storageStatePath: "./sessions/.auth/ccs-storage.json",
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function jitter(min = 1000, max = 2000) { await sleep(min + Math.random() * (max - min)); }

// ── Direct-POST helpers (CICS POLAR) ─────────────────────────────────────────

const POLAR_URL_PO = "https://www.onesourcecruises.com/polaronlinepo/pres";

// Derive the correct POLAR endpoint from the page's current URL so that
// GoHAL (polaronlineha) and CCS (polaronlinepo) each POST to their own branch.
function getPolarUrl(page) {
  try {
    const u = new URL(page.url());
    // Path is like /polaronlineha/pres?... — keep origin + /polaron…/pres
    const parts = u.pathname.split("/");
    // parts = ["", "polaronlineha", "pres"] or similar
    const presIdx = parts.findIndex((p) => p === "pres");
    if (presIdx > 0) return `${u.origin}${parts.slice(0, presIdx + 1).join("/")}`;
  } catch {}
  return POLAR_URL_PO;
}

// Extract all non-radio/checkbox hidden/text input values from raw HTML.
function parseFormFieldsFromHtml(html) {
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const f = {};
  for (const m of clean.matchAll(/<input\b([^>]*?)(?:\s*\/?>)/gi)) {
    const a = m[1];
    const type = (a.match(/\btype\s*=\s*["']([^"']+)["']/i))?.[1]?.toLowerCase() ?? "text";
    if (type === "radio" || type === "checkbox") continue;
    const name  = (a.match(/\bname\s*=\s*["']([^"']+)["']/i))?.[1];
    const value = (a.match(/\bvalue\s*=\s*["']([^"']*?)["']/i))?.[1] ?? "";
    if (name && !(name in f)) f[name] = value;
  }
  return f;
}

function htmlTitle(html) {
  return html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] ?? "";
}

// CCS_DEBUG_DUMP=1 saves the raw HTML of a POLAR page to debug/ so a layout the
// flow doesn't know yet (Princess's ship-zone pages) can be inspected offline.
function dumpPolarPage(tag, html) {
  if (!process.env.CCS_DEBUG_DUMP) return;
  try {
    fs.mkdirSync("debug", { recursive: true });
    const file = `debug/polar-${tag}-${Date.now()}.html`;
    fs.writeFileSync(file, html);
    console.log(`      [debug] dumped ${htmlTitle(html) || "(no title)"} → ${file}`);
  } catch { /* debug aid only */ }
}

// Parse RDLC cabin rows from displayRow() JS calls in script blocks.
// Extract numeric deck from HAL-style cabin numbers (all digits, 4+ chars: "4001" → 4, "11015" → 11)
function extractNumericDeck(cabinNo) {
  if (/^\d{4,}$/.test(cabinNo)) return parseInt(cabinNo.slice(0, cabinNo.length - 3)) || null;
  return null;
}

// Signature: displayRow(cabId, cabCat, cabVal, ...) where cabId = t("CABIN_D103 ") or "WAIT1"
// Also handles HAL-style IDs without "CABIN_" prefix: displayRow(t("4001"), ...)
function parseCabinListFromJs(html) {
  const cabins = [];
  // Match both CABIN_-prefixed and bare numeric/alphanumeric IDs
  const re = /displayRow\s*\(\s*(?:t\s*\(\s*)?["']([^"']+)["']\s*\)?/gi;
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    const cabId = m[1].trim();
    let cabinNo;
    if (cabId.startsWith("CABIN_")) {
      cabinNo = cabId.replace(/^CABIN_/, "").trim();
    } else if (/^\d{4,}$/.test(cabId)) {
      // HAL numeric cabin number without "CABIN_" prefix
      cabinNo = cabId;
    } else {
      continue;
    }
    if (!cabinNo || /^(GUAR|WAIT)/.test(cabinNo) || seen.has(cabinNo)) continue;
    seen.add(cabinNo);
    cabins.push({
      cabinNumber: cabinNo,
      deckName: cabinNo.match(/^([A-Z]+)/)?.[1] ?? null,
      deckNumber: extractNumericDeck(cabinNo),
      location: "",
    });
  }
  return cabins;
}

// RDIA stateroom-selection page renders cabins as real <tr> rows with a
// CABIN_xxx checkbox each, rather than JS displayRow() calls (RDLC's format).
// Mirrors extractStateromsPage's DOM-based parsing, but on the raw HTML text
// returned by the direct POST (no live DOM available there).
function parseCabinListFromRdiaHtml(html) {
  const cabins = [];
  const seen = new Set();
  const rowRe = /<tr[^>]*class=["'][^"']*arial11_13h_333333_boxcontent[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowRe)) {
    const rowHtml = rowMatch[1];
    const cbMatch = rowHtml.match(/<input\b[^>]*type=["']checkbox["'][^>]*>/i);
    if (!cbMatch) continue;
    const nameMatch = cbMatch[0].match(/\bname=["']([^"']+)["']/i);
    const name = nameMatch?.[1] ?? "";
    if (!name.startsWith("CABIN_")) continue;
    const cabinNo = name.replace(/^CABIN_/, "").trim();
    if (!cabinNo || /^(GUAR|WAIT)/.test(cabinNo) || seen.has(cabinNo)) continue;
    seen.add(cabinNo);

    const cellTexts = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    const location = cellTexts[3] ?? "";
    const berths   = cellTexts[4] ?? "";
    cabins.push({
      cabinNumber: cabinNo,
      deckName: cabinNo.match(/^([A-Z]+)/)?.[1] ?? null,
      deckNumber: extractNumericDeck(cabinNo),
      location,
      berths,
    });
  }
  return cabins;
}

// POST to POLAR with a given AID key. Supports both pfKey-style (RDIA etc.)
// and DFH_*-style (RDLV, RDIJ, RDIC) forms.
async function polarHttpPost(page, fields, key, stateToken) {
  const f = { ...fields };
  if (stateToken) f.DFH_STATE_TOKEN = stateToken;
  ["DFH_ENTER","DFH_PF3","DFH_PF6","DFH_PF8","DFH_PF10","DFH_PF11","DFH_PF12","DFH_PF14"].forEach(k => delete f[k]);
  if ("pfKey" in f) f.pfKey = key;
  f[key] = key;
  const body = Object.entries(f).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`).join("&");
  const resp = await page.request.post(getPolarUrl(page), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: body,
  });
  return resp.text();
}

// The RDLC cabin screen holds 9 rows. A category with more cabins fills it and the
// rest sit on the following pages (PF8 = page forward). Reading only the first
// page silently cut every large category at exactly 9 cabins. Keeps paging while a
// page is full and still yields cabins we haven't seen; returns the last page's
// html so the caller's PF12 back-navigation starts from the page POLAR is on.
async function collectRdlcPages(workPage, firstHtml, firstCabins, stateToken) {
  const slots = (firstHtml.match(/displayRow\s*\(\s*t\s*\(\s*["']CABIN_/gi) ?? []).length;
  const cabins = [...firstCabins];
  const seen = new Set(cabins.map((c) => c.cabinNumber));
  let html = firstHtml;
  let pageSize = firstCabins.length;
  for (let page = 2; page <= 40 && slots > 0 && pageSize >= slots; page++) {
    const nextHtml = await polarHttpPost(workPage, parseFormFieldsFromHtml(html), "DFH_PF8", stateToken);
    const nextTitle = htmlTitle(nextHtml);
    if (!(nextTitle.includes("RDLC") || nextTitle.toLowerCase().includes("cabin selection"))) {
      console.log(`      [paging] page ${page}: landed on "${nextTitle}" — stopping (kept ${cabins.length} cabins)`);
      html = nextHtml;
      break;
    }
    const pageCabins = parseCabinListFromJs(nextHtml);
    const fresh = pageCabins.filter((c) => !seen.has(c.cabinNumber));
    if (!fresh.length) break;
    for (const c of fresh) { seen.add(c.cabinNumber); cabins.push(c); }
    console.log(`      [paging] page ${page}: +${fresh.length} cabins (${cabins.length} so far)`);
    html = nextHtml;
    pageSize = pageCabins.length;
  }
  return { cabins, lastHtml: html };
}

// Fetch cabins for one RDIC category via direct HTTP POSTs (no browser navigation).
// Chain: RDIC POST → RDLE → [RDLD notice pages] → [RDIF upsell] → RDLC → PF12 back to RDIC.
async function getCabinsForCategoryDirect(workPage, rdicF, selCatField, selFareField, catCode, stateToken) {
  // SELCAT is always the first 2 chars of the displayRow category argument
  const baseCode = catCode.length >= 3 ? catCode.slice(0, 2) : catCode;
  let catF    = { ...rdicF, [selCatField]: baseCode, [selFareField]: "1" };
  const catHtml = await polarHttpPost(workPage, catF, "DFH_ENTER", stateToken);
  const catTitle = htmlTitle(catHtml);

  // If SELCAT was rejected, CICS returns us to RDIC
  if (catTitle.includes("RDIC") || catTitle.includes("Category Fares")) return [];

  return readCabinListFromSelection(workPage, catHtml, stateToken, ["RDIC", "Category Fares"]);
}

// From the response to a category/row selection: walk forward through POLAR's
// notice / upsell / zone pages to the cabin list, parse it, then PF12 back to
// the page whose title contains one of `backTitles` (RDIC for the normal
// Category Fares layout, RDIN for Princess's zone-and-deck layout).
async function readCabinListFromSelection(workPage, firstHtml, stateToken, backTitles) {
  let catHtml  = firstHtml;
  let catTitle = htmlTitle(catHtml);

  // Navigate forward through notice pages to RDLC (or RDIA stateroom)
  for (let n = 0; n < 8; n++) {
    if (catTitle.includes("RDLC") || catTitle.toLowerCase().includes("cabin selection")) break;
    // Break on stateroom RDIA — but NOT on notice sub-pages ("Important Notices" in title)
    if ((catTitle.includes("RDIA") || catTitle.toLowerCase().includes("stateroom"))
        && !catTitle.includes("Important Notices")) break;
    if (catTitle.includes("RDIC") || catTitle.includes("Category Fares")) break;
    // RDIN = Princess "Availability By Zone And Deck". Re-posting ENTER without a
    // row selected just returns the same page (it used to loop here 8 times).
    if (catTitle.includes("RDIN")) break;
    if (catTitle.includes("CICS Web") || catTitle.includes("MAIN MENU")) break;
    const postF = parseFormFieldsFromHtml(catHtml);
    // RDIA notice page: CICS reads hidden RECAPPFL field (set by setRecap()), not the checkbox
    if (catHtml.includes("RECAPFLAG")) {
      const recapField = Object.values(postF).find(v => typeof v === "string" && v.includes("-RECAP"))
        ?? Object.keys(postF).find(k => k.includes("RECAP"))
        ?? "F410250001_CMRDIA-RECAPPFL";
      postF[recapField] = "Y";
    }
    // Princess-only: RDIM ("Voyage Pricing By Ship Zone") asks which ship zone
    // (Aft / Mid-Aft / Midship / Mid-Forward / Forward) before it'll show cabins
    // — P&O and Cunard never hit this page. Its rows are rendered by
    // displayRow(selPre, selFld, selVal, zoneDesc, zoneStat, zoneRate, zoneFare)
    // JS calls; zoneStat "C" means closed (sold out), "W" waitlist, anything else open.
    // Selecting a zone just means POSTing that zone's hidden field with "S" (the
    // page's own setSelVal() does exactly this), so this stays a direct POST.
    if (catTitle.includes("RDIM")) {
      const zones = parseZoneRows(catHtml);
      const zone = zones.find(z => isBookableStatus(z.status)) ?? zones.find(z => z.status === "W") ?? zones[0];
      if (!zone) {
        console.log(`      [warn] RDIM page had no selectable zones — returning empty cabin list`);
        break;
      }
      console.log(`      [zone] selecting "${zone.desc}" (status ${zone.status || "?"})`);
      postF[zone.field] = "S";
    }
    catHtml  = await polarHttpPost(workPage, postF, "DFH_ENTER", stateToken);
    catTitle = htmlTitle(catHtml);
    if (catTitle.includes("RDIN")) dumpPolarPage("RDIN", catHtml);
  }

  const isWtl  = catHtml.toLowerCase().includes("waitlist only") || catHtml.toLowerCase().includes("available for waitlist");
  const isRdlc = catTitle.includes("RDLC") || catTitle.toLowerCase().includes("cabin selection");
  const isRdia = catTitle.includes("RDIA") || catTitle.toLowerCase().includes("stateroom");
  let cabins = isWtl ? [] : isRdlc ? parseCabinListFromJs(catHtml) : isRdia ? parseCabinListFromRdiaHtml(catHtml) : [];
  if (cabins.length) dumpPolarPage(isRdlc ? "cabinlist-RDLC" : "cabinlist-RDIA", catHtml);
  // POLAR answered "RDLC-0126I CATEGORY AVAILABLE FOR WAITLIST ONLY": no cabin numbers exist to list.
  // Flag the (empty) result so the caller stores the category as Waitlist, not Available.
  if (isWtl) cabins.waitlistOnly = true;
  if (!cabins.length) dumpPolarPage(`empty-${isWtl ? "WTL" : isRdlc ? "RDLC" : isRdia ? "RDIA" : "other"}`, catHtml);
  if (isRdlc && !isWtl && cabins.length) {
    const paged = await collectRdlcPages(workPage, catHtml, cabins, stateToken);
    cabins  = paged.cabins;
    catHtml = paged.lastHtml;
  }
  if (!isWtl && !isRdlc && !isRdia) {
    console.log(`      [warn] unrecognized cabin page title "${catTitle}" — returning empty cabin list`);
  }

  // PF12 back to the selection page we started from
  let bkHtml = catHtml, bkTitle = catTitle;
  for (let b = 0; b < 8; b++) {
    if (backTitles.some((t) => bkTitle.includes(t))) break;
    if (bkTitle.includes("MAIN MENU") || bkTitle.includes("CICS Web")) break;
    bkHtml  = await polarHttpPost(workPage, parseFormFieldsFromHtml(bkHtml), "DFH_PF12", stateToken);
    bkTitle = htmlTitle(bkHtml);
  }

  return cabins;
}

// ── Princess ship-zone layout (RDIM → RDIN) ───────────────────────────────────
// Some Princess voyages skip Category Fares: after the packages page POLAR shows
// RDIM "Voyage Pricing By Ship Zone" (Aft / Mid-Aft / Midship / Mid-Forward /
// Forward) and picking a zone opens RDIN "Availability By Zone And Deck" — one
// row per deck + category with its status (C confirmed / W waitlist), FIT price
// and promo. Picking a row leads on through the usual notice pages to the cabin
// list. extractFareTable used to read the zone rows as if they were cabin
// categories (junk codes like "F090010001_DFH0001", 0 cabins), and the
// stateroom POSTs that followed made CICS error out and poisoned the session.

const isAvailabilityByDate = (title) => title.includes("RDLV") || title.includes("Availability by Date");

function parsePolarPrice(text) {
  const n = parseFloat(String(text ?? "").replace(/[,*\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// The quoted arguments of every displayRow(...) call in a POLAR page's script.
function parseDisplayRowCalls(html) {
  const callRe = /displayRow\(((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^'")])*)\)/g;
  const strRe  = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  const calls = [];
  for (const m of html.matchAll(callRe)) {
    const args = [...m[1].matchAll(strRe)].map((a) => a[1] ?? a[2] ?? "");
    if (args.length) calls.push(args);
  }
  return calls;
}

// RDIM: displayRow(selPre, selFld, selVal, zoneDesc, zoneStat, zoneRate, zoneFare)
function parseZoneRows(html) {
  return parseDisplayRowCalls(html)
    .filter((a) => a.length >= 7 && a[3].trim())
    .map((a) => ({ field: a[1], desc: a[3].trim(), status: a[4].trim(), price: parsePolarPrice(a[5]) }));
}

// RDIN: displayRow(selPre, selVal, selFld, deckNbr, deckDesc, metaDesc, metaPreSuf,
//                  categ, categPreSuf, cat1Avl, cat1Amt, cat1Promo, cat2Avl, cat2Amt, cat2Promo, otherZone)
// cat1 is the FIT column, cat2 the GROUP column — only FIT is used.
function parseZoneDeckRows(html) {
  return parseDisplayRowCalls(html)
    .filter((a) => a.length >= 16 && a[7].trim())
    .map((a) => ({
      field:      a[2],
      selectable: a[0].includes('type="text"'),
      deckNumber: parseInt(a[3], 10) || null,
      deckName:   a[4].trim(),
      type:       a[5].trim(),
      code:       a[7].trim(),
      status:     a[9].trim(),
      price:      parsePolarPrice(a[10]),
      promo:      a[11].trim(),
    }));
}

const ZONE_TYPE_TO_GROUP = {
  "suite": "Suite", "suites": "Suite", "mini-suite": "Mini-Suite", "balcony": "Balcony",
  "oceanview": "Exterior", "outside": "Exterior", "obstructed": "Exterior", "interior": "Interior", "inside": "Interior",
};

// Values of the controls POLAR builds with JavaScript (stateroom type, ship zone,
// berths, air status...). They are not in the raw HTML as <input>/<select>, but
// the browser submits them, and leaving them out makes POLAR read the POST as a
// filter change and redisplay the same page instead of accepting a selection.
// The second argument of each populate…Dropdown(name, selectedValue, …) call is
// the current value.
function parseJsBuiltFields(html) {
  const f = {};
  const re = /populate(?:Air)?Dropdown(?:ByBrand)?\(\s*["'](F\d{9}_[A-Z0-9-]+)["']\s*,\s*["']([^"']*)["']/g;
  for (const m of html.matchAll(re)) f[m[1]] = m[2];
  return f;
}

// Status codes on RDIM/RDIN, as POLAR reports them: C = closed (sold out — picking
// it answers "RDIN-0144E NO SPACE AVAILABLE - CATEGORY IS SOLD OUT"), W = waitlist,
// N = none; anything else on a selectable row is an open seat count.
const isBookableStatus = (st) => st !== "" && !["C", "W", "N"].includes(st.toUpperCase());

const ZONE_TYPES = [["S", "Suite"], ["M", "Mini-Suite"], ["B", "Balcony"], ["O", "Oceanview"], ["I", "Interior"]];

// POLAR filters both RDIM and RDIN by stateroom type (default Mini-Suite), so
// the complete category list needs a walk of type × zone × deck row.
// Categories are the unique category codes seen (one code can recur on several
// decks/zones); a category's cabins are the union of every confirmed deck row's
// stateroom list, stamped with that row's deck and zone.
// Leaves POLAR on RDIM, the page the browser is still showing.
async function getPricingByShipZone(workPage, rdimHtml, stateToken, maxCategories = Infinity) {
  const rdimJs    = parseJsBuiltFields(rdimHtml);
  const typeField = Object.keys(rdimJs).find((k) => k.endsWith("-STROOMTYP")) ?? null;
  const rdimF     = { ...rdimJs, ...parseFormFieldsFromHtml(rdimHtml) };
  const types     = typeField ? ZONE_TYPES : [[null, "all"]];
  const cats = new Map();
  let serverType = typeField ? rdimJs[typeField] : null;

  typeLoop:
  for (const [typeCode, typeLabel] of types) {
    const typeF = typeField ? { ...rdimF, [typeField]: typeCode } : rdimF;

    // RDIM for this type (the page we arrived on already is the default type's)
    let zonesHtml = rdimHtml;
    if (typeField && typeCode !== serverType) {
      zonesHtml = await polarHttpPost(workPage, typeF, "DFH_ENTER", stateToken);
      if (!htmlTitle(zonesHtml).includes("RDIM")) {
        console.warn(`      [zone] ${typeLabel}: expected RDIM, got "${htmlTitle(zonesHtml)}" — stopping the zone walk`);
        break;
      }
      serverType = typeCode;
    }
    const allZones = parseZoneRows(zonesHtml);
    const zones = allZones.filter((z) => z.status && !["C", "N"].includes(z.status.toUpperCase()));
    console.log(`    [zone] ${typeLabel}: ${zones.length} ship zone(s): ${zones.map((z) => `${z.desc}=${z.status}`).join(", ")}`);
    // POLAR remembers the last zone picked, so a second pick without clearing the
    // others answers RDIM-0124I TOO MANY SELECTIONS — blank every zone field first
    const clearZones = Object.fromEntries(allZones.map((z) => [z.field, ""]));

    for (const zone of zones) {
      let html = await polarHttpPost(workPage, { ...typeF, ...clearZones, [zone.field]: "S" }, "DFH_ENTER", stateToken);
      const zoneTitle = htmlTitle(html);
      if (zoneTitle.includes("RDIM")) {
        // still on the zone page (POLAR redisplayed it, usually with a message) — the state is intact, try the next zone
        const why = html.match(/RDIM-\d+[A-Z][^<"]{0,120}/)?.[0]?.replace(/\s+/g, " ").trim() ?? "no message";
        console.log(`      [zone] ${typeLabel}/${zone.desc}: not opened (${why})`);
        dumpPolarPage(`RDIM-notopened-${typeCode}-${zone.desc}`, html);
        continue;
      }
      if (!zoneTitle.includes("RDIN")) {
        console.warn(`      [zone] ${typeLabel}/${zone.desc}: expected RDIN, got "${zoneTitle}" — stopping the zone walk`);
        break typeLoop;
      }
      dumpPolarPage(`RDIN-${typeCode}-${zone.desc}`, html);
      const rdinF = { ...parseJsBuiltFields(html), ...parseFormFieldsFromHtml(html) };
      const selFareField = Object.keys(rdinF).find((k) => k.endsWith("-SELFARE")) ?? "F400150001_CMRDIN-SELFARE";
      const rows = parseZoneDeckRows(html);
      console.log(`      [zone] ${typeLabel}/${zone.desc}: ${rows.length} deck/category row(s), ${rows.filter((r) => isBookableStatus(r.status)).length} bookable`);

      for (const row of rows) {
        const bookable = isBookableStatus(row.status);
        let cat = cats.get(row.code);
        if (!cat) {
          if (cats.size >= maxCategories) continue;
          const capMatch = row.code.match(/(\d+)$/);
          cat = {
            code: row.code, name: `${row.code} ${row.type}`,
            group: ZONE_TYPE_TO_GROUP[row.type.toLowerCase()] ?? "Other",
            capacity: capMatch ? parseInt(capMatch[1], 10) : null,
            status: bookable ? "Available" : row.status.toUpperCase() === "W" ? "Waitlist" : "Closed", avlResult: bookable ? "OK" : "SLD", avail: 0,
            cabinPrice: row.price, perPersonPrice: row.price,
            promos: row.promo ? [row.promo] : [], cabins: [],
          };
          cats.set(row.code, cat);
        } else {
          if (bookable && cat.avlResult !== "OK") { cat.status = "Available"; cat.avlResult = "OK"; }
          if (row.price != null && (cat.cabinPrice == null || row.price < cat.cabinPrice)) {
            cat.cabinPrice = row.price; cat.perPersonPrice = row.price;
          }
          if (row.promo && !cat.promos.includes(row.promo)) cat.promos.push(row.promo);
        }
        if (!bookable || !row.selectable) continue;

        console.log(`    [stateroom] ${row.code} ${row.type} · deck ${row.deckNumber ?? "?"} ${row.deckName} · ${zone.desc}`);
        const clearRows = Object.fromEntries(rows.map((r) => [r.field, ""]));
        const firstHtml = await polarHttpPost(workPage, { ...rdinF, ...clearRows, [row.field]: "S", [selFareField]: "1" }, "DFH_ENTER", stateToken);
        const firstTitle = htmlTitle(firstHtml);
        if (firstTitle.includes("RDIN")) {
          const why = firstHtml.match(/RDIN-\d+[A-Z][^<"]{0,120}/)?.[0]?.replace(/\s+/g, " ").trim() ?? "no message";
          console.log(`      → selection not accepted: ${why}`);
          dumpPolarPage(`RDIN-rejected-${row.code}`, firstHtml);
          continue;
        }
        if (firstTitle.includes("CICS Web")) { console.warn("      [zone] CICS error — stopping the zone walk"); break typeLoop; }
        const cabins = await readCabinListFromSelection(workPage, firstHtml, stateToken, ["RDIN"]);
        console.log(`      → ${cabins.length} cabins (direct POST)`);
        for (const cb of cabins) {
          if (cat.cabins.some((c) => c.cabinNumber === cb.cabinNumber)) continue;
          cat.cabins.push({ ...cb, deckName: row.deckName || cb.deckName, deckNumber: row.deckNumber ?? cb.deckNumber, location: cb.location || zone.desc });
        }
      }

      // back to RDIM for the next zone
      html = await polarHttpPost(workPage, rdinF, "DFH_PF12", stateToken);
      if (!htmlTitle(html).includes("RDIM")) {
        console.warn(`      [zone] PF12 from RDIN landed on "${htmlTitle(html)}" — stopping the zone walk`);
        break typeLoop;
      }
    }
  }

  const pricing = [...cats.values()];
  for (const c of pricing) c.avail = c.cabins.length;
  return pricing;
}

// Port code → human name (add more as encountered)
const PORT_NAMES = {
  SOU: "Southampton", BGI: "Bridgetown", ANU: "Antigua",
  SKB: "St Kitts", GIB: "Gibraltar", LIS: "Lisbon",
  BCN: "Barcelona", CIV: "Civitavecchia", ATH: "Athens",
  NYC: "New York", MIA: "Miami", FLL: "Fort Lauderdale",
  BAR: "Barbados", TRI: "Trinidad", JAM: "Jamaica",
  SIN: "Singapore", SYD: "Sydney", DXB: "Dubai",
};

// Ship name → POLAR code
const SHIP_CODES = {
  AURORA: "AU", ARVIA: "AR", VENTURA: "VE", IONA: "IA",
  BRITANNIA: "BR", ARCADIA: "AC", AZURA: "AZ",
};

// POLAR category type → group used in schema
const TYPE_TO_GROUP = {
  "suites":     "Suite",
  "suite":      "Suite",
  "mini-suite": "Mini-Suite",
  "balcony":    "Balcony",
  "outside":    "Exterior",
  "obstructed": "Exterior",
  "inside":     "Interior",
};

function parsePort(code) {
  return PORT_NAMES[code?.toUpperCase()] ?? code ?? null;
}

function parseDate(ddmmmyy) {
  // e.g. "29DEC27" → Date
  if (!ddmmmyy || ddmmmyy.length < 7) return null;
  const day   = parseInt(ddmmmyy.slice(0, 2));
  const mon   = ddmmmyy.slice(2, 5);
  const year  = 2000 + parseInt(ddmmmyy.slice(5));
  const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
  const m = months[mon.toUpperCase()];
  if (m === undefined || isNaN(day) || isNaN(year)) return null;
  return new Date(year, m, day);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// The portal sometimes answers the SSO relay with its ASP.NET error page
// (…/error.aspx?aspxerrorpath=/Login.aspx) — seen when two logins for the same
// account overlap, or just intermittently (scheduled run #502, 2026-09-25). A
// second try a little later works, so retry instead of failing the whole run.
export async function ensureAuthentication(session, credentials) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptCcsLogin(session, credentials);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || !/CCS login failed/.test(err.message)) break;
      const waitMs = 20000 * attempt;
      console.log(`[ccs-auth] login attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message.split("\n")[0].slice(0, 140)}) — retrying in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function attemptCcsLogin(session, { user, pass }) {
  const { page } = session;
  await page.goto("https://www.completecruisesolution.com/Login.aspx", { waitUntil: "networkidle", timeout: 40000 });
  await page.waitForFunction(
    (n) => (document.body?.innerText?.trim().length ?? 0) > n, 50, { timeout: 20000 }
  ).catch(() => {});
  await sleep(1500);

  // Close modal if already logged in and redirected to default.aspx
  await page.locator('#myModal .close, .modal-content span.close').first().click().catch(() => {});
  await sleep(600);

  const hasLogin = await page.locator('input[name="txtusername"]').first().isVisible().catch(() => false);
  if (!hasLogin) {
    console.log("✅ CCS session reused.");
    return { success: true, alreadyLoggedIn: true };
  }

  await page.fill('input[name="txtusername"]', user);
  await sleep(200);
  await page.fill('input[name="txtPassword"]', pass);
  await sleep(200);
  console.log(`[ccs-auth] clicking BtnLogin on ${page.url()}`);
  await page.click('#BtnLogin');

  // CCS uses SSO via onesourcecruises.com — the flow is:
  //   completecruisesolution.com/Login.aspx → onesourcecruises.com/onesource/login → back to CCS
  // Wait for the SSO relay to complete and land back on completecruisesolution.com
  const isErrorPage = (u) => /\/error\.aspx$/i.test(u.pathname);
  await page.waitForURL(
    url => url.toString().includes('completecruisesolution.com') && (isErrorPage(url) || !/\/login\.aspx$/i.test(url.pathname)),
    { timeout: 120000 }
  ).catch(async () => {
    console.log(`[ccs-auth] waitForURL timed out, current url="${page.url()}"`);
    // Log page text to see if SSO shows error or extra step
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim().slice(0, 500)).catch(() => '');
    console.log(`[ccs-auth] page content: ${bodyText}`);
  });
  console.log(`[ccs-auth] after SSO redirect url="${page.url()}"`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);

  // Must be on CCS domain (not Login page, not still on onesource SSO relay)
  const finalUrl = page.url();
  const finalPath = new URL(finalUrl).pathname;
  const onCCS = finalUrl.includes('completecruisesolution.com') && !/\/(login|error)\.aspx$/i.test(finalPath);
  if (!onCCS) {
    const errText = await page.locator('#lblError, .error, .alert-danger, #ctl00_MainContent_lblError').first().innerText().catch(() => null);
    throw new Error(`CCS login failed — still on "${finalUrl}" after SSO. Error: ${errText ?? '(none)'}`);
  }

  await page.locator('#myModal .close, .modal-content span.close').first().click().catch(() => {});
  await sleep(600);

  await session.persistAuthState().catch(() => {});
  console.log(`✅ CCS logged in. url="${page.url()}"`);
  return { success: true, alreadyLoggedIn: false };
}

// ── Navigate to POLAR search form ─────────────────────────────────────────────

// POLAR's "Select a Cruise Line" page (title contains MXTO) serves three
// Carnival Corp brands through the same backend: P&O Cruises (default),
// Cunard Line, Princess Cruises. Pass brand to fetch from a different one.
const CRUISE_LINE_LABELS = {
  PO:       "P&O Cruises",
  CUNARD:   "Cunard Line",
  PRINCESS: "Princess Cruises",
};

async function selectCruiseLineIfNeeded(workPage, brand) {
  if (!brand) return;
  const label = CRUISE_LINE_LABELS[brand] ?? brand;
  const dropdown = workPage.locator("select").filter({ hasText: /Cunard Line|Princess Cruises|P&O Cruises/ }).first();
  const hasDropdown = await dropdown.count() > 0;
  if (!hasDropdown) {
    console.log(`[polar-nav] brand=${brand} requested but no cruise-line dropdown found on this page`);
    return;
  }
  const current = await dropdown.inputValue().catch(() => null);
  console.log(`[polar-nav] cruise-line dropdown current="${current}", selecting "${label}"`);
  await dropdown.selectOption({ label }).catch(async (err) => {
    console.log(`[polar-nav] selectOption by label failed (${err.message}), trying value="${brand}"`);
    await dropdown.selectOption(brand).catch(() => {});
  });
  await workPage.waitForTimeout(500);
}

export async function navigateToPolarBooking(page, { brand = null } = {}) {
  // Navigate to BookModifyOnline.aspx (via link or direct)
  const bookLink = page.locator('a[href="BookModifyOnline.aspx"], a[href*="BookModifyOnline"]').first();
  if (await bookLink.isVisible().catch(() => false)) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
      bookLink.click()
    ]);
  } else {
    await page.goto("https://www.completecruisesolution.com/BookModifyOnline.aspx", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForFunction(
      (n) => (document.body?.innerText?.trim().length ?? 0) > n, 100, { timeout: 15000 }
    ).catch(() => {});
  }
  await sleep(1200);
  await page.locator('#myModal .close, .modal-content span.close').first().click().catch(() => {});
  await sleep(600);

  // Debug: log page state before clicking POLAR button
  console.log(`[ccs] pre-POLAR url="${page.url()}" title="${await page.title().catch(() => '?')}"`);
  const polarBtnVisible = await page.locator('#btnPolarOnline').isVisible().catch(() => false);
  console.log(`[ccs] #btnPolarOnline visible=${polarBtnVisible}`);
  if (!polarBtnVisible) {
    // Log all links on page to help diagnose
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[id], button[id]')].map(el => `${el.tagName}#${el.id}`).slice(0, 20)
    ).catch(() => []);
    console.log(`[ccs] page interactive elements:`, links.join(', ') || '(none)');
  }

  // Open POLAR Online — may open new tab
  const popupPromise = page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null);
  await page.locator('#btnPolarOnline').click();
  const popup = await popupPromise;

  const workPage = popup ?? page;
  if (popup) await popup.waitForLoadState("networkidle").catch(() => {});

  await workPage.waitForURL(url => url.toString().includes('/polaronlinepo/pres'), { timeout: 35000 }).catch(() => {});
  await workPage.waitForLoadState("networkidle").catch(() => {});
  await sleep(2000);

  // Navigate to RDLT (Sailing Search) — handle whatever state POLAR opens in
  for (let i = 0; i < 8; i++) {
    const onSearch = await workPage.locator('input[name="AIRCITY_1"]').isVisible({ timeout: 2000 }).catch(() => false);
    if (onSearch) break;

    const title = await workPage.title().catch(() => '');
    console.log(`[polar-nav] step ${i}: "${title}"`);

    // CICS error / abend — can't recover
    if (title.includes('Abend') || title.includes('CICS Web Error')) {
      console.warn('[polar-nav] CICS error — cannot recover');
      break;
    }

    // POLAR MAIN MENU (MXTO) or OneSource home page — click CREATE BOOKING button
    if (title.includes('MAIN MENU') || title.includes('MXTO') ||
        title.includes('OneSource') || title.includes('Travel Advisor Centre')) {
      const btns = await workPage.evaluate(() =>
        [...document.querySelectorAll('input[type="button"], input[type="submit"], a, button')]
          .map(el => `${el.tagName}[${el.value || el.innerText?.trim()}]`).slice(0, 20)
      ).catch(() => []);
      console.log('[polar-nav] MAIN MENU elements:', btns.join(', '));
      // If POLAR's SSO relay dropped us on the logged-OUT OneSource marketing
      // page (happens after a CICS error kills the OneSource session), click
      // its Sign In button to re-trigger the SSO before anything else.
      const signInBtn = workPage.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
      if (await signInBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log('[polar-nav] OneSource logged out — clicking Sign In to re-SSO');
        await Promise.allSettled([
          workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
          signInBtn.click({ force: true })
        ]);
        await sleep(3000);
        continue;
      }

      await selectCruiseLineIfNeeded(workPage, brand);

      // Dismiss any cookie-consent overlay that might be covering the button
      // (re-appears sometimes after the brand dropdown's AJAX refresh).
      await workPage.locator('button:has-text("Allow All"), button:has-text("Confirm My Choices")').first()
        .click({ timeout: 1500 }).catch(() => {});
      await sleep(500);

      const createBookingLink = workPage.locator('a:has-text("CREATE BOOKING"), a:has-text("Create Booking")').first();
      const visible = await createBookingLink.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`[polar-nav] CREATE BOOKING visible=${visible}`);
      if (visible) {
        await Promise.allSettled([
          workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
          createBookingLink.click({ force: true })
        ]);
        console.log('[polar-nav] clicked CREATE BOOKING');
      } else {
        console.log('[polar-nav] CREATE BOOKING not clickable — retrying loop');
      }
      await workPage.waitForLoadState('networkidle').catch(() => {});
      await sleep(2000);
      continue;
    }

    // RDLP (Booking Agency) — press DFH_ENTER to advance to Sailing Search
    const isRDLP = title.includes('RDLP') || title.includes('Booking Agency') ||
                   await workPage.locator('input[name="AGTCDE_1"], select[name="AGTCDE_1"]').isVisible({ timeout: 500 }).catch(() => false);
    if (isRDLP) {
      console.log('[polar-nav] on RDLP — pressing DFH_ENTER');
      await workPage.evaluate(() => {
        const form = document.querySelector('form');
        if (form && typeof doSimpleSubmit === 'function') doSimpleSubmit(form, 'DFH_ENTER');
      }).catch(() => {});
      await workPage.waitForLoadState('networkidle').catch(() => {});
      await sleep(1200);
      continue;
    }

    // Save & Continue links (mid-booking variant)
    const saveBtn = workPage.locator('a:has-text("Save and Continue"), a:has-text("Save & Continue"), input[value*="Save"]').first();
    if (await saveBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await Promise.allSettled([workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }), saveBtn.click()]);
      await sleep(1200);
      continue;
    }

    // Any other POLAR page — press PF12 to back out
    console.log(`[polar-nav] unknown page "${title}" — pressing PF12`);
    await workPage.evaluate(() => {
      const form = document.querySelector('form');
      if (form && typeof doSimpleSubmit === 'function') doSimpleSubmit(form, 'DFH_PF12');
    }).catch(() => {});
    await workPage.waitForLoadState('networkidle').catch(() => {});
    await sleep(800);
  }

  const finalTitle = await workPage.title().catch(() => '');
  console.log(`[polar-nav] ready on: "${finalTitle}"`);
  return workPage;
}

// ── Fill search form and submit ───────────────────────────────────────────────

async function searchByDate(workPage, { homeCity, sailDate, stateroomType, occupancy, destination, ship }) {
  await workPage.fill('input[name="AIRCITY_1"]',  homeCity);
  await sleep(120);
  await workPage.fill('input[name="SAILDATE_1"]', sailDate);
  await sleep(120);
  if (ship)          await workPage.selectOption('select[name="SHIPLAND_1"]', ship).catch(() => {});
  if (stateroomType) await workPage.selectOption('select[name="CATGTYP_1"]',  stateroomType).catch(() => {});
  if (occupancy)     await workPage.selectOption('select[name="BERTHS_1"]',   String(occupancy)).catch(() => {});
  if (destination)   await workPage.selectOption('select[name="TRADE_1"]',    destination).catch(() => {});
  await workPage.selectOption('select[name="AIRFLAG_1"]', "N").catch(() => {});
  await sleep(100);

  // Dismiss OneTrust cookie consent banner if it's covering the page (fresh sessions)
  const cookieBtn = workPage.locator('#onetrust-accept-btn-handler, button:has-text("Accept All"), button:has-text("Agree")').first();
  if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await cookieBtn.click().catch(() => {});
    await sleep(800);
  }

  const searchLink = workPage.locator('a[href*="submitSearchByDate"], a:has-text("Search By Date")').first();
  if (!await searchLink.isVisible().catch(() => false)) throw new Error("Search By Date button not found");

  const titleBefore = await workPage.title();
  await searchLink.click();
  // POLAR POSTs to same URL — waitForNavigation is unreliable; poll title instead
  await workPage.waitForFunction(
    t => document.title !== t, titleBefore, { timeout: 35000 }
  ).catch(() => {});
  await workPage.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);
}

// ── Extract voyage list from availability page (no navigation) ────────────────

async function extractVoyageList(workPage) {
  return workPage.evaluate(() => {
    function rowCells(id) {
      const row = document.getElementById(id);
      return row ? [...row.cells] : [];
    }
    const shipCells   = rowCells('shpNameRow');
    const dateCells   = rowCells('depDateRow');
    const nightsCells = rowCells('ngtProdRow');
    const voyNumCells = rowCells('vygeNumRow');
    const routeCells  = rowCells('routeRow');
    if (!shipCells.length) return [];

    // Radio buttons in vygeSelRow — collect them all in order
    const selRow = document.getElementById('vygeSelRow');
    const allRadios = selRow ? [...selRow.querySelectorAll('input[type="radio"]')] : [];

    const results = [];
    for (let col = 1; col < shipCells.length; col++) {
      const ship      = shipCells[col]?.innerText?.trim() ?? "";
      const depDate   = dateCells[col]?.innerText?.trim() ?? "";
      const nightsProd = nightsCells[col]?.innerText?.trim() ?? "";
      const voyageNum = voyNumCells[col]?.innerText?.trim() ?? "";
      const route     = routeCells[col]?.innerText?.trim() ?? "";
      if (!ship || !voyageNum) continue;

      const nightsMatch = nightsProd.match(/^(\d+)\s*(.+)$/s);
      const nights  = nightsMatch ? parseInt(nightsMatch[1]) : null;
      const product = nightsMatch ? nightsMatch[2].replace(/\s+/g, ' ').trim() : nightsProd;

      // Radio index is (col - 1) relative to data columns; also store name/value for fallback
      const radioIdx = col - 1;
      const radioEl  = allRadios[radioIdx] ?? null;

      results.push({
        ship, depDate, nights, product, voyageNum, route,
        radioIdx,
        radioName:  radioEl?.name  ?? null,
        radioValue: radioEl?.value ?? null,
      });
    }
    return results;
  });
}

// ── Navigate to Category Fares for a voyage, extract pricing, return to availability ──

async function getVoyagePricing(workPage, voyage, maxCategories = Infinity) {
  // Verify we're on the availability page before starting
  const startTitle = await workPage.title();
  if (!isAvailabilityByDate(startTitle)) {
    throw new Error(`Expected availability page but got: ${startTitle}`);
  }

  // Click the radio button using Playwright locator (fires proper browser events)
  const radios = workPage.locator('#vygeSelRow input[type="radio"]');
  const radioCount = await radios.count();
  if (radioCount === 0) throw new Error(`No radio buttons found in vygeSelRow for ${voyage.voyageNum}`);
  const radioToClick = voyage.radioIdx < radioCount
    ? radios.nth(voyage.radioIdx)
    : radios.first();
  await radioToClick.click();
  await sleep(600);

  // Dismiss the accessibility acknowledgement popup that appears after selecting a voyage
  const accessPopupOk = workPage.locator('div:has-text("accessibility resources") button:has-text("OK"), div:has(h2:has-text("IMPORTANT")) button:has-text("OK")').first();
  if (await accessPopupOk.isVisible().catch(() => false)) {
    await accessPopupOk.click();
    await sleep(400);
    console.log(`    [popup] accessibility popup dismissed`);
  }

  // SAVE & CONTINUE
  const saveBtn = workPage.locator('#footerSec a:has-text("SAVE"), a:has-text("SAVE & CONTINUE"), a:has-text("Save & Continue")').first();
  await saveBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (!await saveBtn.isVisible().catch(() => false)) {
    throw new Error(`SAVE & CONTINUE not visible after selecting voyage ${voyage.voyageNum}`);
  }
  const titleBeforeSave = await workPage.title();
  await saveBtn.click();
  await workPage.waitForFunction(
    (t) => document.title !== t, titleBeforeSave, { timeout: 20000 }
  ).catch(() => {});
  await workPage.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);

  // Packages page (RDIJ) — SUBMIT triggers checkBeforeSubmit() which shows a custom
  // HTML accessibility popup (customConfirm). Must click OK on that popup to trigger
  // doSimpleSubmit(document.CMRDIJP,'DFH_ENTER') and navigate to Category Fares.
  let curTitle = await workPage.title();
  console.log(`    [pkg] page title: ${curTitle}`);
  if (curTitle.includes('RDIJ') || curTitle.includes('Packages')) {
    const submitBtn = workPage.locator('a:has-text("SUBMIT"), a:has-text("Submit"), input[value="SUBMIT"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const submitVisible = await submitBtn.isVisible().catch(() => false);
    console.log(`    [pkg] SUBMIT visible: ${submitVisible}`);

    if (submitVisible) {
      // Click SUBMIT — checkBeforeSubmit() is async and awaits a custom HTML popup
      await submitBtn.click();

      // Wait for the custom accessibility popup's OK button to appear in the DOM
      await workPage.waitForFunction(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.some(b => b.innerText?.trim() === 'OK' && b.offsetParent !== null);
      }, { timeout: 8000 }).catch(() => {});

      // Click OK on the popup — this resolves customConfirm → doSimpleSubmit → navigation
      const pkgPopupOk = workPage.locator('button').filter({ hasText: /^OK$/ }).first();
      const pkgPopupVisible = await pkgPopupOk.isVisible().catch(() => false);
      console.log(`    [pkg] accessibility popup visible: ${pkgPopupVisible}`);

      if (pkgPopupVisible) {
        await Promise.allSettled([
          workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 25000 }),
          pkgPopupOk.click()
        ]);
        console.log(`    [pkg] popup OK clicked — awaiting navigation`);
      } else {
        // Popup didn't appear (non-POPO brand or already dismissed) — navigation may proceed directly
        await workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 12000 }).catch(() => {});
      }
      await sleep(1500);
    }
    curTitle = await workPage.title();
    console.log(`    [pkg] title after submit: ${curTitle}`);
  }

  // Must now be on Category Fares (RDIC)
  if (!curTitle.includes('RDIC') && !curTitle.includes('Category Fares') && !curTitle.includes('Fares')) {
    console.log(`    [warn] expected Category Fares, got: ${curTitle}`);
  }

  // Princess zone layout has no fare table — see getPricingByShipZone
  const isZoneLayout = curTitle.includes("RDIM");
  let pricing = isZoneLayout ? [] : await extractFareTable(workPage);

  // Capture RDIC state for direct-POST cabin fetching (browser stays on RDIC throughout)
  const rdicHtml     = await workPage.content();
  const rdicF        = parseFormFieldsFromHtml(rdicHtml);
  const stateToken   = rdicF.DFH_STATE_TOKEN ?? null;
  const rdicNextIds  = Object.entries(rdicF).filter(([k]) => k.startsWith("DFH_NEXTTRANSID")).map(([,v]) => v);
  const selCatField  = rdicNextIds.find(f => f.includes("SELCAT"))  ?? "F410220002_CMRDIC-SELCAT";
  const selFareField = rdicNextIds.find(f => f.includes("SELFARE")) ?? "F410150001_CMRDIC-SELFARE";
  console.log(`    [post] token="${stateToken}" selCat="${selCatField}"`);
  if (isZoneLayout) {
    dumpPolarPage("RDIM", rdicHtml);
    try {
      pricing = await getPricingByShipZone(workPage, rdicHtml, stateToken, maxCategories);
    } catch (err) {
      console.warn(`    [zone] zone walk failed: ${err.message.split("\n")[0]}`);
    }
    console.log(`    [zone] ${pricing.length} categories, ${pricing.reduce((n, c) => n + c.cabins.length, 0)} cabins`);
  }

  // For each available category, use direct HTTP POST to fetch cabin data.
  // The browser stays on RDIC — page.request.post() is out-of-band (shares cookies).
  // Falls back to browser click if direct POST fails.
  for (let i = 0; !isZoneLayout && i < Math.min(pricing.length, maxCategories); i++) {
    const cat = pricing[i];
    if (cat.avlResult === 'SLD' || cat.avail === 0) {
      cat.cabins = [];
      continue;
    }
    console.log(`    [stateroom] ${cat.code} (${cat.name})`);
    if (stateToken) {
      try {
        cat.cabins = await getCabinsForCategoryDirect(workPage, rdicF, selCatField, selFareField, cat.code, stateToken);
        console.log(`      → ${cat.cabins.length} cabins (direct POST)${cat.cabins.waitlistOnly ? " — waitlist only" : ""}`);
        if (cat.cabins.waitlistOnly) { cat.status = "Waitlist"; cat.avlResult = "WTL"; }
        // Fare-table avail is a separate, momentary POLAR count that can lag
        // behind the actual stateroom list — the cabin list is ground truth
        // for "how many can be picked", so reconcile avail to match it.
        if (cat.cabins.length !== cat.avail) cat.avail = cat.cabins.length;
        continue;
      } catch (err) {
        console.warn(`      [POST failed] ${cat.code}: ${err.message} — falling back to browser`);
      }
    }
    // Browser fallback
    try {
      cat.cabins = await getStateromsForCategory(workPage, i);
      if (cat.cabins.length !== cat.avail) cat.avail = cat.cabins.length;
    } catch (err) {
      console.error(`    [stateroom error] ${cat.code}: ${err.message}`);
      cat.cabins = [];
      for (let r = 0; r < 3; r++) {
        const t = await workPage.title();
        if (t.includes('RDIC') || t.includes('Category Fares') || t.includes('Fares')) break;
        await workPage.goBack({ waitUntil: "networkidle" }).catch(() => {});
        await sleep(800);
      }
    }
    await jitter(500, 1000);
  }

  // Navigate RDIC → RDIJ → RDLV by clicking BACK with title-change wait.
  // waitForNavigation is unreliable for POLAR POSTs, so we poll document.title.
  for (let step = 0; step < 7; step++) {
    const t = await workPage.title();
    if (isAvailabilityByDate(t)) break;
    console.log(`    [back] step ${step+1}: leaving "${t}"`);

    const backLink = workPage.locator('a, input[type="button"], input[type="submit"]')
      .filter({ hasText: /^\s*BACK\s*$/i })
      .first();

    if (await backLink.isVisible().catch(() => false)) {
      await Promise.allSettled([
        workPage.waitForFunction((prev) => document.title !== prev, t, { timeout: 20000 }),
        backLink.click(),
      ]);
    } else {
      const submitted = await workPage.evaluate(() => {
        const form = document.querySelector('form');
        if (!form || typeof doSimpleSubmit !== 'function') return false;
        doSimpleSubmit(form, 'DFH_PF12');
        return true;
      });
      if (!submitted) {
        // Try direct MAIN MENU navigation if nothing else works
        await workPage.evaluate(() => {
          if (typeof doSimpleSubmit === 'function') doSimpleSubmit(document.forms[0], 'DFH_CLEAR');
        });
        await workPage.waitForLoadState('networkidle').catch(() => {});
        break;
      }
      await workPage.waitForFunction((prev) => document.title !== prev, t, { timeout: 20000 }).catch(() => {});
    }
    await workPage.waitForLoadState("networkidle").catch(() => {});
    await sleep(500);
  }

  // Verify we're back on availability. Princess's POLAR branch often throws a
  // "CICS Web Interface error" on the way back — the pricing is already
  // extracted at this point, so never discard it: attempt recovery via
  // history-back and return the data either way.
  const endTitle = await workPage.title();
  console.log(`    [back] final page: "${endTitle}"`);
  if (!isAvailabilityByDate(endTitle)) {
    console.warn(`    [back] not on availability page (${endTitle}) — recovering, pricing kept`);
    for (let i = 0; i < 3; i++) {
      await workPage.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await sleep(1200);
      const t2 = await workPage.title().catch(() => "");
      if (isAvailabilityByDate(t2)) {
        console.log(`    [back] recovered to availability via history`);
        break;
      }
    }
  }

  return pricing;
}

// ── Parse the stateroom selection page (RDIA) ────────────────────────────────

async function extractStateromsPage(workPage) {
  return workPage.evaluate(() => {
    const cabins = [];
    document.querySelectorAll('tr.arial11_13h_333333_boxcontent').forEach(row => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      const name = checkbox.name || "";
      if (!name.startsWith("CABIN_")) return;
      const cabinNo = name.replace(/^CABIN_/, "").trim();
      if (!cabinNo || /^(GUAR|WAIT)/.test(cabinNo)) return;

      const category = checkbox.value?.trim() || "";
      const cells    = [...row.cells];
      const location = cells[3]?.innerText?.replace(/ /g, " ").trim() || "";
      const berths   = cells[4]?.innerText?.replace(/ /g, " ").trim() || "";
      const deckMatch = cabinNo.match(/^([A-Z]+)/);
      const deck = deckMatch ? deckMatch[1] : null;
      const deckNum = /^\d{4,}$/.test(cabinNo) ? (parseInt(cabinNo.slice(0, cabinNo.length - 3)) || null) : null;
      cabins.push({ cabinNumber: cabinNo, deckName: deck, deckNumber: deckNum, location, berths });
    });
    return cabins;
  });
}

async function clickBack(workPage) {
  const titleNow = await workPage.title();
  const backBtn  = workPage.locator('a, input[type="button"], input[type="submit"]')
    .filter({ hasText: /^\s*BACK\s*$/i }).first();
  if (await backBtn.isVisible().catch(() => false)) {
    await Promise.allSettled([
      workPage.waitForFunction(t => document.title !== t, titleNow, { timeout: 20000 }),
      backBtn.click(),
    ]);
  } else {
    await workPage.evaluate(() => {
      const form = document.querySelector("form");
      if (form && typeof doSimpleSubmit === "function") doSimpleSubmit(form, "DFH_PF12");
    });
    await workPage.waitForFunction(t => document.title !== t, titleNow, { timeout: 15000 }).catch(() => {});
  }
  await workPage.waitForLoadState("networkidle").catch(() => {});
  await sleep(800);
}

async function clickSaveAndWait(workPage) {
  const titleNow = await workPage.title();
  const saveBtn  = workPage.locator('#footerSec a:has-text("SAVE"), a:has-text("SAVE & CONTINUE"), a:has-text("Save & Continue")').first();
  if (!await saveBtn.isVisible().catch(() => false)) return false;
  await Promise.allSettled([
    workPage.waitForFunction(t => document.title !== t, titleNow, { timeout: 20000 }),
    saveBtn.click(),
  ]);
  await workPage.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);
  return true;
}

// Navigate from RDIC to stateroom page for one category, extract cabins, return to RDIC
// Flow: RDIC → SAVE → RDLE → SAVE → RDIA (stateroom) → BACK → RDLE → BACK → RDIC
async function getStateromsForCategory(workPage, categoryIdx) {
  const radios = workPage.locator('tr.arial11_13h_333333_boxcontent input[type="radio"]');
  const total  = await radios.count();
  if (categoryIdx >= total) return [];

  await radios.nth(categoryIdx).click();
  await sleep(400);

  // Dismiss accessibility popup if it appears after radio click
  const accessOk = workPage.locator('button').filter({ hasText: /^OK$/ }).first();
  if (await accessOk.isVisible({ timeout: 2000 }).catch(() => false)) {
    await accessOk.click();
    await sleep(400);
  }

  // Step 1: RDIC → RDLE
  const ok1 = await clickSaveAndWait(workPage);
  if (!ok1) {
    console.log(`      [stateroom] SAVE not visible for category index ${categoryIdx}`);
    return [];
  }
  let title = await workPage.title();
  console.log(`      [stateroom] after 1st SAVE: ${title}`);

  // Step 2: RDLE → RDIA (if needed)
  let wentToRDIA = false;
  if (title.includes('RDLE') || title.includes('Pricing Detail') || title.includes('AVAL')) {
    const ok2 = await clickSaveAndWait(workPage);
    title = await workPage.title();
    console.log(`      [stateroom] after 2nd SAVE: ${title}`);
    if (ok2) wentToRDIA = true;
  }

  // Dismiss any intermediate notice/notification pages until cabin checkboxes appear
  for (let n = 0; n < 10; n++) {
    const pageInfo = await workPage.evaluate(() => {
      const hasCabins = !!document.querySelector('input[type="checkbox"][name^="CABIN_"]');
      const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')]
        .map(e => ({ name: e.name, checked: e.checked, visible: e.offsetParent !== null }));
      return { hasCabins, checkboxes, title: document.title };
    });
    // Break if cabins found, on Cabin Selection (RDLC), or on Create Booking (RABA — safety stop)
    if (pageInfo.hasCabins
      || pageInfo.title.includes('RDLC') || pageInfo.title.includes('Cabin Selection')
      || pageInfo.title.includes('RABA') || pageInfo.title.includes('Create Booking')) break;

    // Check any unchecked visible ack checkbox (skip cookie consent)
    for (const cb of pageInfo.checkboxes.filter(c => c.visible && !c.checked && !c.name.includes('ot-group'))) {
      await workPage.locator(`input[name="${cb.name}"]`).first().click().catch(() => {});
      await sleep(300);
    }

    // Try doSimpleSubmit(DFH_ENTER) first, fall back to SAVE link click
    const submitted = await workPage.evaluate(() => {
      const form = document.querySelector('form');
      if (form && typeof doSimpleSubmit === 'function') { doSimpleSubmit(form, 'DFH_ENTER'); return 'js'; }
      return null;
    });
    if (!submitted) await clickSaveAndWait(workPage);
    else {
      await workPage.waitForLoadState('networkidle').catch(() => {});
      await sleep(1500);
    }
    title = await workPage.title();
    console.log(`      [stateroom] notice loop ${n + 1} [${submitted || 'btn'}]: "${title}"`);
  }

  // For RDLC (Cabin Selection), wait for JS to render cabin data, then check
  // for waitlist-only message. If waitlisted, no cabin selection is possible.
  const curTitle = await workPage.title();
  if (curTitle.includes('RDLC') || curTitle.includes('Cabin Selection')) {
    await workPage.waitForTimeout(2000); // allow JS to populate displayRow() calls
    const isWtlOnly = await workPage.evaluate(() => {
      const body = document.body.innerText || "";
      return /WAITLIST ONLY|AVAILABLE FOR WAITLIST/i.test(body);
    });
    if (isWtlOnly) {
      console.log(`      [stateroom] RDLC waitlist-only — navigating back to RDIC`);
      // Navigate back to RDIC before returning so getVoyagePricing can proceed
      for (let bs = 0; bs < 5; bs++) {
        const t = await workPage.title();
        if (t.includes('RDIC') || t.includes('Category Fares') || t.includes('Fares')) break;
        await clickBack(workPage);
      }
      return [];
    }
  }
  const cabins = await extractStateromsPage(workPage);
  console.log(`      [stateroom] ${cabins.length} cabins on "${title}"`);

  // Navigate back to RDIC — loop BACK until we arrive (path can be 1–5 steps)
  for (let backStep = 0; backStep < 8; backStep++) {
    const t = await workPage.title();
    if (t.includes('RDIC') || t.includes('Category Fares') || t.includes('Fares')) break;
    console.log(`      [stateroom] back step ${backStep + 1}: leaving "${t}"`);
    await clickBack(workPage);
  }
  const finalTitle = await workPage.title();
  if (!finalTitle.includes('RDIC') && !finalTitle.includes('Category Fares') && !finalTitle.includes('Fares')) {
    console.log(`      [stateroom] WARNING: expected RDIC but got: ${finalTitle}`);
  }

  return cabins;
}

// ── Parse the Category Fares table ───────────────────────────────────────────

async function extractFareTable(workPage) {
  return workPage.evaluate(() => {
    const TYPE_TO_GROUP = {
      "suites": "Suite", "suite": "Suite", "mini-suite": "Mini-Suite",
      "balcony": "Balcony",
      "outside": "Exterior", "obstructed": "Exterior",
      "inside": "Interior",
    };

    const categories = [];

    // Target the specific row class POLAR uses for fare data.
    // Row structure: cells[0]=radio(value=code), cells[1]=name(nbsp), cells[2]=count, cells[3]=price, cells[4]=promo
    document.querySelectorAll('tr.arial11_13h_333333_boxcontent').forEach(row => {
      const cells = [...row.cells];
      if (cells.length < 5) return;

      // Code from radio button value (2-char category code without berths digit)
      const radio = cells[0]?.querySelector('input[type="radio"]');
      const code = radio?.value?.trim() ?? null;
      if (!code) return;

      // Name: strip &nbsp; ( ) and regular whitespace
      const nameRaw = cells[1]?.innerText?.replace(/ /g, ' ').trim() ?? "";
      // Format: "A1 Suites", "B14 Suites", "EA4 Balcony", "K5 Obstructed"
      const nameParts = nameRaw.split(/\s+/);
      const typeRaw = nameParts.slice(1).join(' ').toLowerCase();
      const group = TYPE_TO_GROUP[typeRaw] ?? "Other";

      // Capacity: trailing digit(s) on the display code (e.g. "B14" → 4, "EA4" → 4, "A1" → 1)
      const capMatch = nameParts[0]?.match(/(\d+)$/);
      const capacity = capMatch ? parseInt(capMatch[1]) : null;

      // Status: "  1", "  9", "  C" — trim, then parse
      const statusText = cells[2]?.innerText?.trim() ?? "";
      const isClosed = statusText.toUpperCase() === 'C';
      const avail = isClosed ? 0 : (parseInt(statusText) || null);
      const avlResult = isClosed ? 'SLD' : 'OK';
      const status = isClosed ? 'Closed' : 'Available';

      // Price: "    3,469*" or "    1,099 " — strip spaces, commas, asterisk
      const priceText = cells[3]?.innerText?.trim() ?? "";
      const priceClean = priceText.replace(/[,*\s]/g, '');
      const perPersonPrice = priceClean ? parseFloat(priceClean) : null;
      if (perPersonPrice === null || isNaN(perPersonPrice)) return;

      // Promo (upgrade code like "KD4")
      const promoText = cells[4]?.innerText?.trim() ?? "";
      const promos = promoText ? [promoText] : [];

      categories.push({
        code,
        name: nameRaw,
        group,
        capacity,
        status,
        avlResult,
        avail,
        cabinPrice: perPersonPrice,
        perPersonPrice,
        promos,
      });
    });

    return categories;
  });
}

// ── Format Date as POLAR sailDate string (e.g. "27Dec26") ────────────────────

function formatPolarDate(date) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = String(date.getDate()).padStart(2, '0');
  const m = months[date.getMonth()];
  const y = String(date.getFullYear()).slice(-2);
  return `${d}${m}${y}`;
}

// ── Navigate from RDLV back to RDLT (Sailing Search) ─────────────────────────

async function backToSearch(workPage, allowReload = true) {
  for (let i = 0; i < 8; i++) {
    const onSearch = await workPage.locator('input[name="AIRCITY_1"]').isVisible({ timeout: 800 }).catch(() => false);
    if (onSearch) return true;
    const t = await workPage.title();
    if (t.includes('MAIN MENU')) return false;
    if (t.includes('Abend') || t.includes('CICS Web')) {
      // CICS occasionally recovers from a hung transaction on a plain reload
      // (confirmed live on Princess brand voyages) — worth one attempt before
      // giving up, since giving up here cascades into every later voyage on
      // the page failing too.
      if (!allowReload) return false;
      console.log(`    [back] CICS error mid-recovery — reloading once`);
      await workPage.reload({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await sleep(1000);
      return backToSearch(workPage, false);
    }
    await workPage.evaluate(() => {
      const form = document.querySelector('form');
      if (form && typeof doSimpleSubmit === 'function') doSimpleSubmit(form, 'DFH_PF12');
    }).catch(() => {});
    await workPage.waitForLoadState('networkidle').catch(() => {});
    await sleep(800);
  }
  return false;
}

// Back to the RDLT search form for the NEXT date batch of a multi-page search.
// backToSearch() answers false on POLAR's MAIN MENU (session reset) and on other
// off-transaction pages, and both paging loops used to `break` there without a
// word — silently dropping every later page. The scheduled gohal run #507 came
// back with 8 Holland America voyages instead of up to 40 because of it.
// ensureOnPolarSearch() knows how to climb back from those pages, so try it
// before giving up, and say so when we do give up.
async function backToSearchForPaging(workPage, label) {
  if (await backToSearch(workPage)) return true;
  console.log(`[${label}] backToSearch gave up on "${await workPage.title().catch(() => "?")}" — trying full recovery to keep paging`);
  const ok = await ensureOnPolarSearch(workPage).catch(() => false);
  if (!ok) console.log(`[${label}] could not get back to the search form — paging stops here`);
  return ok;
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Shared helper: given an already-loaded POLAR "Sailing Search" (RDLT) page,
// submit the date search, find the voyage by code, extract cabin categories.
// Used by both CCS (fetchVoyageByCode) and Gohal (fetchGohalVoyageByCode).
// Shared by the single-voyage refresh (fetchPolarVoyageOnPage) and the bulk
// search (runPolarSearchFlow). The bulk path used to call searchByDate() with no
// check at all, so whenever POLAR resumed a stale CICS session on any page other
// than RDLT the whole run died with "waiting for locator('input[name=AIRCITY_1]')"
// (gohal run 457, CCS-B run 455). Returns true once the search form is present.
export async function ensureOnPolarSearch(workPage, allowReload = true) {
  // Ensure we're on RDLT (Sailing Search) before filling the form.
  // POLAR (CICS) resumes the last session state. Strategy depends on which page
  // POLAR landed on:
  //   RDLP (Booking Agency) → press ENTER to proceed forward to RDLT
  //   Other mid-booking pages (RDIC, RDIJ, RDLV) → press PF12 (BACK) to retreat
  //   CICS error / abend → navigate back to CCS and re-open POLAR
  const onSearch = await workPage.locator('input[name="AIRCITY_1"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!onSearch) {
    const t0 = await workPage.title();
    console.log(`[polar] not on RDLT: title="${t0}" — attempting recovery`);

    if (t0.includes('RDLP') || t0.includes('Booking Agency')) {
      // RDLP: press ENTER to advance to RDLT (agency is already set from prior session)
      console.log('[polar] on RDLP — pressing DFH_ENTER to advance to sailing search');
      await workPage.evaluate(() => {
        const form = document.querySelector('form');
        if (form && typeof doSimpleSubmit === 'function') doSimpleSubmit(form, 'DFH_ENTER');
      }).catch(() => {});
      await workPage.waitForLoadState('networkidle').catch(() => {});
      await sleep(1500);
      console.log(`[polar] after RDLP ENTER: "${await workPage.title()}"`);
    } else {
      // Mid-booking or error page — press PF12 up to 8 times to retreat
      for (let i = 0; i < 8; i++) {
        const t = await workPage.title();
        if (t.includes('error') || t.includes('Abend') || t.includes('CICS Web')) {
          // CICS crashed — nothing left to do, searchByDate will timeout and error cleanly
          console.log(`[polar] CICS error on step ${i} — cannot recover, will fail at search`);
          break;
        }
        const hasSearch = await workPage.locator('input[name="AIRCITY_1"]').isVisible({ timeout: 500 }).catch(() => false);
        if (hasSearch) { console.log(`[polar] reached RDLT after ${i} PF12 steps`); break; }

        const hasCreate = await workPage.locator('a:has-text("Create Booking"), a:has-text("Create New Booking")').first().isVisible({ timeout: 500 }).catch(() => false);
        if (hasCreate) {
          console.log(`[polar] on main menu after ${i} PF12 steps — navigating forward`);
          await Promise.allSettled([
            workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
            workPage.locator('a:has-text("Create Booking"), a:has-text("Create New Booking")').first().click()
          ]);
          await sleep(1500);
          const saveBtn = workPage.locator('a:has-text("Save and Continue"), a:has-text("Save & Continue"), input[value*="Save"]').first();
          if (await saveBtn.isVisible().catch(() => false)) {
            await Promise.allSettled([workPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }), saveBtn.click()]);
            await sleep(1500);
          }
          break;
        }

        console.log(`[polar] PF12 step ${i + 1}: leaving "${t}"`);
        await workPage.evaluate(() => {
          const form = document.querySelector('form');
          if (form && typeof doSimpleSubmit === 'function') doSimpleSubmit(form, 'DFH_PF12');
        }).catch(() => {});
        await workPage.waitForLoadState('networkidle').catch(() => {});
        await sleep(800);
      }
      console.log(`[polar] final page before search: "${await workPage.title()}"`);
    }
  }

  const reachedSearch = await workPage.locator('input[name="AIRCITY_1"]').isVisible({ timeout: 5000 }).catch(() => false);
  if (reachedSearch) return true;

  // A CICS error page recovers on a plain reload elsewhere in this file
  // (backToSearch) — give the same chance here, once, before giving up.
  const endTitle = await workPage.title().catch(() => "");
  if (allowReload && /error|abend|cics web/i.test(endTitle)) {
    console.log(`[polar] still on a CICS error page ("${endTitle}") — reloading once and retrying`);
    await workPage.reload({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(1000);
    return ensureOnPolarSearch(workPage, false);
  }
  return false;
}

export async function fetchPolarVoyageOnPage(workPage, voyageCode, sailDate) {
  await ensureOnPolarSearch(workPage);

  await searchByDate(workPage, { homeCity: "LON", sailDate, occupancy: 2 });
  console.log(`[polar] after search: title="${await workPage.title()}" url="${workPage.url()}"`);

  let found = null;
  let currentSailDate = sailDate;
  for (let p = 0; p < 5 && !found; p++) {
    const title = await workPage.title();
    if (!title.includes("Availability") && !title.includes("RDLV")) {
      console.log(`[polar] unexpected page after search: "${title}" — aborting`);
      break;
    }
    const voyages = await extractVoyageList(workPage);
    console.log(`[polar] page ${p+1} voyages: ${voyages.map(v => `${v.voyageNum}(${v.depDate})`).join(', ')}`);
    found = voyages.find(v => v.voyageNum === voyageCode) ?? null;
    if (!found) {
      const lastDate = voyages.map(v => parseDate(v.depDate)).filter(Boolean).sort((a, b) => b - a)[0];
      if (!lastDate) break;
      currentSailDate = formatPolarDate(new Date(lastDate.getTime() + 86400000));
      const backOk = await backToSearchForPaging(workPage, "polar");
      if (!backOk) break;
      await searchByDate(workPage, { homeCity: "LON", sailDate: currentSailDate, occupancy: 2 });
    }
  }

  if (!found) {
    console.warn(`[polar] voyage ${voyageCode} not found in search results`);
    return null;
  }

  const cabinCategories = await getVoyagePricing(workPage, found, Infinity);
  const shipCode   = SHIP_CODES[found.ship?.toUpperCase()] ?? null;
  const startDate  = parseDate(found.depDate);
  const endDate    = startDate && found.nights ? new Date(startDate.getTime() + found.nights * 86400000) : null;
  const routeParts = found.route?.split("-") ?? [];

  return {
    id:             found.voyageNum,
    ship:           found.ship,
    shipCode,
    package:        found.product,
    nights:         found.nights,
    startDate,
    endDate,
    portFrom:       parsePort(routeParts[0]),
    portTo:         parsePort(routeParts[1] ?? routeParts[0]),
    currency:       "GBP",
    cabinCategories,
  };
}

// ── Reusable POLAR search flow ──────────────────────────────────────────────
// On-demand single-voyage fetch for CCS A/B. Authenticates, opens POLAR, then
// delegates to fetchPolarVoyageOnPage.
export async function fetchVoyageByCode(session, credentials, voyageCode, sailDate, brand = null) {
  await ensureAuthentication(session, credentials);
  const workPage = await navigateToPolarBooking(session.page, { brand });
  const result = await fetchPolarVoyageOnPage(workPage, voyageCode, sailDate);
  return result ? { ...result, cruiseLine: brand ?? "PO" } : result;
}

// Once we're on the POLAR Online "Sailing Search" page (RDLT), this drives the
// search and extracts voyage pricing. Used by both CCS and Holland America
// (gohal) — both sit on top of the same POLAR Online platform.

export async function runPolarSearchFlow(workPage, options = {}, vendorKey = "polar") {
  const {
    homeCity      = "LON",
    sailDate      = "01Jan28",
    occupancy     = 2,
    maxPages      = 5,
    maxCruises    = Infinity,
    maxCategories = Infinity,
    shipName      = null, // optional case-insensitive filter, e.g. "ROTTERDAM" — skips pricing fetch for every other ship and stops once exhausted
  } = options;

  const shipFilter = shipName ? shipName.trim().toUpperCase() : null;

  if (!(await ensureOnPolarSearch(workPage))) {
    throw new Error(`[${vendorKey}] POLAR never reached the sailing-search page (title="${await workPage.title().catch(() => "?")}")`);
  }
  await searchByDate(workPage, { homeCity, sailDate, occupancy });

  const allVoyages = [];
  let pageNum = 0;

  const seenIds    = new Set();
  let   currentDate = sailDate;

  while (pageNum < maxPages) {
    pageNum++;
    const pageTitle = await workPage.title();
    if (!pageTitle.includes('Availability by Date') && !pageTitle.includes('RDLV')) {
      console.log(`[${vendorKey}] Not on availability page (${pageTitle}), stopping.`);
      break;
    }

    const voyages = await extractVoyageList(workPage);
    console.log(`[${vendorKey}] Page ${pageNum}: ${voyages.length} voyages`);

    const newVoyages = voyages.filter(v => !seenIds.has(v.voyageNum));
    if (newVoyages.length === 0) {
      console.log(`[${vendorKey}] All voyages on page ${pageNum} already seen — stopping`);
      break;
    }

    let lastDate = null;
    let matchedOnThisPage = 0;
    for (const voyage of newVoyages) {
      if (allVoyages.length >= maxCruises) break;
      seenIds.add(voyage.voyageNum);
      const startDate   = parseDate(voyage.depDate);
      if (startDate) lastDate = startDate;

      if (shipFilter && voyage.ship?.trim().toUpperCase() !== shipFilter) {
        continue; // not the requested ship — skip pricing fetch entirely, saves a full page nav per voyage
      }
      if (shipFilter) matchedOnThisPage++;

      const routeParts  = voyage.route?.split('-') ?? [];
      const portFrom    = parsePort(routeParts[0]);
      const portTo      = parsePort(routeParts[1] ?? routeParts[0]);
      const endDate     = startDate && voyage.nights ? new Date(startDate.getTime() + voyage.nights * 86400000) : null;
      const shipCode    = SHIP_CODES[voyage.ship?.toUpperCase()] ?? null;

      console.log(`  → ${voyage.voyageNum} ${voyage.ship} ${voyage.depDate} (${voyage.nights}N)`);

      let cabinCategories = [];
      try {
        cabinCategories = await getVoyagePricing(workPage, voyage, maxCategories);
        console.log(`     ${cabinCategories.length} category prices extracted`);
      } catch (err) {
        console.error(`     [pricing error] ${voyage.voyageNum}: ${err.message}`);
        // history-based goBack() resumes POLAR's own stale CICS session state,
        // which is exactly what crashed (confirmed live: Princess brand throws
        // "CICS Web Interface error" reliably on the way back from pricing, and
        // goBack() alone left every subsequent voyage on the same broken page —
        // 1/8 voyages got real data, the other 7 silently returned []). A full
        // re-search from RDLT forces a clean CICS transaction instead of
        // resuming the broken one.
        let recovered = false;
        for (let attempt = 0; attempt < 3 && !recovered; attempt++) {
          await workPage.goBack({ waitUntil: "networkidle" }).catch(() => {});
          await sleep(1000);
          const t = await workPage.title();
          if (t.includes('Availability') || t.includes('RDLV')) recovered = true;
        }
        if (!recovered) {
          console.log(`     [recovery] goBack failed, re-searching from RDLT`);
          const backOk = await backToSearch(workPage);
          if (backOk) {
            await searchByDate(workPage, { homeCity, sailDate: currentDate, occupancy });
            recovered = true;
          }
        }
        if (!recovered) {
          // backToSearch only recognizes the search form, MAIN MENU, and
          // Abend/CICS-titled pages — a page that landed completely off the
          // CICS transaction (confirmed live: title stuck at the bare domain
          // "www.onesourcecruises.com", no recognizable POLAR markup at all)
          // falls through all of its branches and the PF12 submit is a no-op
          // there, so this used to fail once and then fail identically for
          // every remaining voyage on the page (1/8 succeeded, 7/8 didn't).
          // A hard reload already recovers CICS from an Abend elsewhere in
          // this file — try the same thing here rather than giving up.
          console.log(`     [recovery] still not recovered, title="${await workPage.title().catch(() => "?")}" — trying hard reload`);
          await workPage.reload({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
          await sleep(1000);
          const backOk2 = await backToSearch(workPage);
          if (backOk2) {
            await searchByDate(workPage, { homeCity, sailDate: currentDate, occupancy });
            recovered = true;
          }
        }
        if (!recovered) console.log(`     [recovery] all recovery attempts failed — skipping this voyage, will retry recovery on the next one`);
      }

      allVoyages.push({
        id:          voyage.voyageNum,
        ship:        voyage.ship,
        shipCode,
        package:     voyage.product,
        nights:      voyage.nights,
        startDate,
        endDate,
        portFrom,
        portTo,
        routeLabel:  portFrom && portTo ? `${portFrom} -> ${portTo}` : voyage.route,
        currency:    "GBP",
        cabinCategories,
      });

      await jitter(800, 1500);
    }

    if (allVoyages.length >= maxCruises) break;
    if (!lastDate) break;
    if (shipFilter && allVoyages.length > 0 && matchedOnThisPage === 0) {
      console.log(`[${vendorKey}] "${shipFilter}" not found on page ${pageNum} after ${allVoyages.length} match(es) already captured — stopping instead of paging through unrelated ships`);
      break;
    }

    // Advance to the next date batch — navigate back to RDLT and re-search.
    // POLAR's RDLV only shows ~8 results per search window; clicking NEXT wraps around.
    const nextDate = new Date(lastDate.getTime() + 86400000);
    currentDate = formatPolarDate(nextDate);
    console.log(`[${vendorKey}] Advancing search to ${currentDate}`);

    const backOk = await backToSearchForPaging(workPage, vendorKey);
    if (!backOk) break;
    await searchByDate(workPage, { homeCity, sailDate: currentDate, occupancy });
  }

  return allVoyages;
}

export function createCcsRunner(account) {
  const cfg = { ...DEFAULT_ACCOUNT_A, ...account };

  async function run(options = {}) {
    const {
      homeCity      = "LON",
      sailDate      = "01Jan28",
      occupancy     = 2,
      maxPages      = 5,
      maxCruises    = Infinity,
      maxCategories = Infinity,
      brand         = null,   // single brand: null/"PO" = P&O (default), "CUNARD", "PRINCESS"
      brands        = null,   // multi-brand: e.g. ["PO","CUNARD","PRINCESS"] — overrides `brand`
      shipName      = null,   // optional, e.g. "AURORA" — narrows to one ship, skips pricing fetch for every other voyage and stops paging once exhausted
    } = options;
    const brandList = brands ?? [brand ?? "PO"];

    const session = await createScraperSession({
      userDataDir:      cfg.userDataDir,
      storageStatePath: cfg.storageStatePath,
      headless:         false,
      slowMo:           0
    });

    try {
      const authResult = await ensureAuthentication(session, { user: cfg.user, pass: cfg.pass });
      const allCruises = [];

      // One brand failing (POLAR resuming a stale page, a CICS error, ...) used to
      // throw out of this loop, so the run failed with 0 saved and the voyages the
      // earlier brands had already collected were thrown away too. Isolate each
      // brand; only fail the run if every brand failed.
      const brandErrors = [];
      for (const b of brandList) {
        console.log(`[${cfg.vendorKey}] scraping brand: ${b}`);
        let workPage = null;
        try {
          workPage = await navigateToPolarBooking(session.page, { brand: b });
          const voyages = await runPolarSearchFlow(workPage, { homeCity, sailDate, occupancy, maxPages, maxCruises, maxCategories, shipName }, "CCS");
          voyages.forEach((v) => allCruises.push({ ...v, cruiseLine: b }));
          console.log(`[${cfg.vendorKey}] ${b}: ${voyages.length} voyages`);
        } catch (err) {
          brandErrors.push(`${b}: ${err.message.split("\n")[0]}`);
          console.error(`[${cfg.vendorKey}] brand ${b} failed — continuing with the next one: ${err.message.split("\n")[0]}`);
        } finally {
          // POLAR opened in a popup — close it so the next brand starts clean
          if (workPage && workPage !== session.page) await workPage.close().catch(() => {});
        }
        await sleep(2000);
      }
      if (brandErrors.length === brandList.length) {
        throw new Error(`All ${brandList.length} brand(s) failed — ${brandErrors.join(" | ")}`);
      }

      return {
        vendorKey:      cfg.vendorKey,
        browserMode:    session.mode,
        authentication: authResult,
        cruises:        allCruises,
      };
    } finally {
      await session.close();
    }
  }

  async function authenticate() {
    const session = await createScraperSession({
      userDataDir:      cfg.userDataDir,
      storageStatePath: cfg.storageStatePath,
      headless:         false,
      slowMo:           0
    });
    try {
      const authResult = await ensureAuthentication(session, { user: cfg.user, pass: cfg.pass });
      return { vendorKey: cfg.vendorKey, ...authResult };
    } finally {
      await session.close();
    }
  }

  return { run, authenticate };
}

const accountA = createCcsRunner(DEFAULT_ACCOUNT_A);

export async function runCompleteCruiseSolutionAScraper(options = {}) {
  return accountA.run(options);
}

export async function authenticateCompleteCruiseSolutionA() {
  return accountA.authenticate();
}
