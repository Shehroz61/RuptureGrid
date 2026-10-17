// One fixture owns one migrated Control database and queue namespace.
// Registration reuse is a capability of this runtime object: only IDs
// returned by its own successful production registration may be reused.
// Origin equality, display names and compatible manifests never prove
// that another registration belongs to this fixture.
import { randomUUID } from 'node:crypto';
import { createControlDb } from '@rupturegrid/control-db';
import {
  canonicalizeAndHash,
  DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
  normalizeOrigin,
  registerTarget,
} from '@rupturegrid/engine';
import type {
  RegisterTargetInput,
  TargetOriginCredentialPolicy,
  TargetRegistrationResult,
} from '@rupturegrid/engine';
import type { TestEnv } from './env.js';
import { provisionThrowawayControlDb } from './control-db-provision.js';

export type OwnedControlFixture = Awaited<ReturnType<typeof createOwnedControlFixture>>;

export async function createOwnedControlFixture(sourceEnv: TestEnv) {
  const database = await provisionThrowawayControlDb(sourceEnv.controlDatabaseUrl);
  let controlDb: ReturnType<typeof createControlDb>;
  try {
    controlDb = createControlDb(database.databaseUrl);
  } catch (error) {
    await database.close();
    throw error;
  }
  const env = {
    ...sourceEnv,
    controlDatabaseUrl: database.databaseUrl,
    queuePrefix: `${sourceEnv.queuePrefix}-fixture-${randomUUID()}`,
  };
  const registrations = new Map<
    string,
    { bindingHash: string; result: Promise<TargetRegistrationResult> }
  >();
  const acquisitions = new Set<Promise<TargetRegistrationResult>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    controlDb,
    prisma: controlDb.prisma,
    env,
    databaseName: database.databaseName,
    acquireTarget(
      key: string,
      input: RegisterTargetInput,
      policy: TargetOriginCredentialPolicy = DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
    ): Promise<TargetRegistrationResult> {
      if (closed) return Promise.reject(new Error('owned Control fixture is closed'));
      const acquisition = (async () => {
        // Snapshot inputs before awaiting: caller mutation cannot change an
        // in-flight registration or widen a later acquisition's authority.
        const request = JSON.parse(canonicalizeAndHash(input).canonical) as RegisterTargetInput;
        const grants = JSON.parse(
          canonicalizeAndHash(policy).canonical,
        ) as TargetOriginCredentialPolicy;
        const bindingHash = canonicalizeAndHash({
          ...request,
          origins: request.origins.map(normalizeOrigin).sort(),
          credentialRefs: [...(request.credentialRefs ?? [])].sort(),
          policy: grants,
        }).hash;
        let owned = registrations.get(key);
        if (owned !== undefined && owned.bindingHash !== bindingHash) {
          throw new Error(
            'fixture target key is already bound to different registration authority',
          );
        }
        if (owned === undefined) {
          // Publish the promise synchronously before awaiting it. Concurrent
          // callers of this owner/key share ONE real registration attempt.
          // Rejections remain rejections: there is no retry or origin lookup.
          owned = { bindingHash, result: registerTarget(controlDb.prisma, request, grants) };
          registrations.set(key, owned);
        }
        const result = await owned.result;
        const current = await controlDb.prisma.targetRegistration.findUniqueOrThrow({
          where: { id: result.targetId },
          include: { origins: true },
        });
        if (
          canonicalizeAndHash({
            displayName: current.displayName,
            environment: current.environment,
            contractKind: current.contractKind,
            credentialRefs: [...current.credentialRefs].sort(),
            origins: current.origins.map((origin) => origin.origin).sort(),
            manifestJson: current.manifestJson,
          }).hash !==
          canonicalizeAndHash({
            displayName: result.displayName,
            environment: result.environment,
            contractKind: result.contractKind,
            credentialRefs: [...result.credentialRefs].sort(),
            origins: [...result.origins].sort(),
            manifestJson: result.manifestJson ?? null,
          }).hash
        ) {
          throw new Error('owned fixture registration changed after acquisition');
        }
        return JSON.parse(canonicalizeAndHash(result).canonical) as TargetRegistrationResult;
      })();
      acquisitions.add(acquisition);
      void acquisition.then(
        () => acquisitions.delete(acquisition),
        () => acquisitions.delete(acquisition),
      );
      return acquisition;
    },
    async close() {
      if (closing !== undefined) return closing;
      closed = true;
      // Join registration work before disconnect/drop. Caller teardown
      // closes its workers/queues/servers first; this drops only our DB.
      closing = (async () => {
        await Promise.allSettled(acquisitions);
        try {
          await controlDb.disconnect();
        } finally {
          await database.close();
        }
      })();
      return closing;
    },
  };
}
