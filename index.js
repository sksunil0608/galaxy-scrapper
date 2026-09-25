import { appConfig } from "./config/app.js";
import { createServer } from "./server.js";
import { startScheduler } from "./jobs/scheduler.js";

// A Playwright wait (page.waitForResponse etc.) that is created early and never
// awaited — because the flow threw or stalled first — rejects later with no
// handler, and Node's default is to exit. That took down the whole server *and its
// scheduler* (Azamara run #501, 2026-09-25) so every later scheduled fetch was
// lost. One vendor's stray rejection must not kill the process: log it and carry on.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message.split("\n")[0]}` : String(reason);
  console.error(`[process] unhandledRejection (server kept running): ${msg}`);
});

const server = createServer();

server.listen(appConfig.port, () => {
  console.log(`CruiseSaga scrapper-backend listening on port ${appConfig.port}`);
  startScheduler();
});
