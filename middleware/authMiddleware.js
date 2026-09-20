import { appConfig } from "../config/app.js";

export function isAuthorized(request) {
  if (!appConfig.scraperApiToken) {
    return true;
  }

  const authHeader = request.headers.authorization ?? "";
  const apiKey = request.headers["x-api-key"] ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  return (
    apiKey === appConfig.scraperApiToken ||
    bearerToken === appConfig.scraperApiToken
  );
}
