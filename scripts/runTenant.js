import { runVendorScrape } from "../services/vendorScrapeService.js";

const vendorKey = process.argv[2] ?? "celestyal";
const rawOptions = process.argv[3];
let options = {};

if (rawOptions) {
  if (rawOptions.includes("=")) {
    options = Object.fromEntries(
      process.argv
        .slice(3)
        .map((entry) => entry.split("="))
        .filter(([key, value]) => key && value !== undefined)
    );
  } else {
    try {
      options = JSON.parse(rawOptions);
    } catch (error) {
      console.error(
        `Invalid JSON options passed to runTenant.js: ${error.message}`
      );
      process.exit(1);
    }
  }
}

runVendorScrape(vendorKey, options)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
