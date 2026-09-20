// Port-by-port itinerary for Celestyal sailings.
//
// The booking API's /rest/availability/pkgs response has a portsVal array, but
// it comes back empty for every sailing — verified across 75/75 and 25/25 in
// two separate probes. Clicking "View Itinerary" in the UI fires no network
// call at all, because the app renders it from a CMS document pulled once per
// session:
//
//   GET /jease/clst/descriptions/pkgtypes-descriptions
//
// That document is tagged text, one block per package type:
//
//   <pkg:CO_3DICONIC>
//     <h3>Athens | Mykonos | Kusadasi | Patmos | Heraklion | Santorini</h3>
//     <p>…marketing copy…</p>
//
// The <h3> line is the itinerary. Blocks are keyed <shipPrefix>_<packageType>,
// and a sailing's package type is its pkg.destinationsVal[0].

const CMS_URL = "https://sale.celestyal.com/jease/clst/descriptions/pkgtypes-descriptions";

// Some blocks are unfinished in the CMS ("xxxx | xxxx | xxxx"). Treating those
// as real stops would write placeholder ports into the DB.
const PLACEHOLDER = /^x{2,}$/i;

// destinationsVal codes don't always match the CMS key exactly:
//   4DICONICWINTER -> CO_4DICONIC-WINTER  (punctuation)
//   IDYLLIC26      -> CC_IDYLIC           (spelling + year suffix)
// Normalising away punctuation and a trailing year covers the first class;
// the second needs a explicit alias.
const CODE_ALIASES = {
  IDYLLIC: "IDYLIC"
};

// The availability API reports embark/debark as port codes while the CMS spells
// out names, so the two can't be compared directly. PIR (Piraeus) and LAV
// (Lavrion) are both Athens-area ports — the CMS itself writes one of them as
// "Athens (Lavrion)".
const PORT_CODE_NAMES = {
  PIR: "athens",
  LAV: "athens",
  KUS: "kusadasi",
  TAR: "tarragona",
  LIS: "lisbon"
};

function normalizePortName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const byCode = PORT_CODE_NAMES[raw.toUpperCase()];
  if (byCode) return byCode;
  // "Athens (Lavrion)" / "Athens, Greece" -> "athens"
  return raw.split(/[(,]/)[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCode(code) {
  let s = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  s = s.replace(/(20)?\d{2}$/, ""); // drop a trailing year like "26" / "2026"
  for (const [from, to] of Object.entries(CODE_ALIASES)) {
    if (s.includes(from)) s = s.replace(from, to);
  }
  return s;
}

/**
 * Parse the CMS document into { normalizedPackageCode: [{ prefix, ports }] }.
 * Multiple ships can publish the same package type, so entries are grouped and
 * the caller picks by ship prefix.
 */
export function parseItineraryDocument(text) {
  const byCode = new Map();

  const blocks = [...String(text ?? "").matchAll(
    /<pkg:([A-Za-z0-9_-]+)>([\s\S]*?)(?=<pkg:[A-Za-z0-9_-]+>|$)/g
  )];

  for (const [, rawKey, body] of blocks) {
    const heading = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!heading) continue;

    const ports = heading[1]
      .replace(/<[^>]+>/g, "")
      .split("|")
      .map(p => p.trim())
      .filter(Boolean);

    // A single-entry "list" is a title, not an itinerary.
    if (ports.length < 2) continue;
    if (ports.some(p => PLACEHOLDER.test(p))) continue;

    const underscore = rawKey.indexOf("_");
    const prefix = underscore > 0 ? rawKey.slice(0, underscore) : null;
    const suffix = underscore > 0 ? rawKey.slice(underscore + 1) : rawKey;

    const key = normalizeCode(suffix);
    if (!key) continue;

    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push({ prefix, ports });
  }

  return byCode;
}

export async function fetchItineraryMap(page) {
  const text = await page.evaluate(async url => {
    const res = await fetch(url, { credentials: "include" });
    return res.ok ? res.text() : "";
  }, CMS_URL);

  const map = parseItineraryDocument(text);
  console.log(`[celestyal] itinerary CMS: ${map.size} package types with port lists`);
  return map;
}

/**
 * Resolve a sailing's stops. `shipCode` disambiguates when several ships
 * publish the same package type (CC_IDYLIC vs CJ_IDYLIC differ slightly).
 * Returns [] when nothing matches, so callers can stay unconditional.
 */
export function buildItineraryStops(itineraryMap, { destinationCode, shipCode, portFrom = null, portTo = null }) {
  if (!itineraryMap || !destinationCode) return [];

  const entries = itineraryMap.get(normalizeCode(destinationCode));
  if (!entries || entries.length === 0) return [];

  const entry =
    entries.find(e => e.prefix && shipCode && e.prefix.toUpperCase() === String(shipCode).toUpperCase()) ??
    entries[0];

  let ports = entry.ports;

  // The CMS publishes ONE canonical port order per package type — always from
  // the line's home port — but the same loop is sold boarding at other points
  // in it (the 3-night Iconic loop departs both Lavrion and Kusadasi). Writing
  // the home-port order onto a Kusadasi departure gets the ports right and the
  // voyage wrong, so rotate the loop to start where this sailing actually does.
  const embark = normalizePortName(portFrom);
  if (embark) {
    const start = ports.findIndex(p => normalizePortName(p) === embark);
    if (start > 0) {
      ports = [...ports.slice(start), ...ports.slice(0, start)];
    }
    // The CMS lists each call once, so a round-trip's return leg is implicit —
    // "Athens | Mykonos | … | Santorini" for a sailing the vendor states both
    // departs from and returns to Athens. Close the loop whenever the sailing
    // says it ends where it started (whether or not we rotated above).
    if (
      start >= 0 &&
      normalizePortName(portTo) === embark &&
      normalizePortName(ports[ports.length - 1]) !== embark
    ) {
      ports = [...ports, ports[0]];
    }
  }

  // day/date are deliberately left null: the CMS lists ports in order but says
  // nothing about which calendar day each falls on, and cruises here include
  // sea days. Guessing day = index + 1 would be wrong for most sailings.
  return ports.map((port, i) => ({
    day: null,
    date: null,
    time: null,
    activity: null,
    port,
    country: null,
    order: i
  }));
}
