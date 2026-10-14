// =====================================================================
// RuptureGrid v1.0 — Control DB ownership boundary
// =====================================================================
// The ONLY place RuptureGrid applications obtain a Control PostgreSQL
// client. Demo Fintech applications MUST NOT import this package
// (enforced by dependency boundaries — see docs/architecture.md §4).

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

export type { PrismaClient } from './generated/client/client.js';
/**
 * The Prisma namespace — notably `Prisma.TransactionClient`, the
 * transaction-scoped client an interactive `$transaction` callback
 * receives. Exported so domain writers can type the derived-write and
 * completeness-check surfaces without naming the generated client path.
 */
export type { Prisma } from './generated/client/client.js';
export * from './generated/client/enums.js';
export type {
  TargetRegistrationModel,
  TargetOriginModel,
  ExperimentDefinitionModel,
  ExperimentRevisionModel,
  RunSnapshotModel,
  ExperimentRunModel,
  ExperimentStepRunModel,
  StepInvocationModel,
  StaleWriterEventModel,
  RawObservationModel,
  NormalizedEventModel,
  CausalRelationshipModel,
  EvidenceIntegrityHeadModel,
  InvariantDefinitionModel,
  EvaluationBatchModel,
  InvariantEvaluationModel,
  FindingModel,
  FindingEvidenceReferenceModel,
  ForensicTimelineEntryModel,
  ForensicDerivationModel,
  ReproductionDefinitionModel,
} from './generated/client/models.js';

export interface ControlDb {
  /** Raw health probe: SELECT 1 against the Control PostgreSQL. */
  ping(): Promise<void>;
  /**
   * The typed Prisma client for Control-schema domain operations
   * (Phase 3 execution engine). Domain code uses the generated model
   * API; cross-cutting conditional/fenced writes use `$executeRaw`
   * inside transactions for precise database-time predicates.
   */
  readonly prisma: PrismaClient;
  /** Closes the underlying connection pool. */
  disconnect(): Promise<void>;
}

/**
 * Creates the RuptureGrid Control database client from an explicit
 * connection string. The caller (app config layer) owns the value;
 * this package never reads process.env directly.
 */
export function createControlDb(connectionString: string): ControlDb {
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    async ping() {
      await prisma.$queryRawUnsafe('SELECT 1');
    },
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}
