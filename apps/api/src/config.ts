import { loadApiConfig } from '@rupturegrid/config';
import type { ApiConfig } from '@rupturegrid/config';

export function loadConfig(): ApiConfig {
  return loadApiConfig();
}
