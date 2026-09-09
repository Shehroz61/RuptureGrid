import { NextResponse } from 'next/server';

/**
 * Web liveness: the frontend process is alive. It deliberately says
 * nothing about the health of the API, worker, or databases — a
 * frontend process being alive is distinct from backend readiness
 * (Phase 1 spec §24).
 */
export function GET() {
  return NextResponse.json({ status: 'live', service: 'rupturegrid-web' });
}
