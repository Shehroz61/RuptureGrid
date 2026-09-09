// =====================================================================
// Demo Fintech — admin service (durable mode state + reset)
// =====================================================================
// Target-owned administration (Phase 2 §30, §31, §49): processing mode
// is DURABLE database state in demo_settings (survives restarts,
// verified by test), reset re-establishes the canonical scenario
// baseline through the target's own DB ownership. RuptureGrid can never
// perform any of this directly — it has no Demo DB credentials.

import type { DemoDb, ProcessingMode } from '@rupturegrid/demo-db';
import { CANONICAL_CUSTOMER_REFERENCE, CANONICAL_WALLET_CURRENCY } from '@rupturegrid/demo-db';

export interface ScenarioBaseline {
  customerReference: string;
  walletId: string;
  mode: ProcessingMode;
}

export interface DemoAdminService {
  getProcessingMode(): Promise<ProcessingMode>;
  setProcessingMode(mode: ProcessingMode): Promise<ProcessingMode>;
  resetScenario(): Promise<ScenarioBaseline>;
}

export function createDemoAdminService(db: DemoDb): DemoAdminService {
  return {
    /** Reads the durable processing mode, creating the row if absent. */
    async getProcessingMode(): Promise<ProcessingMode> {
      const settings = await db.client.demoSettings.upsert({
        where: { id: 'default' },
        update: {},
        create: { id: 'default', processingMode: 'VULNERABLE' },
      });
      return settings.processingMode;
    },

    /** Persists the processing mode durably. */
    async setProcessingMode(mode: ProcessingMode): Promise<ProcessingMode> {
      const settings = await db.client.demoSettings.upsert({
        where: { id: 'default' },
        update: { processingMode: mode },
        create: { id: 'default', processingMode: mode },
      });
      return settings.processingMode;
    },

    /**
     * Resets the demo scenario deterministically: clears ALL Phase 2
     * business records (children first), resets the mode to VULNERABLE,
     * and creates the canonical customer + zero-balance PKR wallet.
     * Operates exclusively on the Demo Target's own database.
     */
    async resetScenario(): Promise<ScenarioBaseline> {
      return db.client.$transaction(async (tx) => {
        // Children → parents. Business records only; nothing else exists.
        await tx.ledgerEntry.deleteMany();
        await tx.financialEffect.deleteMany();
        await tx.processingAttempt.deleteMany();
        await tx.webhookDelivery.deleteMany();
        await tx.providerEvent.deleteMany();
        await tx.providerPayment.deleteMany();
        await tx.wallet.deleteMany();
        await tx.customer.deleteMany();

        await tx.demoSettings.upsert({
          where: { id: 'default' },
          update: { processingMode: 'VULNERABLE' },
          create: { id: 'default', processingMode: 'VULNERABLE' },
        });

        const customer = await tx.customer.create({
          data: { customerReference: CANONICAL_CUSTOMER_REFERENCE },
        });
        const wallet = await tx.wallet.create({
          data: {
            customerId: customer.id,
            currency: CANONICAL_WALLET_CURRENCY,
            balanceMinor: 0n,
          },
        });
        return {
          customerReference: customer.customerReference,
          walletId: wallet.id,
          mode: 'VULNERABLE' as const,
        };
      });
    },
  };
}
