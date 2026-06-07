import pino from "pino";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: undefined, // cleaner logs on Cloud
  redact: ["req.headers.authorization", "password", "token"],
});

export default logger;
