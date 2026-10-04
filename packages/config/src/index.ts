import { loadConfig, loadEnvironment } from './load.js';
import {
  apiConfigSchema,
  commerceConfigSchema,
  demoConfigSchema,
  workerConfigSchema,
} from './schemas.js';
import type { ApiConfig, CommerceConfig, DemoConfig, WorkerConfig } from './schemas.js';

export { ConfigValidationError, loadConfig, loadEnvironment, pickRuptureGridEnv } from './load.js';
export {
  apiConfigSchema,
  commerceConfigSchema,
  demoConfigSchema,
  workerConfigSchema,
  EXECUTOR_CREDENTIAL_REFS,
  EXECUTOR_SIGNING_CREDENTIAL_REFS,
  assertSigningSubsetInvariant,
  parseTargetOriginCredentialGrants,
} from './schemas.js';
export type {
  ApiConfig,
  CommerceConfig,
  DemoConfig,
  WorkerConfig,
  ExecutorCredentialRef,
  ExecutorSigningCredentialRef,
  TargetOriginCredentialGrants,
} from './schemas.js';

/** Loads the repo-root `.env` and validates the API environment. */
export function loadApiConfig(): ApiConfig {
  loadEnvironment();
  return loadConfig(apiConfigSchema);
}

/** Loads the repo-root `.env` and validates the worker environment. */
export function loadWorkerConfig(): WorkerConfig {
  loadEnvironment();
  return loadConfig(workerConfigSchema);
}

/** Loads the repo-root `.env` and validates the Demo Fintech environment. */
export function loadDemoConfig(): DemoConfig {
  loadEnvironment();
  return loadConfig(demoConfigSchema);
}

/** Loads the repo-root `.env` and validates the Demo Commerce environment. */
export function loadCommerceConfig(): CommerceConfig {
  loadEnvironment();
  return loadConfig(commerceConfigSchema);
}
