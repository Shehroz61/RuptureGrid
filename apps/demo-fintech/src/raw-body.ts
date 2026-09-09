// =====================================================================
// Demo Fintech — raw-body capture (Express 5 verified option)
// =====================================================================
// express.json({ verify }) receives the EXACT raw request bytes before
// JSON parsing (verified against current body-parser docs); throwing in
// verify aborts parsing. Capturing the raw buffer here lets webhook
// signature verification bind the bytes as transmitted — no canonical
// re-serialization, no property-ordering assumptions. The 256kb body
// limit is preserved unchanged (Phase 2 §96).

import type { Request } from 'express';

/** A request whose raw body was captured by `captureRawBody`. */
export interface RequestWithRawBody extends Request {
  /** Exact raw request bytes, captured by the json parser verify hook. */
  rawBody?: Buffer;
}

export const BODY_LIMIT = '256kb';

/**
 * verify hook for express.json: stores the raw body on the request.
 */
export function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  (req as RequestWithRawBody).rawBody = Buffer.from(buf);
}
