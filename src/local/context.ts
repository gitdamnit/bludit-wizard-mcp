/**
 * The tool context for the local stdio transport.
 *
 * It differs from the hosted context in exactly three ways — one site from
 * configuration, proposals in memory, audit on stderr — and in no other respect.
 * The tool bodies cannot tell which transport built the context they are running
 * under, which is what makes the "identical behaviour across transports" claim
 * testable rather than aspirational.
 *
 * **On scopes.** The context grants every scope. That is not a relaxation of a
 * control so much as the absence of anything for the control to protect against:
 * there is no client, no grant and no second principal, so `requireToolScope` can
 * never fail locally. The check is still called by every tool, so the same code
 * path runs in both transports and the hosted guarantees are not quietly forked.
 */

import { SCOPES } from '../shared/scopes.js';
import type { AuthProps } from '../shared/env.js';
import type { ToolContext } from '../mcp/tools/context.js';
import type { AuditSink } from '../mcp/tools/ports.js';
import { DEFAULT_PROPOSAL_TTL_SECONDS } from '../shared/env.js';
import type { LocalConfig } from './config.js';
import {
  LOCAL_SITE_ID,
  LOCAL_USER_ID,
  configSiteSource,
  memoryProposalStore,
  stderrAuditSink
} from './ports.js';

/** The synthetic principal a local install acts as. */
export function localProps(): AuthProps {
  return {
    userId: LOCAL_USER_ID,
    email: '',
    displayName: 'Local user',
    // No credential key exists locally: nothing is encrypted or stored.
    credentialKeyVersion: 0
  };
}

export interface LocalContextOptions {
  proposalTtlSeconds?: number;
  /** Injected for tests so audit assertions do not write to the real stderr. */
  audit?: AuditSink;
  now?: () => number;
}

export function buildLocalToolContext(config: LocalConfig, options: LocalContextOptions = {}): ToolContext {
  const ttlSeconds = options.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;
  return {
    sites: configSiteSource(config),
    proposals: memoryProposalStore(ttlSeconds, options.now),
    audit: options.audit ?? stderrAuditSink(),
    userId: LOCAL_USER_ID,
    clientId: 'stdio',
    scopes: [...SCOPES],
    props: localProps(),
    policy: config.policy
  };
}

export { LOCAL_SITE_ID, LOCAL_USER_ID };
