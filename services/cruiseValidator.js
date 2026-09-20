export function validateScraperPayload(result) {
  if (!result || !Array.isArray(result.cruises)) {
    throw new Error("Scraper result must include a cruises array.");
  }

  return result;
}
