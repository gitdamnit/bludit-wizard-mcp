/** URL/SSRF policy derived from configuration. */

import type { SharedSecrets } from './env.js';
import type { UrlPolicy } from './ssrf.js';

export function urlPolicyFor(env: SharedSecrets): UrlPolicy {
  return { allowInsecure: env.ALLOW_INSECURE_SITE_URLS === 'true' };
}
