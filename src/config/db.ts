import mongoose from "mongoose";
import logger from "../libs/logger";

export async function connectDB(uri: string) {
  mongoose.set("strictQuery", true);
  // Explicitly specify dbName to avoid defaulting to 'test' if not in URI
  await mongoose.connect(uri, {
    dbName: "autodia",
  });
  logger.info("🗄️  MongoDB connected to database: autodia");
}
