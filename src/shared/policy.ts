/** URL/SSRF policy derived from configuration. */

import type { SharedConfig } from './env.js';
import type { UrlPolicy } from './ssrf.js';

export function urlPolicyFor(env: SharedConfig): UrlPolicy {
  return { allowInsecure: env.ALLOW_INSECURE_SITE_URLS === 'true' };
}
