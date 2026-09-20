// Open visible browser. YOU log in manually. Once you're on /in/welcome
// (or anywhere past login), the script persists the session and continues
// capturing network calls so we can drive a search and see the data flow.

import dotenv from "dotenv";
import { createScraperSession } from "../runtime.js";

dotenv.config();

const BASE_URL = "https://www.mscbook.com/";

async function main() {
  const session = await createScraperSession({
    userDataDir:      "./sessions/msc-user-data",
    storageStatePath: "./sessions/.auth/msc-storage.json",
    headless:         false,
    slowMo:           0
  });
  const { page } = session;

  // Capture all relevant network calls + sizes (skip analytics noise)
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("quantummetric") || u.includes("google-analytics") || u.includes("googletagmanager") || u.includes("doubleclick")) return;
    if (u.includes(".html") || u.includes("/api/") || u.includes("/search") ||
        u.includes("/availability") || u.includes("/cruises") || u.includes("/voyages") ||
        u.includes("/login") || u.includes("/auth") || u.includes("/sailing") || u.includes("/rates")) {
      const body = req.postData()?.slice(0, 200) || "";
      console.log(`>>> ${req.method()} ${u}${body ? " | body=" + body : ""}`);
    }
  });
  page.on("response", async (resp) => {
    const u = resp.url();
    if (u.includes("quantummetric") || u.includes("google-analytics") || u.includes("googletagmanager") || u.includes("doubleclick")) return;
    if (u.includes("/api/") || u.includes("/search") ||
        u.includes("/availability") || u.includes("/cruises") || u.includes("/voyages") || u.includes("/sailing") || u.includes("/rates")) {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("json") || ct.includes("html")) {
        try {
          const text = await resp.text();
          console.log(`<<< ${resp.status()} ${u} | ${ct.slice(0,30)} | ${text.length} bytes`);
        } catch {}
      }
    }
  });

  try {
    console.log("[msc] navigating to mscbook.com");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    console.log("\n[msc] PLEASE LOG IN MANUALLY in the visible browser.");
    console.log("[msc] After login + closing the Important Info popup, drive a cruise search.");
    console.log("[msc] All API/HTML calls will be logged here. Ctrl+C to stop.\n");

    // Wait for user to log in (URL changes away from welcome/home)
    await page.waitForURL((u) => u.toString().includes("/in/welcome") || u.toString().includes("/dashboard"), { timeout: 600000 }).catch(() => {});
    console.log("\n[msc] Detected login — URL:", page.url());
    await session.persistAuthState();
    console.log("[msc] session persisted");

    // Stay open for search exploration
    await new Promise(() => {});
  } finally {
    await session.close();
  }
}
main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
