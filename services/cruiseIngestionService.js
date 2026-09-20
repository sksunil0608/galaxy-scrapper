import prisma from "../config/prisma.js";
import { assignStaticItinerary } from "./staticItineraryService.js";

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function uniqueNames(values = []) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickShipDetails(payload = {}) {
  const p = payload ?? {};
  return {
    image: p.image ?? undefined,
    cabins: normalizeInteger(p.cabins),
    restaurants: normalizeInteger(p.restaurants),
    bars: normalizeInteger(p.bars),
    pools: normalizeInteger(p.pools),
    jacuzzis: normalizeInteger(p.jacuzzis),
    guests: normalizeInteger(p.guests),
    crew: normalizeInteger(p.crew),
    balconyCabins: normalizeInteger(p.balconyCabins),
    suites: normalizeInteger(p.suites),
    spa: p.spa ?? undefined
  };
}

function deriveTrend(currentValue, previousValue) {
  if (
    currentValue === null ||
    currentValue === undefined ||
    previousValue === null ||
    previousValue === undefined
  ) {
    return "stable";
  }

  if (currentValue > previousValue) {
    return "up";
  }

  if (currentValue < previousValue) {
    return "down";
  }

  return "stable";
}

function deriveCruiseConfidence(cruise) {
  if ((cruise.cabinCategories?.length ?? 0) > 0) {
    return "Medium";
  }

  return "Low";
}

function deriveCabinConfidence(cabin) {
  if (
    cabin.totalCabins !== null &&
    cabin.totalCabins !== undefined &&
    cabin.avail !== null &&
    cabin.avail !== undefined &&
    cabin.cabinPrice !== null &&
    cabin.cabinPrice !== undefined
  ) {
    return "High";
  }

  if (cabin.cabinPrice !== null && cabin.cabinPrice !== undefined) {
    return "Medium";
  }

  // Individual cabin numbers present = real wizard data, treat as Medium
  if ((cabin.cabins?.length ?? 0) > 0) {
    return "Medium";
  }

  return "Low";
}

function getLowestAvailablePrice(cruise) {
  const prices = (cruise?.cabinCategories ?? [])
    .filter((cabin) => cabin?.avlResult === "OK")
    .map((cabin) => normalizeDecimal(cabin?.cabinPrice))
    .filter((value) => value !== null && value > 0);

  if (prices.length === 0) {
    return null;
  }

  return Math.min(...prices);
}

async function syncTagPriceTracking(cruiseId, currentPrice, currency, existingTags = []) {
  for (const tag of existingTags) {
    const previousLowest = normalizeDecimal(tag.trackedLowestPrice);
    const nextLastSeenPrice = currentPrice;

    if (currentPrice === null) {
      await prisma.cruiseTag.update({
        where: { id: tag.id },
        data: {
          lastSeenPrice: null
        }
      });
      continue;
    }

    if (previousLowest === null) {
      await prisma.cruiseTag.update({
        where: { id: tag.id },
        data: {
          trackedLowestPrice: currentPrice,
          lastSeenPrice: nextLastSeenPrice
        }
      });
      continue;
    }

    if (currentPrice < previousLowest) {
      await prisma.$transaction([
        prisma.cruiseTag.update({
          where: { id: tag.id },
          data: {
            trackedLowestPrice: currentPrice,
            lastSeenPrice: nextLastSeenPrice,
            lastPriceDropAt: new Date(),
            lastNotifiedPrice: currentPrice
          }
        }),
        prisma.cruiseTagAlert.create({
          data: {
            cruiseTagId: tag.id,
            cruiseId,
            previousPrice: previousLowest,
            currentPrice,
            currency: currency ?? null
          }
        })
      ]);
      continue;
    }

    await prisma.cruiseTag.update({
      where: { id: tag.id },
      data: {
        lastSeenPrice: nextLastSeenPrice
      }
    });
  }
}

export async function ensureVendor(vendorDefinition) {
  return prisma.vendor.upsert({
    where: { slug: vendorDefinition.slug },
    update: {
      name: vendorDefinition.name,
      url: vendorDefinition.url ?? null
    },
    create: {
      name: vendorDefinition.name,
      slug: vendorDefinition.slug,
      url: vendorDefinition.url ?? null
    }
  });
}

async function ensureShip(tx, cruise, vendorId) {
  const shipCode = cruise.shipCode ?? cruise.ship;

  if (!shipCode) {
    return null;
  }

  const shipDetails = pickShipDetails(cruise.shipDetails);

  return tx.ship.upsert({
    where: { code: shipCode },
    update: {
      name: cruise.ship ?? shipCode,
      vendorId,
      image: shipDetails.image,
      cabins: shipDetails.cabins,
      restaurants: shipDetails.restaurants,
      bars: shipDetails.bars,
      pools: shipDetails.pools,
      jacuzzis: shipDetails.jacuzzis,
      guests: shipDetails.guests,
      crew: shipDetails.crew,
      balconyCabins: shipDetails.balconyCabins,
      suites: shipDetails.suites,
      spa: shipDetails.spa
    },
    create: {
      code: shipCode,
      name: cruise.ship ?? shipCode,
      vendorId,
      image: shipDetails.image ?? null,
      cabins: shipDetails.cabins ?? null,
      restaurants: shipDetails.restaurants ?? null,
      bars: shipDetails.bars ?? null,
      pools: shipDetails.pools ?? null,
      jacuzzis: shipDetails.jacuzzis ?? null,
      guests: shipDetails.guests ?? null,
      crew: shipDetails.crew ?? null,
      balconyCabins: shipDetails.balconyCabins ?? null,
      suites: shipDetails.suites ?? null,
      spa: shipDetails.spa ?? null
    }
  });
}

function buildCruisePayload(cruise, vendorId, shipId, vendor = null, options = {}) {
  const cruiseLine = normalizeCruiseLineName(
    cruise.cruiseLine ?? (vendor && SINGLE_BRAND_VENDOR_SLUGS.has(vendor.slug) ? vendor.name : null)
  );

  // Only stamp cabinsUpdatedAt when this call is actually carrying new cabin
  // rows (buildCruiseGraphData). When categories are being intentionally kept
  // as-is (keepExistingCategories in ingestCruise), the incoming `cruise`
  // object's cabinCategories are the low-confidence list-only data, not the
  // retained real data — checking cruise.cabinCategories here would wrongly
  // read as "no real data" and erase a valid freshness timestamp.
  const hasRealCabinData = options.checkCabinData !== false
    && (cruise.cabinCategories ?? []).some((cat) => (cat.cabins ?? []).length > 0);

  return {
    code: cruise.id,
    vendorId,
    shipId,
    ship: cruise.ship ?? null,
    shipCode: cruise.shipCode ?? null,
    cruiseLine,
    package: (cruise.package ?? null)?.slice(0, 191) ?? null,
    routeLabel: cruise.routeLabel ?? null,
    portFrom: cruise.portFrom ?? null,
    portTo: cruise.portTo ?? null,
    nights: normalizeInteger(cruise.nights),
    startDate: normalizeDate(cruise.startDate),
    endDate: normalizeDate(cruise.endDate),
    trend: cruise.trend ?? null,
    confidence: cruise.confidence ?? null,
    pinned: Boolean(cruise.pinned),
    currency: cruise.currency ?? null,
    ...(hasRealCabinData ? { cabinsUpdatedAt: new Date() } : {})
  };
}

function mapCategoryToGroup(code) {
  if (!code) return "Other";
  const c = String(code).toUpperCase();
  if (c.startsWith("H") || c.startsWith("S")) return "Suite";
  if (c.startsWith("M") || c.startsWith("B")) return "Balcony";
  if (c.startsWith("O")) return "Exterior";
  if (c.startsWith("I")) return "Interior";
  return "Other";
}

// The Cabin table has a unique (cabinCategoryId, cabinNumber) constraint —
// some vendors (confirmed: MSC) can return the same cabin number twice within
// one category's deck-fetch response, which crashes the whole nested create.
// Keep the last occurrence (most likely the freshest data for that cabin).
function dedupeByCabinNumber(rows) {
  const byCabinNumber = new Map(rows.map((r) => [r.cabinNumber, r]));
  return [...byCabinNumber.values()];
}

function buildCabinCategoryCreateInput(cabin, includeCabins = false) {
  const cabinRows = includeCabins
    ? dedupeByCabinNumber(
        (cabin.cabins ?? [])
          .filter(c => c?.cabinNumber)
          .map(c => ({
            cabinNumber: String(c.cabinNumber),
            deckNumber:  c.deckNumber  ?? null,
            deckName:    c.deckName    ?? null,
            capacity:    normalizeInteger(c.capacity),
            status:      c.status      ?? null
          }))
      )
    : [];

  return {
    code: cabin.code,
    name: cabin.name,
    group: cabin.group ?? mapCategoryToGroup(cabin.code),
    status: cabin.status ?? null,
    avlResult: cabin.avlResult ?? null,
    totalCabins: normalizeInteger(cabin.totalCabins ?? cabin.total),
    available: normalizeInteger(cabin.avail ?? cabin.available),
    cabinPrice: cabin.cabinPrice ?? null,
    perPersonPrice: cabin.perPersonPrice ?? null,
    capacity: normalizeInteger(cabin.capacity),
    trend: cabin.trend ?? null,
    confidence: cabin.confidence ?? null,
    promotions: {
      create: uniqueNames(cabin.promos).map((name) => ({ name }))
    },
    cabins: {
      create: cabinRows
    }
  };
}

function buildCruiseGraphData(cruise, vendorId, shipId, vendor = null) {
  return {
    ...buildCruisePayload(cruise, vendorId, shipId, vendor),
    promotions: {
      create: uniqueNames(cruise.promotions).map((name) => ({ name }))
    },
    cabinCategories: {
      create: (cruise.cabinCategories ?? []).map(cat => buildCabinCategoryCreateInput(cat, true))
    },
    itineraryStops: {
      create: (cruise.itineraryStops ?? []).map((stop, i) => ({
        day:      stop.day      ?? null,
        date:     stop.date     ? normalizeDate(stop.date) : null,
        time:     stop.time     ?? null,
        activity: stop.activity ?? null,
        port:     stop.port     ?? null,
        country:  stop.country  ?? null,
        order:    stop.order    ?? i
      }))
    }
  };
}

// Vendors whose portal is a single-brand cruise line — the vendor name IS the
// cruise line when the scraper doesn't set one explicitly. Multi-brand agent
// portals (CCS A/B, GoHal, CruisingPower) must NOT be listed here — they set
// cruiseLine themselves from an actual brand code, and defaulting to the
// vendor/portal name would be wrong (e.g. CruisingPower serves Royal Caribbean
// AND Celebrity, not "CruisingPower").
const SINGLE_BRAND_VENDOR_SLUGS = new Set([
  "msc", "celestyal", "azamara", "goccl", "seawebagents", "firstmates"
]);

// Central place to configure how each vendor's raw brand code/name becomes the
// display name stored in cruiseLine. Multi-brand portals set cruise.cruiseLine
// themselves from a raw code (CCS: "PO"/"CUNARD"/"PRINCESS"; GoHal: "HA"/"CU"/"SB")
// — this map normalizes those codes to proper display names in one place instead
// of hardcoding strings inside each scraper. Add new brand codes here as vendors
// are added/expanded; scrapers should keep passing their raw code unchanged.
const CRUISE_LINE_DISPLAY_NAMES = {
  // CCS A/B (POLAR) brand codes
  PO: "P&O Cruises",
  CUNARD: "Cunard Line",
  PRINCESS: "Princess Cruises",
  // GoHal (POLAR MXTO) company codes
  HA: "Holland America Line",
  CU: "Cunard Line",
  SB: "Seabourn Cruise Line",
};

function normalizeCruiseLineName(raw) {
  if (!raw) return raw ?? null;
  return CRUISE_LINE_DISPLAY_NAMES[raw] ?? raw;
}

export async function ingestCruise(vendorId, cruise, vendor = null) {
  const ship = await ensureShip(prisma, cruise, vendorId);
  const existingCruise = await prisma.cruise.findUnique({
    where: { vendorId_code: { vendorId, code: cruise.id } },
    include: {
      tags: true,
      cabinCategories: {
        include: { _count: { select: { cabins: true } } }
      }
    }
  });

  const previousCabinMap = new Map(
    (existingCruise?.cabinCategories ?? []).map((category) => [category.code, category])
  );

  const nextCruise = {
    ...cruise,
    trend: deriveTrend(
      normalizeInteger((cruise.cabinCategories ?? []).filter(c => c.avlResult === "OK").length),
      normalizeInteger((existingCruise?.cabinCategories ?? []).filter(c => c.avlResult === "OK").length)
    ),
    confidence: cruise.confidence ?? deriveCruiseConfidence(cruise),
    cabinCategories: (cruise.cabinCategories ?? []).map((cabin) => {
      const previousCabin = previousCabinMap.get(cabin.code);

      return {
        ...cabin,
        trend: cabin.trend ?? deriveTrend(normalizeInteger(cabin.avail ?? cabin.available), previousCabin?.available ?? null),
        confidence: cabin.confidence ?? deriveCabinConfidence(cabin)
      };
    })
  };

  // If the existing cruise already has Medium/High confidence category data (from
  // a "Get Full Details" fetch), don't downgrade it with the incoming Low confidence
  // lead-in prices from a list-only scrape. Keep the existing categories and only
  // update the cruise-level fields (price, availability, etc.).
  const existingHasDetailedData = (existingCruise?.cabinCategories ?? []).some(
    c => c.confidence === "Medium" || c.confidence === "High" || (c._count?.cabins ?? 0) > 0
  );
  // What actually distinguishes a list-only scrape is that it carries no cabin
  // rows — not its confidence. Several vendors (Celestyal, GOCCL) label
  // list-stage categories Medium because they do have lead-in prices, which
  // made this read as "the incoming data is detailed too" and let a plain list
  // run delete real cabin numbers. Cabin-bearing rows are the thing worth
  // protecting, so key the decision on those.
  const incomingHasCabins = (nextCruise.cabinCategories ?? []).some(
    c => (c.cabins ?? []).length > 0
  );
  const keepExistingCategories = existingHasDetailedData && !incomingHasCabins;

  const data = keepExistingCategories
    ? buildCruisePayload(nextCruise, vendorId, ship?.id ?? null, vendor, { checkCabinData: false }) // cruise fields only, no categories — existing cabin data (and its freshness stamp) is being kept as-is
    : buildCruiseGraphData(nextCruise, vendorId, ship?.id ?? null, vendor);
  const currentLowestPrice = getLowestAvailablePrice(nextCruise);

  if (existingCruise) {
    if (keepExistingCategories) {
      // Only update cruise-level fields — leave existing Medium/High confidence categories intact
      await prisma.cruise.update({
        where: { id: existingCruise.id },
        data: { ...data, confidence: existingCruise.confidence ?? data.confidence }
      });

      // Stops live outside the category graph, so protecting cabins must not
      // also freeze the itinerary: a list-only run is exactly the pass that
      // carries fresh stops (GOCCL fetches them per sailing without touching
      // the deck wizard). Replace them when this run actually brought some.
      if ((nextCruise.itineraryStops ?? []).length > 0) {
        await prisma.itineraryStop.deleteMany({ where: { cruiseId: existingCruise.id } });
        await prisma.itineraryStop.createMany({
          data: nextCruise.itineraryStops.map((stop, i) => ({
            cruiseId: existingCruise.id,
            day:      stop.day      ?? null,
            date:     stop.date     ? normalizeDate(stop.date) : null,
            time:     stop.time     ?? null,
            activity: stop.activity ?? null,
            port:     stop.port     ?? null,
            country:  stop.country  ?? null,
            order:    stop.order    ?? i
          }))
        });
      }
    } else {
      const cabinCategoryIds = existingCruise.cabinCategories.map((category) => category.id);

      if (cabinCategoryIds.length > 0) {
        await prisma.cabinPromotion.deleteMany({
          where: { cabinCategoryId: { in: cabinCategoryIds } }
        });

        await prisma.cabin.deleteMany({
          where: { cabinCategoryId: { in: cabinCategoryIds } }
        });
      }

      await prisma.$transaction([
        prisma.itineraryStop.deleteMany({
          where: { cruiseId: existingCruise.id }
        }),
        prisma.cabinCategory.deleteMany({
          where: { cruiseId: existingCruise.id }
        }),
        prisma.cruisePromotion.deleteMany({
          where: { cruiseId: existingCruise.id }
        }),
        prisma.cruise.update({
          where: { id: existingCruise.id },
          data
        })
      ]);
    }

    if ((existingCruise.tags?.length ?? 0) > 0) {
      await syncTagPriceTracking(
        existingCruise.id,
        currentLowestPrice,
        nextCruise.currency,
        existingCruise.tags
      );
    }

    // A non-keepExistingCategories update just wiped this cruise's stops
    // (see deleteMany above) — assignStaticItinerary no-ops when stops
    // already exist, so this is a cheap way to keep them backfilled either way.
    await assignStaticItinerary({
      id: existingCruise.id,
      ship: nextCruise.ship,
      portFrom: nextCruise.portFrom,
      portTo: nextCruise.portTo,
      nights: nextCruise.nights
    }).catch((err) => console.error(`[static-itinerary] assign failed for cruise ${existingCruise.id}:`, err.message));
  } else {
    const createdCruise = await prisma.cruise.create({
      data
    });

    await assignStaticItinerary({
      id: createdCruise.id,
      ship: nextCruise.ship,
      portFrom: nextCruise.portFrom,
      portTo: nextCruise.portTo,
      nights: nextCruise.nights
    }).catch((err) => console.error(`[static-itinerary] assign failed for cruise ${createdCruise.id}:`, err.message));

    if (createdCruise && currentLowestPrice !== null) {
      const createdCruiseWithTags = await prisma.cruise.findUnique({
        where: { id: createdCruise.id },
        include: {
          tags: true
        }
      });

      if ((createdCruiseWithTags?.tags?.length ?? 0) > 0) {
        await syncTagPriceTracking(
          createdCruise.id,
          currentLowestPrice,
          nextCruise.currency,
          createdCruiseWithTags.tags
        );
      }
    }
  }

  return {
    shipCode: ship?.code ?? cruise.shipCode ?? null,
    cabinCategoriesSeen: nextCruise.cabinCategories?.length ?? 0
  };
}

export async function ingestCruisesForVendor(vendor, cruises, options = {}) {
  const { onProgress } = options;
  let savedCount = 0;
  let cabinCategoriesSeen = 0;
  const shipCodesSeen = new Set();

  for (const cruise of cruises) {
    if (!cruise?.id) {
      continue;
    }

    const result = await ingestCruise(vendor.id, cruise, vendor);

    savedCount += 1;
    cabinCategoriesSeen += result.cabinCategoriesSeen;

    if (result.shipCode) {
      shipCodesSeen.add(result.shipCode);
    }

    if (savedCount % 25 === 0) {
      console.log(
        `[ingestion] saved ${savedCount}/${cruises.length} cruises for ${vendor.slug}`
      );
      await onProgress?.({
        savedCount,
        totalCruises: cruises.length
      });
    }
  }

  await onProgress?.({
    savedCount,
    totalCruises: cruises.length,
    completed: true
  });

  return {
    savedCount,
    shipsSeen: shipCodesSeen.size,
    cabinCategoriesSeen
  };
}

// Replace all cabin categories for a cruise without touching any other cruise fields.
// `code` is unique per vendor (not globally) — pass vendorSlug to disambiguate
// when the same voyage code exists under multiple vendors (CCS A/B, GoHAL).
export async function refreshCabinCategories(cruiseCode, cabinCategories, vendorSlug = null) {
  const cruise = await prisma.cruise.findFirst({
    where: vendorSlug
      ? { code: cruiseCode, vendor: { slug: vendorSlug } }
      : { code: cruiseCode },
    include: { cabinCategories: true }
  });

  if (!cruise) throw Object.assign(new Error(`Cruise not found: ${cruiseCode}`), { statusCode: 404 });

  const existingIds = cruise.cabinCategories.map((c) => c.id);

  if (existingIds.length > 0) {
    await prisma.cabinPromotion.deleteMany({ where: { cabinCategoryId: { in: existingIds } } });
    await prisma.cabin.deleteMany({ where: { cabinCategoryId: { in: existingIds } } });
    await prisma.cabinCategory.deleteMany({ where: { cruiseId: cruise.id } });
  }

  for (const cat of cabinCategories) {
    await prisma.cabinCategory.create({
      data: {
        ...buildCabinCategoryCreateInput(cat, true),
        cruiseId: cruise.id
      }
    });
  }

  await prisma.cruise.update({
    where: { id: cruise.id },
    data: { cabinsUpdatedAt: new Date() }
  });

  return prisma.cruise.findUnique({
    where: { id: cruise.id },
    include: {
      cabinCategories: {
        include: { cabins: true, promotions: true }
      }
    }
  });
}
