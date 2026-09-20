import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

function resolveBrowserMode() {
  const configuredMode = process.env.SCRAPER_BROWSER_MODE?.trim().toLowerCase();

  if (configuredMode === "local" || configuredMode === "browserless") {
    return configuredMode;
  }

  return process.env.BROWSERLESS_TOKEN ? "browserless" : "local";
}

function resolveBrowserlessEndpoint() {
  const token = process.env.BROWSERLESS_TOKEN;

  if (!token) {
    throw new Error(
      "BROWSERLESS_TOKEN is required when SCRAPER_BROWSER_MODE=browserless"
    );
  }

  if (process.env.BROWSERLESS_WS_ENDPOINT) {
    return process.env.BROWSERLESS_WS_ENDPOINT.replace("{token}", token);
  }

  return `wss://production-sfo.browserless.io?token=${token}`;
}

async function loadStorageState(storageStatePath) {
  if (!storageStatePath) {
    return undefined;
  }

  try {
    await fs.access(storageStatePath);
    return storageStatePath;
  } catch {
    return undefined;
  }
}

async function ensureParentDir(filePath) {
  if (!filePath) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function createScraperSession({
  userDataDir,
  storageStatePath,
  headless = false,
  slowMo = 0
}) {
  const mode = resolveBrowserMode();

  if (mode === "browserless") {
    const endpoint = resolveBrowserlessEndpoint();
    const browser = await chromium.connectOverCDP(endpoint);
    const storageState = await loadStorageState(storageStatePath);

    const context = await browser.newContext(
      storageState ? { storageState } : {}
    );
    const page = await context.newPage();

    return {
      mode,
      page,
      context,
      browser,
      async persistAuthState() {
        if (!storageStatePath) {
          return;
        }

        await ensureParentDir(storageStatePath);
        await context.storageState({ path: storageStatePath });
      },
      async close() {
        await context.close();
        await browser.close();
      }
    };
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    slowMo
  });
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    mode,
    page,
    context,
    browser: null,
    async persistAuthState() {},
    async close() {
      await context.close();
    }
  };
}
