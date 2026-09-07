import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { AceEngineAdapter } from '../../adapters/ace/ace-engine-adapter';
import { createAceHttpTransport, type AceTransport } from '../../adapters/ace/transport';
import { ACE_STEP_ENGINE_ID } from '../../adapters/registry/default-engines';
import { createHealthMonitor, type HealthMonitor } from '../../adapters/registry/health-monitor';
import { realScheduler, type ScheduledTask, type Scheduler } from '../../adapters/registry/health-schedule';
import { CONSECUTIVE_FAILURES_TO_UNAVAILABLE } from '../../adapters/registry/health-transitions';
import type { AuditSinkPort, EngineAdapterFactoryPort } from '../../adapters/registry/ports';
import { ProviderRegistry } from '../../adapters/registry/provider-registry';
import { realTimeoutRunner } from '../../adapters/timeout-runner';
import type { AuditLogDraft } from '../../domain/audit-log/entry';
import { watermarkId } from '../../domain/disclosure/ai-disclosure';
import { createAccountService } from '../../services/account/account-service';
import { createLoggingEmailSender, type StructuredLog } from '../../services/account/adapters/logging-email-sender';
import { createPgAccountRepository } from '../../services/account/adapters/pg-account-repository';
import { createRedisConnection } from '../../services/account/adapters/redis-client';
import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../services/account/adapters/redis-session-store';
import { systemClock, type Clock } from '../../services/clock';
import { createDspHttpClient, type DspClient, type DspHttpClient } from '../../services/generation/adapters/dsp-http-client';
import { createPgAssetPublication } from '../../services/generation/adapters/pg-asset-publication';
import { createInMemoryJobEventBus } from '../../services/generation/job-events';
import { createInMemoryJobQueue } from '../../services/generation/job-queue';
import { createInMemoryJobStore } from '../../services/generation/job-store';
import { freeChargePort, freeRefundPort, noEngineStatistics } from '../../services/generation/ports';
import type { JobRuntime } from '../../services/generation/runtime';
import {
  SelfPollingJobOrchestrator,
  startTimeoutSweep,
} from '../../services/generation/self-polling-orchestrator';
import { SongGateway } from '../../services/generation/song-gateway';
import { createFilesystemObjectStore } from '../../services/playback/adapters/filesystem-object-store';

import { buildGatewayApp } from './app';
import type { GatewayConfig } from './config';
import { aceStepDescriptor, registryLicensePort } from './engine-catalogue';
import { buildSocialProviders } from './social-providers';

/**
 * The composition root (roadmap §4.4, slice S5).
 *
 * Every service in this tree takes its collaborators as ports, and until this file the only
 * place all of them were handed real implementations at once was `test/support/gateway-harness.ts`
 * — with a fake clock, a fake Redis, an in-memory account table and a scripted engine. This is
 * that harness with the fakes replaced, in the same order, so the two can be read side by side.
 *
 * ### What is real and what is v0
 *
 * Real: PostgreSQL for accounts and assets, Redis for sessions and login attempts, the ACE-Step
 * adapter over HTTP, the DSP sidecar over HTTP, the filesystem object store, the health monitor,
 * the Requirement 5.2 poll loop and the 5.8 sweep. A job submitted here reaches the engine, is
 * polled, is normalised and watermarked by the sidecar, and lands as a row and an object.
 *
 * v0, and named as such: the job store, queue and event bus are in-memory, so a restart forgets
 * in-flight jobs (design §2.4 gives custody to BullMQ; that is the next thing to replace, and it
 * is three port implementations). Credits are the `freeChargePort` / `freeRefundPort` pair — no
 * account is charged, and no refund has anything to return — until the ledger and plan stores
 * exist (§4.5 B1). Pricing is permissive for the same reason. No moderation service is composed,
 * so the orchestrator approves nothing (its own documented default). None of these is a silent
 * fallback: each is a named value in this file, and swapping it in is a one-line change here.
 *
 * ### Overrides exist for one caller
 *
 * `test/integration/composition-root.test.ts` composes this exact function against a real
 * PostgreSQL and Redis with the engine scripted and the scheduler manual, and drives a song from
 * `/auth/register` to a stored asset. The overrides are the seams that test needs and nothing
 * more; production passes none of them.
 */
export interface CompositionOverrides {
  /** Scripted engine in place of HTTP to `config.engine.baseUrl`. */
  readonly aceTransport?: AceTransport;
  /** Scripted DSP in place of HTTP to `config.dspUrl`. Readiness then reports it as `skipped`. */
  readonly dsp?: DspClient;
  /** A manual scheduler makes polls, sweeps and health probes run when the test says. */
  readonly scheduler?: Scheduler;
  readonly clock?: Clock;
  /** Where structured records go; `process.stdout` by default. */
  readonly log?: StructuredLog;
  /** Fastify's request logger; on in production, off under test. */
  readonly requestLogging?: boolean;
}

export type ReadinessProbe = 'ok' | 'error' | 'skipped';

export interface Readiness {
  /** `ready` when both stores answer; the engine and the sidecar being down degrade, not block. */
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly checks: {
    readonly database: ReadinessProbe;
    readonly redis: ReadinessProbe;
    readonly dsp: ReadinessProbe;
    /**
     * Requirement 20.8/20.21's availability, as the registry holds it — what routing uses.
     * An engine starts `available` and needs three consecutive failed probes to leave that
     * state, so this can say `available` of an engine whose last probe failed; `engineLastCheck`
     * is there so a reader can tell the two apart.
     */
    readonly engine: 'available' | 'unavailable';
    readonly engineLastCheck: 'success' | 'failure' | null;
  };
}

export interface ComposedGateway {
  readonly app: FastifyInstance;
  readonly registry: ProviderRegistry;
  readonly health: HealthMonitor;
  readonly orchestrator: SelfPollingJobOrchestrator;
  /** What `GET /ready` answers. */
  readiness(): Promise<Readiness>;
  /**
   * Probes the engine three times, then starts the 60 ± 5 s health loop and the 5.8 sweep.
   *
   * Three because that is Requirement 20.8's threshold: an engine is registered `available`
   * and stays so until three consecutive failures, so fewer probes at boot would leave a dead
   * engine routable — and `/ready` reporting it so — for the first minute of every restart.
   * A reachable engine is unaffected; it was available already.
   */
  start(): Promise<void>;
  /** Stops the loops, closes the app, then the connections. Idempotent. */
  close(): Promise<void>;
}

/** Requirement 5.8 is checked this often; the budget it enforces is 900 s, so a minute is fine-grained. */
export const TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

const defaultLog: StructuredLog = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export function composeGateway(config: GatewayConfig, overrides: CompositionOverrides = {}): ComposedGateway {
  const log = overrides.log ?? defaultLog;
  const clock = overrides.clock ?? systemClock;
  const scheduler = overrides.scheduler ?? realScheduler;

  // --- Stores. The pool is shared by every PostgreSQL adapter; each takes the `query` slice.
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const redis = createRedisConnection(config.redisUrl);
  const objects = createFilesystemObjectStore(config.objectStoreDirectory);

  // --- Accounts (Requirement 1), as `server.ts` composed them before this file existed.
  const accountService = createAccountService({
    repository: createPgAccountRepository(pool),
    sessionStore: createRedisSessionStore({ commands: redis, clock }),
    loginAttemptStore: createRedisLoginAttemptStore({ commands: redis }),
    emailSender: createLoggingEmailSender(log),
    jwtSecret: config.jwtSecret,
    publicBaseUrl: config.publicBaseUrl,
    passwordHashCost: config.passwordHashCost,
    clock,
    oauthProviders: buildSocialProviders(config),
  });

  // --- Engines (Requirement 20). One engine, registered from configuration; the operator routes
  // of task 1.3 can add more at runtime, and the factory below is how they get an adapter.
  const audit = loggingAuditSink(log);
  const registry = new ProviderRegistry({ clock, auditSink: audit });
  const aceAdapter = new AceEngineAdapter({
    engineId: ACE_STEP_ENGINE_ID,
    transport:
      overrides.aceTransport ??
      createAceHttpTransport({
        baseUrl: config.engine.baseUrl,
        ...(config.engine.apiToken === null ? {} : { apiToken: config.engine.apiToken }),
      }),
    clock,
  });
  registry.register({ descriptor: aceStepDescriptor(config.engine), adapter: aceAdapter, actorId: null });
  const adapterFactory: EngineAdapterFactoryPort = {
    create: (descriptor) => (descriptor.engineId === ACE_STEP_ENGINE_ID ? aceAdapter : undefined),
  };
  const health = createHealthMonitor({ registry, clock, scheduler, timeoutRunner: realTimeoutRunner });

  // --- Generation (Requirements 3–6) over the S1–S3 seams.
  const dspHttp = overrides.dsp === undefined ? createDspHttpClient({ baseUrl: config.dspUrl }) : null;
  const dsp: DspClient = overrides.dsp ?? (dspHttp as DspHttpClient);
  const store = createInMemoryJobStore();
  const events = createInMemoryJobEventBus();
  const runtime: JobRuntime = {
    registry,
    store,
    queue: createInMemoryJobQueue(),
    events,
    refunds: freeRefundPort,
    charges: freeChargePort,
    audit,
    assets: createPgAssetPublication({
      db: pool,
      objects,
      dsp,
      licenses: registryLicensePort(registry),
      // `DisclosureService.provenanceFieldsFor` is this one-liner over the same domain function;
      // the service is not composed here because its other duty — reading the watermark back out
      // of stored audio (Requirement 16.6) — needs a `WatermarkPort` the sidecar does not expose
      // yet. When it does, this becomes the service and nothing else moves.
      disclosure: { provenanceFieldsFor: (version) => ({ aiGenerated: true, watermarkId: watermarkId(version) }) },
      clock,
      jobs: store,
    }),
    statistics: noEngineStatistics,
    clock,
    scheduler,
    timeoutRunner: realTimeoutRunner,
    newId: randomUUID,
  };
  const orchestrator = new SelfPollingJobOrchestrator(runtime, {
    onPollError: (jobId, error) => log({ event: 'generation.poll_failed', job_id: jobId, error: describe(error) }),
  });
  const songGateway = new SongGateway({ orchestrator });

  const app = buildGatewayApp({
    accountService,
    clock,
    engines: { registry, adapterFactory },
    generation: { orchestrator, events, runtime, songGateway },
    fastifyOptions: { logger: overrides.requestLogging ?? true },
  });

  const readiness = async (): Promise<Readiness> => {
    const [database, redisProbe, dspProbe] = await Promise.all([
      probe(() => pool.query('SELECT 1')),
      probe(() => redis.get('musicstudio:readiness')),
      dspHttp === null ? Promise.resolve<ReadinessProbe>('skipped') : probe(() => dspHttp.health()),
    ]);
    const ace = registry.listEngines().find((listing) => listing.engineId === ACE_STEP_ENGINE_ID);
    const engine = ace?.availableNow === true ? 'available' : 'unavailable';
    const engineLastCheck = ace?.lastCheckOutcome ?? null;
    const stores = database === 'ok' && redisProbe === 'ok';
    const engineHealthy = engine === 'available' && engineLastCheck !== 'failure';
    return {
      status: !stores ? 'unavailable' : dspProbe === 'error' || !engineHealthy ? 'degraded' : 'ready',
      checks: { database, redis: redisProbe, dsp: dspProbe, engine, engineLastCheck },
    };
  };

  // A liveness route exists on the app already (`/health`). Readiness is the composition's to
  // answer, because only the composition knows what it composed.
  app.get('/ready', async (_request, reply) => {
    const result = await readiness();
    return reply.code(result.status === 'unavailable' ? 503 : 200).send(result);
  });

  let sweep: ScheduledTask | null = null;
  let closed = false;

  return {
    app,
    registry,
    health,
    orchestrator,
    readiness,

    async start() {
      // Requirement 20.8's threshold, at boot: see `ComposedGateway.start`. A reachable engine
      // is routable from the first request; an unreachable one is unavailable before the
      // listener opens, and the loop keeps asking so Requirement 20.21 can bring it back.
      for (let probe = 0; probe < CONSECUTIVE_FAILURES_TO_UNAVAILABLE; probe += 1) {
        await health.checkAll();
      }
      health.start();
      sweep = startTimeoutSweep(orchestrator, scheduler, TIMEOUT_SWEEP_INTERVAL_MS, (error) =>
        log({ event: 'generation.sweep_failed', error: describe(error) }),
      );
      log({
        event: 'gateway.composed',
        engine: { id: ACE_STEP_ENGINE_ID, base_url: config.engine.baseUrl },
        dsp_url: config.dspUrl,
        object_store: config.objectStoreDirectory,
        credits: 'free (v0)',
        job_store: 'in-memory (v0)',
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      health.stop();
      sweep?.cancel();
      orchestrator.stopPolling();
      await app.close();
      await redis.close();
      await pool.end();
    },
  };
}

async function probe(check: () => Promise<unknown>): Promise<ReadinessProbe> {
  try {
    await check();
    return 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Audit_Log as structured log lines (v0).
 *
 * The `audit_log` table exists (0008) and has no writer yet; until it does, the drafts the
 * registry and the orchestrator produce go to the log so a Requirement 20.20 or 6.3 event is at
 * least observable. Only identifiers are written: a draft may carry a raw `actorEmail`, and the
 * masking that `buildAuditLogEntry` applies belongs to the table writer, not to a log line.
 */
function loggingAuditSink(log: StructuredLog): AuditSinkPort {
  return {
    record(draft: AuditLogDraft) {
      log({
        event: 'audit',
        event_type: draft.eventType,
        actor_id: draft.actorId ?? null,
        target_id: draft.targetId ?? null,
        event_time: (draft.eventTime ?? new Date()).toISOString(),
      });
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
