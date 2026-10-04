import { createRequire } from "node:module";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { BOT_DIR } from "../routes/bot";

interface LoginRateLimiter {
  attempt(now?: number): { allowed: boolean; retryAfterSeconds: number };
}

interface SecurityModule {
  createLoginRateLimiter(options?: {
    windowMs?: number;
    globalMaxAttempts?: number;
  }): LoginRateLimiter;
  authIsConfigured(): boolean;
  hasValidSessionCookie(cookieHeader: string | undefined): boolean;
  isAllowedOrigin(origin: string | undefined): boolean;
  getDashboardOrigin(): string;
  passwordMatches(candidate: unknown): boolean;
  createSessionCookieHeader(): string;
  clearSessionCookieHeader(): string;
}

const require = createRequire(import.meta.url);
const security = require(path.join(BOT_DIR, "security.cjs")) as SecurityModule;

export const dashboardOrigin = security.getDashboardOrigin();
export const dashboardSecurity = security;

export function requireControlAuth(req: Request, res: Response, next: NextFunction): void {
  // The health route is public here; /api/auth is mounted separately with route-specific protections.
  if (req.method === "GET" && req.path === "/healthz") {
    next();
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  if (!security.authIsConfigured()) {
    res.status(503).json({ error: "مصادقة لوحة التحكم غير مهيأة" });
    return;
  }

  if (!security.hasValidSessionCookie(req.get("cookie"))) {
    res.status(401).json({ error: "يلزم تسجيل الدخول" });
    return;
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !security.isAllowedOrigin(req.get("origin"))) {
    res.status(403).json({ error: "مصدر الطلب غير مسموح" });
    return;
  }

  next();
}
