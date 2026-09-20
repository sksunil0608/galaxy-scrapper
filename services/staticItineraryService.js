// Static itinerary matching — assigns port-by-port stops from the
// StaticItinerary reference table (imported from Book1.xlsx) to scraped
// cruises, so the dashboard can show stops without the slow per-cruise
// itinerary fetch. Matching runs once at ingestion time and writes physical
// ItineraryStop rows; page loads read those rows exactly as before, so there
// is zero query-time cost.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeShip(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// DB ship names that don't equal the Book1 full name after normalization.
// Keyed by the *exact* DB ship string (uppercased) so e.g. GoHal's Seabourn
// "QUEST" doesn't collide with Azamara Quest.
const SHIP_ALIASES = {
  // Azamara vendor stores bare codes
  "JR": "azamarajourney",
  "QS": "azamaraquest",
  "ON": "azamaraonward",
  "PU": "azamarapursuit",
  // Cunard short names (CCS A/B and GoHal portals)
  "VICTORIA": "queenvictoria",
  "QM2": "queenmary2",
  "ANNE": "queenanne",
  "ELIZABETH": "queenelizabeth",
  // Princess short names (CCS A/B)
  "CARIBBEAN": "caribbeanprincess",
  "STAR": "starprincess",
  "RUBY": "rubyprincess",
  "EMERALD": "emeraldprincess",
  "ENCHANTED": "enchantedprincess",
  "CORAL": "coralprincess",
  "ISLAND": "islandprincess",
  // GoHal truncates Holland America names at 9 chars
  "KONINGSDA": "koningsdam",
  "NIEUW-STA": "nieuwstatendam",
  "EURODAM-": "eurodam",
  "NOORDAM-": "noordam",
  "VOLENDAM-": "volendam",
  "NIEUW-AMS": "nieuwamsterdam",
  "ZAANDAM-": "zaandam",
  // GOCCL drops the brand prefix on this one
  "MARDI GRAS": "carnivalmardigras",
};

export function shipKeyForCruise(shipName) {
  const alias = SHIP_ALIASES[String(shipName ?? "").trim().toUpperCase()];
  return alias ?? normalizeShip(shipName);
}

// Vendors write the same physical port under different labels — plain-name
// synonyms plus the port codes MSC (3-letter), GOCCL (3-letter) and Azamara
// (UN/LOCODE) store instead of city names.
// These are the seed defaults (also copied into the PortAlias table via the
// Itinerary Manager UI) — used only until loadPortAliasCache() populates
// portAliasCache from the DB. Editing PORT_ALIASES here still works for
// anyone running the matcher before the cache warms, but the DB is the
// source of truth once loaded — new aliases should be added via the UI.
const PORT_ALIASES = {
  civitavecchia: "rome",
  romecivitavecchia: "rome",
  civitavecchiarome: "rome",
  piraeus: "athens",
  piraeusathens: "athens",
  lavrionathens: "athens",
  lavrion: "athens",
  venicefusina: "venice",
  fusina: "venice",
  ravenna: "venice",
  southamptonlondon: "southampton",
  londonsouthampton: "southampton",
  livornoflorence: "florence",
  kingswharf: "bermuda",
  // MSC 3-letter codes
  kus: "kusadasi",
  nap: "naples",
  goa: "genoa",
  mrs: "marseille",
  cvv: "rome",
  liv: "livorno",
  lis: "lisbon",
  pmo: "palermo",
  // GOCCL / Carnival 3-letter codes
  bne: "brisbane",
  gal: "galveston",
  mia: "miami",
  pcv: "portcanaveral",
  lax: "longbeach",
  orf: "norfolk",
  sea: "seattle",
  syd: "sydney",
  jax: "jacksonville",
  nyc: "newyork",
  tpa: "tampa",
  msy: "neworleans",
  sfo: "sanfrancisco",
  bwi: "baltimore",
  // Azamara UN/LOCODEs
  itcvv: "rome",
  itfsa: "venice",
  iedub: "dublin",
  gbpme: "portsmouth",
  ptlis: "lisbon",
  isrey: "reykjavik",
  camtr: "montreal",
  gblei: "edinburgh",
  gbsou: "southampton",
  // CCS / POLAR short codes
  yvr: "vancouver",
  wh1: "whittier",
  ham: "hamburg",
  rom: "rome",
  tst: "trieste",
  // GoHal codes
  vap: "valparaiso",
  cpt: "capetown",
  bue: "buenosaires",
  hkg: "hongkong",
  hongkongcity: "hongkong",
  tyo: "tokyo",
  sxm: "philipsburg",
};

// DB-backed overrides, loaded by loadPortAliasCache(). Starts as a copy of
// the hardcoded defaults so normalizePort works even before the async cache
// warms (e.g. if called from a script that never awaits loadPortAliasCache).
let portAliasCache = { ...PORT_ALIASES };
// Tracked explicitly: the previous guard compared portAliasCache against
// PORT_ALIASES by identity, but the initial value above is a *copy*, so that
// check was true on the very first call and the DB rows were never read — every
// alias added through the Itinerary Manager was silently ignored.
let portAliasCacheLoaded = false;

export async function loadPortAliasCache(force = false) {
  if (portAliasCacheLoaded && !force) return portAliasCache;
  const rows = await prisma.portAlias.findMany();
  const next = { ...PORT_ALIASES };
  for (const row of rows) next[row.aliasKey] = row.canonical;
  portAliasCache = next;
  portAliasCacheLoaded = true;
  return portAliasCache;
}

export function normalizePort(name) {
  const key = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return portAliasCache[key] ?? key;
}

export function routeKey(portFrom, portTo) {
  return `${normalizePort(portFrom)}|${normalizePort(portTo)}`;
}

// ── Matching ──────────────────────────────────────────────────────────────────

// Score a static row against a cruise. Ship already matched via shipKey.
// Returns -1 to reject. BOTH route endpoints must match (directly or as the
// reversed sailing) — a nights-only or single-endpoint match assigns wrong
// itineraries far too often (confirmed on dry-run: an 11N Rome→Venice cruise
// picked up a Benoa→Hong Kong itinerary purely because nights were equal).
function scoreCandidate(cruise, row) {
  const cf = normalizePort(cruise.portFrom);
  const ct = normalizePort(cruise.portTo);
  const sf = normalizePort(row.portFrom);
  const st = normalizePort(row.portTo);
  if (!cf || !ct || !sf || !st) return -1;

  const direct = cf === sf && ct === st;
  const reversed = !direct && cf === st && ct === sf;
  if (!direct && !reversed) return -1;

  const bothNights = cruise.nights != null && row.nights != null;
  const diff = bothNights ? Math.abs(cruise.nights - row.nights) : null;
  const roundtrip = cf === ct;

  // Same home port hosts many different products — a 5N Southampton loop and
  // a 14N Southampton loop share endpoints but nothing else, so roundtrips
  // must agree on duration almost exactly. When the cruise has no nights at
  // all (MSC list data), endpoint identity is the only signal we have — allow
  // it rather than never matching that vendor. One-ways on the same endpoints
  // are usually the same route family; allow small drift.
  if (roundtrip && diff != null && diff > 2) return -1;
  if (!roundtrip && diff != null && diff > 3) return -1;

  let score = direct ? 10 : 8; // prefer same-direction over reversed
  if (diff != null) score += Math.max(0, 4 - diff);
  return score;
}

// Find the best StaticItinerary for a cruise; null when nothing is confident.
export function matchStaticItinerary(cruise, candidatesForShip) {
  if (!candidatesForShip || candidatesForShip.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const row of candidatesForShip) {
    const s = scoreCandidate(cruise, row);
    if (s > bestScore) { best = row; bestScore = s; }
  }
  return best;
}

// ── Assignment ────────────────────────────────────────────────────────────────

let staticCache = null; // Map<shipKey, row[]> — reference data, loaded once

export async function loadStaticCache(force = false) {
  if (staticCache && !force) return staticCache;
  const rows = await prisma.staticItinerary.findMany();
  staticCache = new Map();
  for (const row of rows) {
    if (!staticCache.has(row.shipKey)) staticCache.set(row.shipKey, []);
    staticCache.get(row.shipKey).push(row);
  }
  return staticCache;
}

// Assign static stops to one cruise (DB row with id/ship/portFrom/portTo/
// nights). No-op when the cruise already has stops or nothing matches.
// Returns the number of stops created.
export async function assignStaticItinerary(cruise) {
  const existing = await prisma.itineraryStop.count({ where: { cruiseId: cruise.id } });
  if (existing > 0) return 0;

  await loadPortAliasCache();
  const cache = await loadStaticCache();
  const match = matchStaticItinerary(cruise, cache.get(shipKeyForCruise(cruise.ship)));
  if (!match) return 0;

  const stops = Array.isArray(match.stops) ? match.stops : [];
  if (stops.length === 0) return 0;

  await prisma.itineraryStop.createMany({
    data: stops.map((port, i) => ({
      cruiseId: cruise.id,
      day: i + 1,
      port: String(port).trim(),
      activity: i === 0 ? "DEPART" : i === stops.length - 1 ? "ARRIVE-DOCK" : "PORT OF CALL",
      order: i,
    })),
  });
  return stops.length;
}
