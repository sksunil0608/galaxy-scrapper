import { appConfig } from "./config/app.js";
import { createServer } from "./server.js";
import { startScheduler } from "./jobs/scheduler.js";

const server = createServer();

server.listen(appConfig.port, () => {
  console.log(`CruiseSaga scrapper-backend listening on port ${appConfig.port}`);
  startScheduler();
});
