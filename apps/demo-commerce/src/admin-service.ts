// =====================================================================
// Demo Commerce — admin service (target-owned scenario + mode state)
// =====================================================================
// Target-owned administration only: processing mode and the scenario
// context (scope token, SKU baseline, generation advance) live in the
// Commerce target's own PostgreSQL and are driven EXCLUSIVELY through
// this admin API — the legitimate target interface (R-05,
// checkout-zero.md §2). RuptureGrid holds no Commerce DB credentials
// and can never mutate this state directly.

import type {
  CommerceDb,
  CommerceMode,
  ProcessingConfiguration,
  ScenarioContext,
} from '@rupturegrid/commerce-db';
import {
  getProcessingMode,
  initializeScenarioContext,
  setProcessingMode,
  getProcessingConfiguration,
  setProcessingConfiguration,
  initializeScenarioContextPreservingMode,
} from '@rupturegrid/commerce-db';

export interface CommerceAdminService {
  getConfiguration(): Promise<ProcessingConfiguration>;
  setConfiguration(mode: CommerceMode): Promise<ProcessingConfiguration>;
  resetContext(input: {
    scopeToken: string;
    sku: string;
    initialAvailableUnits: number;
  }): Promise<ScenarioContext>;
  getProcessingMode(): Promise<CommerceMode>;
  setProcessingMode(mode: CommerceMode): Promise<CommerceMode>;
  /**
   * Establishes (or resets) the experiment context: a fresh generation,
   * a cleared business state for that scope, a re-baselined SKU, and
   * the declared processing mode — atomically, in one transaction.
   */
  resetScenario(input: {
    scopeToken: string;
    sku: string;
    initialAvailableUnits: number;
    mode: CommerceMode;
  }): Promise<ScenarioContext>;
}

export function createCommerceAdminService(db: CommerceDb): CommerceAdminService {
  return {
    getConfiguration: () => getProcessingConfiguration(db),
    setConfiguration: (mode) => setProcessingConfiguration(db, mode),
    resetContext: (input) => initializeScenarioContextPreservingMode(db, input),
    async getProcessingMode(): Promise<CommerceMode> {
      return getProcessingMode(db);
    },

    async setProcessingMode(mode: CommerceMode): Promise<CommerceMode> {
      return setProcessingMode(db, mode);
    },

    async resetScenario(input: {
      scopeToken: string;
      sku: string;
      initialAvailableUnits: number;
      mode: CommerceMode;
    }): Promise<ScenarioContext> {
      return initializeScenarioContext(db, input);
    },
  };
}
