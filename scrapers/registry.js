import {
  authenticateCelestyal,
  runCelestyalScraper
} from "./celestyal/celestyal.js";
import {
  authenticateSeawebagents,
  runSeawebagentsScraper
} from "./seawebagents/seawebagents.js";
import { authenticateGoccl, runGocclScraper } from "./goccl/goccl.js";
import {
  authenticateCruisingPower,
  runCruisingPowerScraper
} from "./cruisingpower/cruisingpower.js";
import {
  authenticateCompleteCruiseSolutionA,
  runCompleteCruiseSolutionAScraper
} from "./completecruisesolution/completecruisesolutionA.js";
import {
  authenticateAzamara,
  runAzamaraScraper
} from "./azamara/azamara.js";
import {
  authenticateGohal,
  runGohalScraper
} from "./gohal/gohal.js";
import {
  authenticateCompleteCruiseSolutionB,
  runCompleteCruiseSolutionBScraper
} from "./completecruisesolution/completecruisesolutionB.js";
import { authenticateMsc, runMscScraper } from "./msc/msc.js";
import { authenticateFirstMates, runFirstMatesScraper } from "./firstmates/firstmates.js";

export const scraperRegistry = {
  celestyal: {
    key: "celestyal",
    name: "Celestyal",
    slug: "celestyal",
    url: "https://sale.celestyal.com",
    authenticate: authenticateCelestyal,
    run: runCelestyalScraper
  },
  seawebagents: {
    key: "seawebagents",
    name: "Seawebagents",
    slug: "seawebagents",
    url: "https://seawebagents.ncl.com/Security/login/",
    authenticate: authenticateSeawebagents,
    run: runSeawebagentsScraper
  },
  goccl: {
    key: "goccl",
    name: "GOCCL",
    slug: "goccl",
    url: "https://www.goccl.co.uk/",
    authenticate: authenticateGoccl,
    run: runGocclScraper
  },
  cruisingpower: {
    key: "cruisingpower",
    name: "CruisingPower",
    slug: "cruisingpower",
    url: "https://secure.cruisingpower.com",
    authenticate: authenticateCruisingPower,
    run: runCruisingPowerScraper
  },
  completecruisesolutionA: {
    key: "completecruisesolutionA",
    name: "Complete Cruise Solution A",
    slug: "completecruisesolutionA",
    url: "https://www.completecruisesolution.com/",
    authenticate: authenticateCompleteCruiseSolutionA,
    run: runCompleteCruiseSolutionAScraper
  },
  completecruisesolutionB: {
    key: "completecruisesolutionB",
    name: "Complete Cruise Solution B",
    slug: "completecruisesolutionB",
    url: "https://www.completecruisesolution.com/",
    authenticate: authenticateCompleteCruiseSolutionB,
    run: runCompleteCruiseSolutionBScraper
  },
  azamara: {
    key: "azamara",
    name: "Azamara",
    slug: "azamara",
    url: "https://seaware.azamara.com/",
    authenticate: authenticateAzamara,
    run: runAzamaraScraper
  },
  gohal: {
    key: "gohal",
    name: "Holland America (gohal)",
    slug: "gohal",
    url: "https://gohal.com/",
    authenticate: authenticateGohal,
    run: runGohalScraper
  },
  msc: {
    key: "msc",
    name: "MSC Cruises",
    slug: "msc",
    url: "https://www.mscbook.com/uk/home",
    authenticate: authenticateMsc,
    run: runMscScraper
  },
  firstmates: {
    key: "firstmates",
    name: "FirstMates",
    slug: "firstmates",
    url: "https://www.firstmates.com/",
    authenticate: authenticateFirstMates,
    run: runFirstMatesScraper
  }
};

export function getScraperDefinition(vendorKey) {
  return scraperRegistry[vendorKey] ?? null;
}

export function listScrapers() {
  return Object.values(scraperRegistry).map((scraper) => ({
    key: scraper.key,
    name: scraper.name,
    slug: scraper.slug,
    url: scraper.url
  }));
}
