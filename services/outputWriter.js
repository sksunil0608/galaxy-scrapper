import fs from "node:fs/promises";
import path from "node:path";

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeVendorOutput(vendorKey, payload) {
  const directory = path.resolve("output", vendorKey);
  await fs.mkdir(directory, { recursive: true });

  const filename = `${buildTimestamp()}.json`;
  const filePath = path.join(directory, filename);

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

  return {
    filePath,
    filename
  };
}
