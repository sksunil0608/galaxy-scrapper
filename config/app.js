import dotenv from "dotenv";

dotenv.config();

export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "*",
  scraperApiToken: process.env.SCRAPER_API_TOKEN ?? ""
};
