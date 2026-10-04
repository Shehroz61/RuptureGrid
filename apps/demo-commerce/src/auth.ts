// =====================================================================
// Demo Commerce — bearer-token authorization guard
// =====================================================================
// ONE admin trust boundary: COMMERCE_ADMIN_TOKEN guards the target-
// owned scenario/mode/fault routes. The inspection surface accepts NO
// bearer token at all — the Phase 14 generic inspection adapter is
// credential-free by platform contract (no Authorization header is
// ever attached to an inspection/v1 request), so a Commerce inspection
// credential does not exist and must never be invented.
//
// Comparison uses timingSafeEqual on fixed-length digests so token
// comparison does not leak through timing. Tokens are never logged and
// never echoed in error bodies (AGENTS R-13).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from './errors.js';

function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/**
 * Builds an Express middleware requiring `Authorization: Bearer <token>`
 * to equal the configured admin secret exactly.
 */
export function requireBearerToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = extractBearerToken(req);
    if (presented === undefined || !constantTimeEquals(presented, token)) {
      const error = new UnauthorizedError('valid bearer token required');
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next();
  };
}
