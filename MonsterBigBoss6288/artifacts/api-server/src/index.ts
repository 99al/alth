import app from "./app";
import { logger } from "./lib/logger";

// ─── صمّام أمان عالمي: الـ API server لا يموت أبداً ───
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — server continues running");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — server continues running");
});

// إعادة تشغيل ناعمة عند SIGTERM بدل الإيقاف
process.on("SIGTERM", () => {
  logger.warn("SIGTERM received — ignoring to keep server alive");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  logger.error("PORT environment variable is required but was not provided.");
  process.exit(1);
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  logger.error({ rawPort }, "Invalid PORT value");
  process.exit(1);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port — retrying in 5s");
    setTimeout(() => {
      app.listen(port, () => logger.info({ port }, "Server listening (retry)"));
    }, 5000);
    return;
  }
  logger.info({ port }, "Server listening");
});
