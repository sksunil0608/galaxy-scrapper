import { listScrapers } from "../scrapers/registry.js";
import {
  authenticateVendor,
  getVendorRun,
  triggerVendorScrape
} from "../services/vendorScrapeService.js";

export async function listScrapersController() {
  return {
    statusCode: 200,
    body: {
      items: listScrapers()
    }
  };
}

export async function authenticateScraperController({ params, body }) {
  const result = await authenticateVendor(params.vendorKey, body);

  return {
    statusCode: 200,
    body: {
      ok: true,
      result
    }
  };
}

export async function runScraperController({ params, body }) {
  const result = await triggerVendorScrape(params.vendorKey, body);

  return {
    statusCode: 202,
    body: {
      ok: true,
      result
    }
  };
}

export async function getRunStatusController({ params }) {
  const runId = Number(params.runId);
  const result = await getVendorRun(runId);

  if (!result) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: "Run not found"
      }
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      result
    }
  };
}
