// Day-by-day itinerary for GOCCL sailings.
//
// The cruise-search payload carries an `itineraryUrlData` object —
//   { durDays, embkCode, itinCode, sailDate, shipCode }
// — that nothing consumed, so itinerary stops fell back to matching the
// Book1.xlsx sheet (which covers barely half of GOCCL's sailings). Expanding a
// sailing's title in the booking engine fires the endpoint those params are
// actually for:
//
//   GET /app/bookingengine/api/v1.0/itinerary
//       ?duration=8&embarkationPortCode=MIA&itineraryCode=DS0
//       &sailDate=2026-08-01&shipCode=VA
//
// Its `schedule` array is the richest itinerary source of any vendor here —
// one entry per day with portCode, port, arrive/depart times, and sea days
// marked with a placeholder port ("Fun Day At Sea", portCode FS1).

const ITINERARY_URL = "https://www.goccl.com/app/bookingengine/api/v1.0/itinerary";

// Sea days come through as regular schedule rows with a marketing name in the
// port field. Recording that as a port would put "Fun Day At Sea" in the port
// column, so they're stored as an activity with no port instead.
const SEA_DAY = /\bat sea\b|\bsea day\b/i;

/** itineraryUrlData.sailDate is MMDDYYYY; the endpoint wants YYYY-MM-DD. */
function toIsoSailDate(raw) {
  const s = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function pickTime(entry) {
  // Port calls carry arrive and/or depart; prefer arrival, since that's what a
  // day's listing leads with.
  const raw = entry?.arrive?.hhmm ?? entry?.depart?.hhmm ?? null;
  return raw && raw !== "00:00" ? raw : null;
}

/**
 * Convert one itinerary response into ItineraryStop rows.
 * Returns [] for anything unusable so callers can stay unconditional.
 */
export function buildStopsFromItinerary(payload) {
  const schedule = payload?.schedule;
  if (!Array.isArray(schedule) || schedule.length === 0) return [];

  return schedule
    .filter(entry => !entry?.isExcluded)
    .map((entry, i) => {
      const portName = entry?.port ?? null;
      const isSeaDay = portName ? SEA_DAY.test(portName) : false;
      return {
        day: entry?.day ?? null,
        date: entry?.date?.iso8601 ?? null,
        time: isSeaDay ? null : pickTime(entry),
        activity: isSeaDay ? "At Sea" : null,
        port: isSeaDay ? null : portName,
        country: null,
        order: i
      };
    });
}

/**
 * Fetch one sailing's itinerary from inside an authenticated page context.
 * Returns null (never throws) so a single failure can't abort a bulk run.
 */
export async function fetchGocclItinerary(page, itineraryUrlData) {
  const d = itineraryUrlData ?? {};
  const sailDate = toIsoSailDate(d.sailDate);
  if (!sailDate || !d.itinCode || !d.shipCode) return null;

  const params = new URLSearchParams({
    duration: String(d.durDays ?? ""),
    embarkationPortCode: String(d.embkCode ?? ""),
    itineraryCode: String(d.itinCode),
    sailDate,
    shipCode: String(d.shipCode)
  });

  try {
    return await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
      if (!r.ok) return null;
      return r.json();
    }, `${ITINERARY_URL}?${params.toString()}`);
  } catch {
    return null;
  }
}

/**
 * Attach stops to every sailing that has itineraryUrlData. Mutates in place and
 * returns how many were filled, so the caller can log coverage.
 */
export async function enrichCruisesWithItineraries(page, cruises, { maxCruises = Infinity } = {}) {
  let filled = 0;
  let attempted = 0;

  for (const cruise of cruises) {
    if (attempted >= maxCruises) break;
    if ((cruise.itineraryStops ?? []).length > 0) continue;

    const urlData = cruise.rawPayload?.itineraryUrlData;
    if (!urlData) continue;

    attempted++;
    const payload = await fetchGocclItinerary(page, urlData);
    const stops = buildStopsFromItinerary(payload);
    if (stops.length > 0) {
      cruise.itineraryStops = stops;
      filled++;

      // The schedule is the authoritative route: the sailings feed only knows
      // the embark port plus a marketing region code, so one-way voyages
      // otherwise end up with no usable arrival port at all.
      // Take both ends from the schedule rather than the payload's
      // embarkationPortName: that field names the city ("Los Angeles") while
      // the schedule names the terminal ("Long Beach (Los Angeles)"), and
      // mixing the two makes a cruise's own route disagree with its stops.
      const calls = stops.filter(s => s.port);
      const embark = calls[0]?.port ?? null;
      const debark = calls[calls.length - 1]?.port ?? null;
      if (embark) cruise.portFrom = embark;
      if (debark) cruise.portTo = debark;
      if (embark && debark) cruise.routeLabel = `${embark} -> ${debark}`;
    }
  }

  return { filled, attempted };
}
