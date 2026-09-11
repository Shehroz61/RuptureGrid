import { loadConfig, loadEnvironment } from './load.js';
import { apiConfigSchema, demoConfigSchema, workerConfigSchema } from './schemas.js';
import type { ApiConfig, DemoConfig, WorkerConfig } from './schemas.js';

export { ConfigValidationError, loadConfig, loadEnvironment, pickRuptureGridEnv } from './load.js';
export {
  apiConfigSchema,
  demoConfigSchema,
  workerConfigSchema,
  EXECUTOR_CREDENTIAL_REFS,
} from './schemas.js';
export type { ApiConfig, DemoConfig, WorkerConfig, ExecutorCredentialRef } from './schemas.js';

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
