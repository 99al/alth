import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import authRouter from "./routes/auth";
import { dashboardOrigin, requireControlAuth } from "./lib/control-auth";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          method: req.method,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: dashboardOrigin,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 600,
}));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));

app.use("/api/auth", authRouter);
app.use("/api", requireControlAuth, router);

// ─── Global error middleware ───
app.use(
  (
    _err: Error,
    req: import("express").Request,
    res: import("express").Response,
    _next: import("express").NextFunction,
  ) => {
    logger.error({ method: req.method, status: 500 }, "Request failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "خطأ داخلي في الخادم" });
    }
  },
);

export default app;
