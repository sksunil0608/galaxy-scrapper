// Holland America via gohal.com → POLAR Online (onesourcecruises.com/polaronlineha)
// Reuses the POLAR search flow from completecruisesolutionA — same engine, just
// a different brand path and a gohal-specific login.

import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";
import { runPolarSearchFlow, fetchPolarVoyageOnPage } from "../completecruisesolution/completecruisesolutionA.js";

dotenv.config();

const USERNAME = process.env.GOHAL_USER;
const PASSWORD = process.env.GOHAL_PASS;
const LOGIN_URL = "https://gohal.com/";

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Kept open across requests — Chromium drops session-only cookies on browser
// close even with a persistent profile dir, so closing after every refresh
// forces a fresh login every time. Reusing one long-lived session avoids that.
let cachedSession = null;
let sessionQueue = Promise.resolve();

async function getOrCreateGohalSession() {
  if (cachedSession) {
    const alive = await cachedSession.page.evaluate(() => true).catch(() => false);
    if (alive) return cachedSession;
    await cachedSession.close().catch(() => {});
    cachedSession = null;
  }
  cachedSession = await createScraperSession({
    userDataDir:      "./sessions/gohal-user-data",
    storageStatePath: "./sessions/.auth/gohal-storage.json",
    headless:         false,
    slowMo:           0
  });
  return cachedSession;
}

function runExclusiveGohal(fn) {
  const result = sessionQueue.then(fn);
  sessionQueue = result.catch(() => {});
  return result;
}

async function ensureGohalAuthentication(session) {
  const { page } = session;

  if (!USERNAME || !PASSWORD) {
    throw new Error("GOHAL_USER and GOHAL_PASS must be set in .env before using the gohal scraper.");
  }

  console.log("[gohal] navigating to gohal.com");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // If Book mega menu is visible, we're already logged in
  const bookLink = page.locator('a.mega-menu-link[title="Book"]').first();
  let loggedIn = await bookLink.isVisible().catch(() => false);
  if (loggedIn) {
    console.log("[gohal] session reused");
    return { success: true, alreadyLoggedIn: true, message: "gohal session reused." };
  }

  // Fill the partnerships_login form
  const userField = page.locator('input[name="user_name"]').first();
  const passField = page.locator('input[name="user_password"]').first();
  await userField.waitFor({ state: "visible", timeout: 15000 });
  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);
  console.log("[gohal] credentials filled");

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }),
    page.locator('input[type="submit"][value="Log In"]').first().click()
  ]);
  await page.waitForTimeout(3000);

  loggedIn = await bookLink.isVisible().catch(() => false);
  if (!loggedIn) throw new Error("gohal login failed — Book menu not visible after submit.");

  console.log("[gohal] login successful");
  await session.persistAuthState();
  return { success: true, alreadyLoggedIn: false, message: "gohal login successful." };
}

const GOHAL_COMPANY_NAMES = {
  HA: "Holland America",
  CU: "Cunard",
  SB: "Seabourn",
};

// Navigate from gohal.com to POLAR Online (opens in new tab).
// companyCode selects the cruise line on the MXTO main-menu page (HA / CU / SB).
async function navigateToPolar(session, companyCode = "HA") {
  const { page } = session;

  const bookLink = page.locator('a.mega-menu-link[title="Book"]').first();
  await bookLink.hover().catch(() => {});
  await sleep(1500);

  const polarLink = page.locator('a.polar_auth_link').first();
  const popupPromise = page.context().waitForEvent("page", { timeout: 30000 });

  console.log(`[gohal] clicking POLAR Online Booking Engine (company: ${companyCode})`);
  await polarLink.click({ force: true });

  const polarPage = await popupPromise;
  await polarPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => null);
  await polarPage.waitForURL((u) => u.toString().includes("onesourcecruises.com/polaronlineha"), { timeout: 30000 }).catch(() => {});
  await polarPage.waitForTimeout(3000);
  console.log("[gohal] POLAR loaded:", polarPage.url(), "title:", await polarPage.title());

  // On the MXTO main-menu page, select the cruise line before proceeding.
  // POLAR default is HA; CU/SB require an explicit selectOption (triggers changeComp → page reload).
  const cruiseLineSelect = polarPage.locator('select[name="CRUISE_LINES"]');
  if (await cruiseLineSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
    const current = await cruiseLineSelect.inputValue().catch(() => "HA");
    if (current !== companyCode) {
      console.log(`[gohal] switching cruise line from ${current} → ${companyCode}`);
      await Promise.allSettled([
        polarPage.waitForLoadState("networkidle", { timeout: 20000 }),
        cruiseLineSelect.selectOption(companyCode),
      ]);
      await sleep(2000);
      console.log(`[gohal] company selected, title: ${await polarPage.title()}`);
    } else {
      console.log(`[gohal] cruise line already ${companyCode}`);
    }
  }

  // POLAR landed on MAIN MENU — navigate to Create Booking → Save & Continue → Sailing Search
  const createBkg = polarPage.locator('a:has-text("Create Booking"), a:has-text("Create New Booking")').first();
  if (await createBkg.isVisible().catch(() => false)) {
    console.log("[gohal] clicking Create Booking on POLAR");
    await Promise.allSettled([
      polarPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
      createBkg.click()
    ]);
    await sleep(1500);
  }

  const saveBtn = polarPage.locator('a:has-text("Save and Continue"), a:has-text("Save & Continue"), input[value*="Save"]').first();
  if (await saveBtn.isVisible().catch(() => false)) {
    console.log("[gohal] clicking Save & Continue");
    await Promise.allSettled([
      polarPage.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }),
      saveBtn.click()
    ]);
    await sleep(1500);
  }

  console.log("[gohal] POLAR ready, title:", await polarPage.title());
  return polarPage;
}

// Single-voyage refresh: login → POLAR → find voyage → extract cabin categories.
// companyCode selects the cruise line on POLAR MXTO (HA / CU / SB, default HA).
export async function fetchGohalVoyageByCode(voyageCode, sailDate, companyCode = "HA") {
  return runExclusiveGohal(async () => {
    const session = await getOrCreateGohalSession();
    await ensureGohalAuthentication(session);
    const polarPage = await navigateToPolar(session, companyCode);
    const result = await fetchPolarVoyageOnPage(polarPage, voyageCode, sailDate);
    return result ? { ...result, cruiseLine: GOHAL_COMPANY_NAMES[companyCode] ?? companyCode } : result;
  });
}

export async function authenticateGohal() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/gohal-user-data",
    storageStatePath: "./sessions/.auth/gohal-storage.json",
    headless:         false,
    slowMo:           0
  });
  try {
    const authResult = await ensureGohalAuthentication(session);
    return { vendorKey: "gohal", browserMode: session.mode, ...authResult };
  } catch (error) {
    error.message = `gohal authentication failed: ${error.message}`;
    throw error;
  } finally {
    await session.close();
  }
}

export async function runGohalScraper(options = {}) {
  const {
    homeCity     = "LON",
    sailDate     = "01Jan28",
    occupancy    = 2,
    maxPages     = 5,
    maxCruises   = Infinity,   // per-company cap (e.g. 3 for a quick per-brand sample)
    companyCodes = ["HA", "CU", "SB"],
    shipName     = null,       // optional, e.g. "ROTTERDAM" — narrows to one ship, skips pricing fetch for every other voyage and stops paging once exhausted
  } = options;

  const session = await createScraperSession({
    userDataDir:      "./sessions/gohal-user-data",
    storageStatePath: "./sessions/.auth/gohal-storage.json",
    headless:         false,
    slowMo:           0
  });

  try {
    const authResult = await ensureGohalAuthentication(session);
    const allVoyages = [];

    for (const companyCode of companyCodes) {
      console.log(`[gohal] scraping company: ${companyCode} (${GOHAL_COMPANY_NAMES[companyCode] ?? companyCode})`);
      const polarPage = await navigateToPolar(session, companyCode);
      const voyages   = await runPolarSearchFlow(polarPage, { homeCity, sailDate, occupancy, maxPages, maxCruises, shipName }, "gohal");

      // Tag each voyage with its cruise line so it's saved correctly in DB
      const cruiseLine = GOHAL_COMPANY_NAMES[companyCode] ?? companyCode;
      voyages.forEach((v) => { v.cruiseLine = cruiseLine; });
      allVoyages.push(...voyages);

      console.log(`[gohal] ${companyCode}: ${voyages.length} voyages found`);
      await polarPage.close().catch(() => {});
      await sleep(2000);
    }

    return {
      vendorKey:      "gohal",
      browserMode:    session.mode,
      authentication: authResult,
      cruises:        allVoyages,
    };
  } finally {
    await session.close();
  }
}
