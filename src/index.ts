import env from "./config/env";
import { connectDB } from "./config/db";
import { createServer } from "./server";
import logger from "./libs/logger";
import { initKeepAliveCron } from "./services/keep-alive";

(async () => {
  try {
    await connectDB(env.MONGO_URI);
    const app = createServer();
    app.listen(env.PORT, () => {
      logger.info(`🚀 Server listening on :${env.PORT}`);
      initKeepAliveCron();
    });
  } catch (err) {
    logger.error({ err }, "Startup failed");
    process.exit(1);
  }
})();
