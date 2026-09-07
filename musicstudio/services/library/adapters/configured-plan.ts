/**
 * `PlanEntitlementPort` from configuration (roadmap §4.4, slice S6).
 *
 * Requirement 13.4 gates lossless downloads on the requester's plan, and a plan is billing —
 * which this deployment does not have. There is no `account_plan` table wired (§4.5 B1 lists
 * it), so there is nothing to look an account up in.
 *
 * The honest v0 is therefore a *deployment-wide* plan, named in configuration and reported for
 * every account. Two properties matter and both are deliberate:
 *
 * - **The rule still runs.** A gateway configured `free` refuses wav and flac with Requirement
 *   13.4's 402 and the plan ids that would allow it, exactly as a per-account lookup would for
 *   a free account. The gate is not bypassed; it is answered from one value instead of a table.
 * - **The operator chooses, not the code.** A single-tenant deployment with no billing has no
 *   reason to withhold lossless from its only user, and a shared one has every reason to. That
 *   is a deployment question, so it is a deployment setting — and the default is `free`, the
 *   plan an account with no billing relationship is actually on.
 *
 * Replacing this is one query against `account_plan`, and nothing above it changes.
 */

import { findPlan } from '../../../domain/credit/plan';
import type { PlanEntitlementPort } from '../ports';

export class UnknownPlanConfigured extends Error {
  constructor(readonly planId: string) {
    super(`no such plan: ${planId}`);
    this.name = 'UnknownPlanConfigured';
  }
}

/**
 * Every account is on `planId`.
 *
 * Rejects a plan the domain does not define, at construction: a typo'd plan id would otherwise
 * make `findPlan` return undefined at download time and refuse every lossless download with a
 * refusal that names no reason anyone could act on.
 */
export function createConfiguredPlanPort(planId: string): PlanEntitlementPort {
  if (findPlan(planId) === undefined) throw new UnknownPlanConfigured(planId);
  return { planIdFor: async () => planId };
}
