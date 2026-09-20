import { healthCheckController } from "../controllers/healthController.js";
import {
  authenticateScraperController,
  getRunStatusController,
  listScrapersController,
  runScraperController
} from "../controllers/scraperController.js";
import { refreshCabinsController, refreshCabinsStatusController } from "../controllers/refreshCabinsController.js";
import {
  authCheckAllController,
  authCheckVendorController,
  vendorLastRunsController
} from "../controllers/authCheckController.js";
import { getScheduleConfig } from "../jobs/scheduler.js";
import { clearActiveRun, getActiveRuns } from "../services/vendorScrapeService.js";
import {
  listItinerariesController,
  createItineraryController,
  updateItineraryController,
  deleteItineraryController
} from "../controllers/itineraryController.js";

export const routes = [
  {
    method: "GET",
    path: /^\/health$/,
    controller: healthCheckController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/auth\/check$/,
    controller: authCheckAllController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/auth\/check\/(?<vendorKey>[^/]+)$/,
    controller: authCheckVendorController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/vendors\/last-runs$/,
    controller: vendorLastRunsController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/schedule$/,
    controller: async () => ({ statusCode: 200, body: { ok: true, schedules: getScheduleConfig() } }),
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/scrapers$/,
    controller: listScrapersController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/active-runs$/,
    controller: async () => ({ statusCode: 200, body: { ok: true, activeRuns: getActiveRuns() } }),
    authRequired: false
  },
  {
    method: "DELETE",
    path: /^\/api\/active-runs\/(?<vendorKey>[^/]+)$/,
    controller: async ({ params }) => { clearActiveRun(params.vendorKey); return { statusCode: 200, body: { ok: true, cleared: params.vendorKey } }; },
    authRequired: false
  },
  {
    method: "POST",
    path: /^\/api\/(?<vendorKey>[^/]+)\/authentication$/,
    controller: authenticateScraperController,
    authRequired: true
  },
  {
    method: "POST",
    path: /^\/api\/(?<vendorKey>[^/]+)\/run$/,
    controller: runScraperController,
    authRequired: true
  },
  {
    method: "POST",
    path: /^\/api\/scrapers\/(?<vendorKey>[^/]+)\/run$/,
    controller: runScraperController,
    authRequired: true
  },
  {
    method: "GET",
    path: /^\/api\/runs\/(?<runId>\d+)$/,
    controller: getRunStatusController,
    authRequired: true
  },
  {
    method: "POST",
    path: /^\/api\/cruises\/(?<code>[^/]+)\/refresh-cabins$/,
    controller: refreshCabinsController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/cruises\/(?<code>[^/]+)\/refresh-status$/,
    controller: refreshCabinsStatusController,
    authRequired: false
  },
  {
    method: "GET",
    path: /^\/api\/itineraries$/,
    controller: listItinerariesController,
    authRequired: false
  },
  {
    method: "POST",
    path: /^\/api\/itineraries$/,
    controller: createItineraryController,
    authRequired: false
  },
  {
    method: "PATCH",
    path: /^\/api\/itineraries\/(?<id>\d+)$/,
    controller: updateItineraryController,
    authRequired: false
  },
  {
    method: "DELETE",
    path: /^\/api\/itineraries\/(?<id>\d+)$/,
    controller: deleteItineraryController,
    authRequired: false
  },
  {
    method: "POST",
    path: /^\/api\/admin\/wipe-vendor\/(?<slug>[^/]+)$/,
    controller: async ({ params }) => {
      const { PrismaClient } = await import("@prisma/client");
      const db = new PrismaClient();
      try {
        const vendor = await db.vendor.findUnique({ where: { slug: params.slug } });
        if (!vendor) return { statusCode: 404, body: { ok: false, error: "Vendor not found" } };
        const cruises = await db.cruise.findMany({ where: { vendorId: vendor.id }, select: { id: true } });
        const ids = cruises.map(c => c.id);
        const cats = ids.length ? await db.cabinCategory.findMany({ where: { cruiseId: { in: ids } }, select: { id: true } }) : [];
        const catIds = cats.map(c => c.id);
        if (catIds.length) {
          await db.cabinPromotion.deleteMany({ where: { cabinCategoryId: { in: catIds } } });
          await db.cabin.deleteMany({ where: { cabinCategoryId: { in: catIds } } });
          await db.cabinCategory.deleteMany({ where: { id: { in: catIds } } });
        }
        if (ids.length) {
          await db.cruisePromotion.deleteMany({ where: { cruiseId: { in: ids } } });
          await db.itineraryStop.deleteMany({ where: { cruiseId: { in: ids } } });
          await db.cruiseTag.deleteMany({ where: { cruiseId: { in: ids } } });
          await db.cruise.deleteMany({ where: { id: { in: ids } } });
        }
        await db.vendorRun.deleteMany({ where: { vendorId: vendor.id } });
        return { statusCode: 200, body: { ok: true, deleted: { cruises: ids.length, categories: catIds.length } } };
      } finally { await db.$disconnect(); }
    },
    authRequired: false
  }
];

export function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const match = pathname.match(route.path);

    if (match) {
      return {
        ...route,
        params: match.groups ?? {}
      };
    }
  }

  return null;
}
