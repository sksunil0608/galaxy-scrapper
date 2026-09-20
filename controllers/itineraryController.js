import prisma from "../config/prisma.js";

// GET /api/itineraries?ship=<name>&cruiseId=<id>
// Lists reference itinerary rows imported from Book1.xlsx. Filter by ship
// name (partial, case-insensitive) and/or by which Cruise they're linked to.
export async function listItinerariesController({ query }) {
  const where = {};
  if (query?.ship) where.shipName = { contains: query.ship };
  if (query?.cruiseId) where.cruiseId = Number(query.cruiseId);
  if (query?.unlinked === "true") where.cruiseId = null;

  const rows = await prisma.shipItineraryReference.findMany({
    where,
    orderBy: [{ shipName: "asc" }, { id: "asc" }],
    take: 500
  });

  return { statusCode: 200, body: { ok: true, count: rows.length, itineraries: rows } };
}

// PATCH /api/itineraries/:id  body: { cruiseId: number | null, route?, itinerary?, nights?, dealsLink?, price? }
// Link a reference row to a real scraped Cruise, or edit its fields.
export async function updateItineraryController({ params, body }) {
  const id = Number(params.id);
  if (!id) return { statusCode: 400, body: { ok: false, error: "Invalid id" } };

  const existing = await prisma.shipItineraryReference.findUnique({ where: { id } });
  if (!existing) return { statusCode: 404, body: { ok: false, error: "Itinerary reference not found" } };

  if (body?.cruiseId !== undefined && body.cruiseId !== null) {
    const cruise = await prisma.cruise.findUnique({ where: { id: Number(body.cruiseId) } });
    if (!cruise) return { statusCode: 400, body: { ok: false, error: `Cruise ${body.cruiseId} not found` } };
  }

  const data = {};
  for (const key of ["route", "itinerary", "nights", "dealsLink", "price"]) {
    if (body?.[key] !== undefined) data[key] = body[key];
  }
  if (body?.cruiseId !== undefined) data.cruiseId = body.cruiseId === null ? null : Number(body.cruiseId);

  const updated = await prisma.shipItineraryReference.update({ where: { id }, data });
  return { statusCode: 200, body: { ok: true, itinerary: updated } };
}

// DELETE /api/itineraries/:id
export async function deleteItineraryController({ params }) {
  const id = Number(params.id);
  if (!id) return { statusCode: 400, body: { ok: false, error: "Invalid id" } };

  const existing = await prisma.shipItineraryReference.findUnique({ where: { id } });
  if (!existing) return { statusCode: 404, body: { ok: false, error: "Itinerary reference not found" } };

  await prisma.shipItineraryReference.delete({ where: { id } });
  return { statusCode: 200, body: { ok: true, deleted: id } };
}

// POST /api/itineraries  body: { shipName, route?, itinerary?, nights?, dealsLink?, price?, cruiseId? }
// Manually add a new reference row (for ships/routes not in the original Book1.xlsx import).
export async function createItineraryController({ body }) {
  if (!body?.shipName) return { statusCode: 400, body: { ok: false, error: "shipName is required" } };

  if (body.cruiseId != null) {
    const cruise = await prisma.cruise.findUnique({ where: { id: Number(body.cruiseId) } });
    if (!cruise) return { statusCode: 400, body: { ok: false, error: `Cruise ${body.cruiseId} not found` } };
  }

  const created = await prisma.shipItineraryReference.create({
    data: {
      shipName:  body.shipName,
      route:     body.route ?? null,
      itinerary: body.itinerary ?? null,
      nights:    body.nights ?? null,
      dealsLink: body.dealsLink ?? null,
      price:     body.price ?? null,
      cruiseId:  body.cruiseId != null ? Number(body.cruiseId) : null
    }
  });

  return { statusCode: 201, body: { ok: true, itinerary: created } };
}
