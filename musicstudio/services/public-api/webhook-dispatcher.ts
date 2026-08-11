/**
 * Requirements 17.10, 17.14 — send the result when a job ends.
 *
 * ### It fires on the transition, not on the state
 *
 * `onJobTerminal` is called from the place a job *becomes* terminal. Polling for terminal jobs
 * and sending would deliver the same completion on every poll, and de-duplicating that would
 * mean remembering every job forever. The transition happens once, so the delivery does.
 *
 * ### Retries are bounded and the last failure is reported, not swallowed
 *
 * A customer's endpoint is not this product's to rely on. Delivery is retried on a transport
 * error or a 5xx — the failures that are plausibly transient — and **not** on a 4xx, which
 * means the endpoint understood the request and rejected it; retrying that is just load. What
 * comes back is the outcome, so the caller can log it. Nothing here throws: a webhook that
 * could fail a job would make an integration's broken endpoint look like a failed generation.
 */

import { webhookPayload, type WebhookPayload, type WebhookSource } from '../../domain/public-api/webhook';
import type { Clock } from '../clock';
import { systemClock } from '../clock';
import type { IdSource, WebhookDeliveryResult, WebhookSenderPort } from './ports';

/** Attempts in total, including the first. Beyond this the delivery is reported as failed. */
export const WEBHOOK_MAX_ATTEMPTS = 3;

export interface WebhookDispatcherOptions {
  readonly sender: WebhookSenderPort;
  readonly ids: IdSource;
  readonly clock?: Clock;
  /** Resolves the endpoint registered for the key that submitted the job, or `null`. */
  readonly endpointFor: (keyId: string) => Promise<string | null>;
}

export interface DispatchOutcome {
  readonly attempted: boolean;
  readonly delivered: boolean;
  readonly attempts: number;
  readonly lastResult: WebhookDeliveryResult | null;
  readonly payload: WebhookPayload | null;
}

const NOT_ATTEMPTED: DispatchOutcome = {
  attempted: false,
  delivered: false,
  attempts: 0,
  lastResult: null,
  payload: null,
};

/** 4xx means understood and refused; retrying is load, not recovery. */
function worthRetrying(result: WebhookDeliveryResult): boolean {
  if (result.delivered) return false;
  if (result.statusCode === null) return true; // transport error
  return result.statusCode >= 500;
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions) {
  const { sender, ids, endpointFor } = options;
  const clock = options.clock ?? systemClock;

  return {
    /**
     * Requirements 17.10, 17.14.
     *
     * `keyId` is `null` for a job submitted through the ordinary product surface rather than
     * the API. Those have no endpoint, and the clause is scoped 웹훅 URL이 등록된 경우.
     */
    async onJobTerminal(
      keyId: string | null,
      source: Omit<WebhookSource, 'deliveryId' | 'occurredAtMs'>,
    ): Promise<DispatchOutcome> {
      if (keyId === null) return NOT_ATTEMPTED;

      const url = await endpointFor(keyId);
      if (url === null) return NOT_ATTEMPTED;

      const payload = webhookPayload({
        ...source,
        deliveryId: ids.next(),
        occurredAtMs: clock.now().getTime(),
      });

      let lastResult: WebhookDeliveryResult | null = null;
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        lastResult = await sender.send(url, payload);
        if (lastResult.delivered) {
          return { attempted: true, delivered: true, attempts: attempt, lastResult, payload };
        }
        if (!worthRetrying(lastResult)) {
          return { attempted: true, delivered: false, attempts: attempt, lastResult, payload };
        }
      }

      return {
        attempted: true,
        delivered: false,
        attempts: WEBHOOK_MAX_ATTEMPTS,
        lastResult,
        payload,
      };
    },
  };
}

export type WebhookDispatcher = ReturnType<typeof createWebhookDispatcher>;
