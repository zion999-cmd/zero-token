/**
 * Minimal zero-dependency per-IP sliding-window rate limiter.
 *
 * Rejects with 429 once a client exceeds `max` requests per `windowMs`.
 * Kept dependency-free (the project was already on pnpm; adding a package
 * for 20 lines of logic is unnecessary weight).
 */

import type { Request, Response, NextFunction } from 'express';

export interface RateLimiterOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per window per IP. */
  max: number;
}

export function createRateLimiter(opts: RateLimiterOptions) {
  const { windowMs, max } = opts;
  const hits = new Map<string, number[]>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      res.status(429).json({
        error: {
          message: 'Too many requests',
          type: 'rate_limit',
          param: null,
          code: 'rate_limit',
        },
      });
      return;
    }

    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
