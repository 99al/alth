import { Router, type IRouter } from "express";
import { dashboardSecurity } from "../lib/control-auth";

const router: IRouter = Router();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_GLOBAL_MAX_ATTEMPTS = 20;
const loginLimiter = dashboardSecurity.createLoginRateLimiter({
  windowMs: LOGIN_WINDOW_MS,
  globalMaxAttempts: LOGIN_GLOBAL_MAX_ATTEMPTS,
});

// Rolling and process-local: replicas/restarts do not share counters; use shared storage before scaling out.

function noStore(res: import("express").Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

router.get("/session", (req, res): void => {
  noStore(res);
  const configured = dashboardSecurity.authIsConfigured();
  res.json({
    configured,
    authenticated: configured && dashboardSecurity.hasValidSessionCookie(req.get("cookie")),
  });
});

router.post("/login", (req, res): void => {
  noStore(res);
  if (!dashboardSecurity.isAllowedOrigin(req.get("origin"))) {
    res.status(403).json({ error: "مصدر الطلب غير مسموح" });
    return;
  }
  if (!dashboardSecurity.authIsConfigured()) {
    res.status(503).json({ error: "مصادقة لوحة التحكم غير مهيأة" });
    return;
  }
  const limit = loginLimiter.attempt();
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({ error: "محاولات دخول كثيرة؛ حاول لاحقاً" });
    return;
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!password || Buffer.byteLength(password, "utf8") > 512 || !dashboardSecurity.passwordMatches(password)) {
    res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
    return;
  }

  res.setHeader("Set-Cookie", dashboardSecurity.createSessionCookieHeader());
  res.status(200).json({ authenticated: true });
});

router.post("/logout", (req, res): void => {
  noStore(res);
  if (!dashboardSecurity.isAllowedOrigin(req.get("origin"))) {
    res.status(403).json({ error: "مصدر الطلب غير مسموح" });
    return;
  }
  res.setHeader("Set-Cookie", dashboardSecurity.clearSessionCookieHeader());
  res.status(200).json({ authenticated: false });
});

export default router;
