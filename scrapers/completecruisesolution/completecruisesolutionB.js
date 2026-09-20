import dotenv from "dotenv";
import { createCcsRunner } from "./completecruisesolutionA.js";

dotenv.config();

const accountB = createCcsRunner({
  vendorKey:        "completecruisesolutionB",
  user:             process.env.CCS_B_USER,
  pass:             process.env.CCS_B_PASS,
  userDataDir:      "./sessions/ccs-b-user-data",
  storageStatePath: "./sessions/.auth/ccs-b-storage.json",
});

export async function runCompleteCruiseSolutionBScraper(options = {}) {
  return accountB.run(options);
}

export async function authenticateCompleteCruiseSolutionB() {
  return accountB.authenticate();
}
