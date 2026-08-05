/**
 * Webhook delivery — Requirements 17.10, 17.14.
 *
 * > WHERE 웹훅 URL이 등록된 경우, THE Public_API SHALL Generation_Job이 **종료될 때** …
 * > … 믹스다운 내보내기 작업이 종료될 때 … **Asset_Kind와** 작업 결과를 전송한다
 *
 * Two clauses, one event: a job reached a terminal state. 17.14 adds Asset_Kind to the mixdown
 * case, and rather than a second payload shape the field is on every delivery — a consumer that
 * has to branch on which clause produced a body is a consumer that will get it wrong for the
 * kind nobody tested.
 *
 * ### Why the payload does not carry the audio
 *
 * A webhook body is delivered to a URL the *customer* controls, over a connection this product
 * does not choose. Audio in the body means minutes of PCM crossing that boundary on every
 * completion, retried on every failure. The delivery carries the identifiers and the outcome;
 * 17.6's download endpoint, behind the API key, is where the bytes are.
 *
 * ### Delivery is at-least-once and says so
 *
 * `deliveryId` is on the payload so a receiver can discard a duplicate. That matters because the
 * alternative to retrying is losing a completion on a transient 502, and a product that silently
 * loses completions is worse than one that occasionally repeats them. A receiver that ignores
 * `deliveryId` gets the same event twice; one that keys on it gets it once.
 */

import type { AssetKind } from '../asset-kind';
import type { GenerationJobState } from '../generation-job/lifecycle';

/** Only `https`. A webhook URL is a place this product sends a customer's job results to. */
const ALLOWED_PROTOCOL = 'https:';

export const WEBHOOK_URL_MAX_LENGTH = 2_000;

export type WebhookViolation =
  | 'webhook_url_unparseable'
  | 'webhook_url_not_https'
  | 'webhook_url_length'
  | 'webhook_url_credentials';

export function webhookUrlViolations(url: string): WebhookViolation[] {
  if (url.length > WEBHOOK_URL_MAX_LENGTH) return ['webhook_url_length'];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return ['webhook_url_unparseable'];
  }

  const violations: WebhookViolation[] = [];
  if (parsed.protocol !== ALLOWED_PROTOCOL) violations.push('webhook_url_not_https');
  // `https://user:pass@host/` would put the customer's credentials in this product's logs the
  // first time a delivery is retried and the URL is written down.
  if (parsed.username !== '' || parsed.password !== '') violations.push('webhook_url_credentials');
  return violations;
}

export function isValidWebhookUrl(url: string): boolean {
  return webhookUrlViolations(url).length === 0;
}

/** Requirements 17.10, 17.14 — what a completion delivery says. */
export interface WebhookPayload {
  /** Deduplication handle; see the module header. */
  readonly deliveryId: string;
  readonly event: 'generation_job.completed';
  readonly jobId: string;
  /** Terminal only — the delivery fires on the transition, not on progress. */
  readonly state: GenerationJobState;
  /** Requirement 17.14 names this for mixdowns; it is present for every kind. */
  readonly assetKind: AssetKind;
  /** Requirement 5.6's output. Empty for a failure or a cancellation. */
  readonly assetIds: readonly string[];
  /** Requirement 6.1's reason, or `null` when the job succeeded. */
  readonly failureReason: string | null;
  readonly occurredAtMs: number;
}

export interface WebhookSource {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly state: GenerationJobState;
  readonly assetKind: AssetKind;
  readonly assetIds: readonly string[];
  readonly failureReason: string | null;
  readonly occurredAtMs: number;
}

/**
 * Build the payload.
 *
 * A function rather than an object literal at the dispatch site, so the two clauses' fields are
 * assembled in one place and a caller cannot add a field the receiver was never promised — in
 * particular an account id, which a webhook body has no use for and a customer's log has no
 * business holding.
 */
export function webhookPayload(source: WebhookSource): WebhookPayload {
  return {
    deliveryId: source.deliveryId,
    event: 'generation_job.completed',
    jobId: source.jobId,
    state: source.state,
    assetKind: source.assetKind,
    // Copied rather than aliased: the payload outlives the job record it was built from.
    assetIds: [...source.assetIds],
    failureReason: source.failureReason,
    occurredAtMs: source.occurredAtMs,
  };
}
