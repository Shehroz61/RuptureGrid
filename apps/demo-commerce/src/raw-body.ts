// =====================================================================
// Demo Commerce — raw-body capture (Express 5 verified option)
// =====================================================================
// express.json({ verify }) receives the EXACT raw request bytes before
// JSON parsing. Capturing the raw buffer here lets checkout signature
// verification bind the transmitted bytes — no canonical
// re-serialization, no property-ordering assumptions (docs/
// checkout-zero.md §2; the same accepted v1 mechanism as the Demo
// Fintech provider webhook). The 256kb limit mirrors the accepted
// target-side body bound.

import type { Request } from 'express';

/** A request whose raw body was captured by `captureRawBody`. */
export interface RequestWithRawBody extends Request {
  /** Exact raw request bytes, captured by the json parser verify hook. */
  rawBody?: Buffer;
}

export const BODY_LIMIT = '256kb';

/** verify hook for express.json: stores the raw body on the request. */
export function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  (req as RequestWithRawBody).rawBody = Buffer.from(buf);
}
