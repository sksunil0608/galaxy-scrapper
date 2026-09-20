import http from "node:http";
import { URL } from "node:url";
import { isAuthorized } from "./middleware/authMiddleware.js";
import { matchRoute } from "./routes/index.js";
import { readJsonBody, sendJson, sendNoContent } from "./utils/http.js";

export function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const route = matchRoute(request.method, requestUrl.pathname);

    try {
      if (request.method === "OPTIONS") {
        sendNoContent(response);
        return;
      }

      if (!route) {
        sendJson(response, 404, {
          ok: false,
          error: "Route not found"
        });
        return;
      }

      if (route.authRequired && !isAuthorized(request)) {
        sendJson(response, 401, {
          ok: false,
          error: "Unauthorized"
        });
        return;
      }

      const body =
        ["POST", "PATCH", "PUT"].includes(request.method) ? await readJsonBody(request) : {};

      const result = await route.controller({
        request,
        response,
        params: route.params,
        body,
        query: Object.fromEntries(requestUrl.searchParams.entries())
      });

      sendJson(response, result.statusCode, result.body);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, {
        ok: false,
        error: error.message
      });
    }
  });
}
