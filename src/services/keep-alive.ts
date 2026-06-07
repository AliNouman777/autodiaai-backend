import cron from "node-cron";
import axios from "axios";
import logger from "../libs/logger";
import env from "../config/env";

/**
 * Keeps the Render free instance alive by pinging itself every 14 minutes.
 * Render free tier spins down after 15 minutes of inactivity.
 */
export const initKeepAliveCron = () => {
  // If no public URL is provided, we can't ping ourselves
  const selfUrl = env.NODE_ENV === "production" 
    ? "https://autodia-backend.onrender.com" 
    : `http://localhost:${env.PORT}`;

  logger.info(`[Cron] Initializing keep-alive cron for: ${selfUrl}`);

  // Schedule a task to run every 14 minutes
  cron.schedule("*/14 * * * *", async () => {
    try {
      logger.info("[Cron] Sending keep-alive ping...");
      const response = await axios.get(selfUrl);
      logger.info(`[Cron] Keep-alive ping successful: ${response.status}`);
    } catch (error: any) {
      logger.error({ err: error.message }, "[Cron] Keep-alive ping failed");
    }
  });
};
