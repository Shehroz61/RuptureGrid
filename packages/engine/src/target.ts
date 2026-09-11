// =====================================================================
// RuptureGrid v1.0 — target registration service
// =====================================================================
// Targets are the only executable destinations (security-boundaries
// §2: registered, authorized, deny-by-default). Registration enforces:
//   - environment classification from the accepted enum
//   - credentialRefs ⊆ executor allowlist (server-side, never client-
//     trusted; EXECUTOR_CREDENTIAL_REFS from @rupturegrid/config)
//   - origin normalization (lowercase host, explicit port preserved)
//   - response-interpretation contract kind (§27 classification)
// Registration NEVER accepts credential values (ADR-0012).

import { EXECUTOR_CREDENTIAL_REFS } from '@rupturegrid/config';
import type { TargetEnvironment } from '@rupturegrid/shared';
import { TARGET_ENVIRONMENTS } from '@rupturegrid/shared';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { TargetRegistration } from './prisma-types.js';

export const CONTRACT_KINDS = ['DEMO_FINTECH_WEBHOOK', 'GENERIC_HTTP'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export class TargetRegistrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TargetRegistrationError';
  }
}

export interface RegisterTargetInput {
  readonly displayName: string;
  readonly environment: TargetEnvironment;
  readonly origins: readonly string[];
  readonly contractKind: ContractKind;
  readonly credentialRefs?: readonly string[];
}

/**
 * Normalizes an origin string to the canonical stored form:
 * `<scheme>://<host>[:<port>]` with a lowercase host and the explicit
 * port preserved. Rejects userinfo, paths, query/fragment, and
 * non-HTTP(S) schemes outright (security-boundaries §3).
 */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRegistrationError(`origin is not a valid URL: "${redactUrl(raw)}"`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TargetRegistrationError(
      'origin must not contain userinfo (security-boundaries §3.2)',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new TargetRegistrationError('origin must not include a path — origins only');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TargetRegistrationError('origin must not include query or fragment');
  }
  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') {
    throw new TargetRegistrationError(`unsupported origin scheme: ${scheme}`);
  }
  const host = url.hostname.toLowerCase();
  const explicitPort = url.port;
  if (explicitPort !== '') {
    return `${scheme}://${host}:${explicitPort}`;
  }
  return `${scheme}://${host}`;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable-url>';
  }
}

export interface TargetRegistrationResult {
  readonly targetId: string;
  readonly displayName: string;
  readonly environment: TargetEnvironment;
  readonly contractKind: ContractKind;
  readonly credentialRefs: readonly string[];
  readonly origins: readonly string[];
}

/**
 * Registers a target with normalized origins and policy enforcement.
 * Runs in one transaction: target + origins are created atomically.
 */
export async function registerTarget(
  prisma: PrismaClient,
  input: RegisterTargetInput,
): Promise<TargetRegistrationResult> {
  if (typeof input.displayName !== 'string' || input.displayName.trim().length < 3) {
    throw new TargetRegistrationError('displayName must be at least 3 characters');
  }
  if (!(TARGET_ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    throw new TargetRegistrationError(
      `environment must be one of: ${TARGET_ENVIRONMENTS.join(', ')}`,
    );
  }
  if (!(CONTRACT_KINDS as readonly string[]).includes(input.contractKind)) {
    throw new TargetRegistrationError(`contractKind must be one of: ${CONTRACT_KINDS.join(', ')}`);
  }
  const credentialRefs = input.credentialRefs ?? [];
  const invalid = credentialRefs.filter(
    (ref) => !(EXECUTOR_CREDENTIAL_REFS as readonly string[]).includes(ref),
  );
  if (invalid.length > 0) {
    throw new TargetRegistrationError(
      `credentialRefs outside the executor allowlist: ${invalid.join(', ')} ` +
        `(allowed: ${EXECUTOR_CREDENTIAL_REFS.join(', ')})`,
    );
  }
  if (new Set(credentialRefs).size !== credentialRefs.length) {
    throw new TargetRegistrationError('credentialRefs must not contain duplicates');
  }
  if (input.origins.length === 0) {
    throw new TargetRegistrationError('at least one origin is required');
  }
  const normalized = input.origins.map(normalizeOrigin);
  const duplicate = normalized.find((origin, index) => normalized.indexOf(origin) !== index);
  if (duplicate !== undefined) {
    throw new TargetRegistrationError(`duplicate origins in request: ${duplicate}`);
  }

  // Environment scheme policy (security-boundaries §3.1): https always;
  // http only for explicitly registered LOCAL_DEVELOPMENT targets.
  if (input.environment !== 'LOCAL_DEVELOPMENT') {
    for (const origin of normalized) {
      if (origin.startsWith('http:')) {
        throw new TargetRegistrationError(
          `http origin "${origin}" is only allowed for LOCAL_DEVELOPMENT targets`,
        );
      }
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.targetRegistration.findUnique({
      where: { displayName: input.displayName },
    });
    if (existing !== null) {
      throw new TargetRegistrationError(`target "${input.displayName}" is already registered`);
    }
    // Origin authority is GLOBAL (target_origin.origin is unique): an
    // origin registered to another target would make execution
    // authority ambiguous — reject with an explicit, safe error.
    for (const origin of normalized) {
      const clash = await tx.targetOrigin.findUnique({ where: { origin } });
      if (clash !== null) {
        throw new TargetRegistrationError(
          `origin ${origin} is already registered to another target (origin authority must be unambiguous)`,
        );
      }
    }
    return tx.targetRegistration.create({
      data: {
        displayName: input.displayName,
        environment: input.environment,
        contractKind: input.contractKind,
        credentialRefs: [...credentialRefs],
        origins: {
          create: normalized.map((origin) => ({ origin })),
        },
      },
      include: { origins: true },
    });
  });

  return {
    targetId: created.id,
    displayName: created.displayName,
    environment: created.environment,
    contractKind: created.contractKind,
    credentialRefs: created.credentialRefs,
    origins: created.origins.map((origin: { origin: string }) => origin.origin).sort(),
  };
}

/** Fetches a target with its origins or throws a not-found error. */
export async function getTarget(
  prisma: PrismaClient,
  targetId: string,
): Promise<TargetRegistration & { origins: { origin: string }[] }> {
  const target = await prisma.targetRegistration.findUnique({
    where: { id: targetId },
    include: { origins: true },
  });
  if (target === null) {
    throw new TargetRegistrationError(`target ${targetId} is not registered`);
  }
  return target;
}
