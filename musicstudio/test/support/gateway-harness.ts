import type { FastifyInstance } from 'fastify';

import { buildGatewayApp } from '../../api/gateway/app';
import {
  createAccountService,
  type AccountService,
} from '../../services/account/account-service';
import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../services/account/adapters/redis-session-store';
import type { OAuthProvider } from '../../services/account/oauth-provider';
import { ReportService } from '../../services/moderation/report-service';

import { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { EngineAdapterFactoryPort } from '../../adapters/registry/ports';
import { createEngineAssignmentTable } from '../../adapters/registry/default-engines';
import type { EngineAssignment } from '../../adapters/registry/default-engines';
import type { AssetKind } from '../../domain/asset-kind';

import { createFakeEngineAdapter, type FakeEngineAdapter } from './fake-engine-adapter';
import { createFakeRedis, type FakeRedis } from './fake-redis';
import {
  createGenerationHarness,
  type GenerationHarness,
  type GenerationHarnessOptions,
} from './generation-harness';
import {
  createInMemoryAccountRepository,
  type InMemoryAccountRepository,
} from './in-memory-account-repository';
import {
  createLyricsHarness,
  type LyricsHarness,
  type LyricsHarnessOptions,
} from './lyrics-harness';
import {
  createConfigurablePublicAssets,
  createInMemoryContentReportStore,
  type ConfigurablePublicAssets,
  type InMemoryContentReportStore,
} from './moderation-harness';
import { createMutableClock, type MutableClock } from './mutable-clock';
import { createRecordingEmailSender, type RecordingEmailSender } from './recording-email-sender';
import {
  createConfigurablePricingPort,
  createRecordingAuditSink,
  type ConfigurablePricingPort,
  type RecordingAuditSink,
} from './registry-harness';

export const HARNESS_JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
export const HARNESS_BASE_URL = 'https://studio.test';

/** Present only when `engines` was requested (task 1.3 engine routes). */
export interface GatewayEngineHarness {
  readonly registry: ProviderRegistry;
  readonly pricing: ConfigurablePricingPort;
  readonly audit: RecordingAuditSink;
  readonly adapters: Map<string, FakeEngineAdapter>;
  readonly adapterFactory: EngineAdapterFactoryPort;
}

/** Present only when `generation` was requested (task 1.5 job routes). */
export type GatewayGenerationHarness = GenerationHarness;

/** Present only when `lyrics` was requested (task 2.3 lyric routes). */
export type GatewayLyricsHarness = LyricsHarness;

/** Present only when `moderation` was requested (task 6.1 report routes). */
export interface GatewayModerationHarness {
  readonly reports: ReportService;
  readonly store: InMemoryContentReportStore;
  readonly publicAssets: ConfigurablePublicAssets;
}

export interface GatewayHarness {
  readonly app: FastifyInstance;
  readonly accountService: AccountService;
  readonly clock: MutableClock;
  readonly redis: FakeRedis;
  readonly repository: InMemoryAccountRepository;
  readonly emails: RecordingEmailSender;
  readonly engines: GatewayEngineHarness | null;
  readonly moderation: GatewayModerationHarness | null;
  readonly generation: GatewayGenerationHarness | null;
  readonly lyrics: GatewayLyricsHarness | null;
  close(): Promise<void>;
}

export interface GatewayHarnessOptions {
  readonly oauthProviders?: readonly OAuthProvider[];
  /** Requirement 1.6 forbids anything below 12; tests keep the real cost. */
  readonly passwordHashCost?: number;
  /**
   * Mounts the engine routes on the gateway, sharing the harness clock so
   * health-check and quota timing stay deterministic. Left out, the gateway is
   * auth-only and the Requirement 1 tests stay independent of the engine layer.
   */
  readonly engines?: { readonly assignments?: Partial<Record<AssetKind, EngineAssignment>> };
  /**
   * Mounts the report-intake and review-state routes (Requirements 16.8, 16.9),
   * sharing the harness clock so report timestamps are deterministic.
   */
  readonly moderation?: { readonly publishedAssetIds?: readonly string[] };
  /**
   * Mounts the Generation_Job routes (Requirements 5.1, 5.3–5.5, 5.7, 6.1, 6.4),
   * sharing the harness clock so the 900-second budget and the one-second SSE bound
   * are driven by the same time source the HTTP layer sees.
   */
  readonly generation?: Omit<GenerationHarnessOptions, 'clock'>;
  /**
   * Mounts the lyric enrichment, draft and LRC download routes (Requirements 8.1–8.5,
   * 10.8) on a scripted ACE transport. No clock is shared, because none of these
   * endpoints is time-dependent — enrichment is synchronous and an LRC file carries
   * offsets, not instants.
   */
  readonly lyrics?: LyricsHarnessOptions;
}

/**
 * Wires the gateway with a fake clock, a fake Redis and an in-memory account
 * repository, and nothing else faked.
 *
 * The production Redis store adapters, the real bcrypt hasher and the real JWT
 * service are all exercised, so an end-to-end assertion through
 * `app.inject()` covers the actual code path a deployed request takes.
 */
export function createGatewayHarness(options: GatewayHarnessOptions = {}): GatewayHarness {
  const clock = createMutableClock();
  const redis = createFakeRedis(clock);
  const repository = createInMemoryAccountRepository();
  const emails = createRecordingEmailSender();

  const accountService = createAccountService({
    repository,
    sessionStore: createRedisSessionStore({ commands: redis, clock }),
    loginAttemptStore: createRedisLoginAttemptStore({ commands: redis }),
    emailSender: emails,
    jwtSecret: HARNESS_JWT_SECRET,
    publicBaseUrl: HARNESS_BASE_URL,
    clock,
    ...(options.passwordHashCost === undefined
      ? {}
      : { passwordHashCost: options.passwordHashCost }),
    ...(options.oauthProviders === undefined ? {} : { oauthProviders: options.oauthProviders }),
  });

  const engines = options.engines === undefined ? null : createEngineHarness(clock, options.engines);
  const moderation =
    options.moderation === undefined
      ? null
      : createGatewayModerationHarness(clock, options.moderation);

  const generation =
    options.generation === undefined
      ? null
      : createGenerationHarness({ ...options.generation, clock });

  const lyrics = options.lyrics === undefined ? null : createLyricsHarness(options.lyrics);

  const app = buildGatewayApp({
    accountService,
    clock,
    ...(engines === null
      ? {}
      : { engines: { registry: engines.registry, adapterFactory: engines.adapterFactory } }),
    ...(moderation === null ? {} : { moderation: { reports: moderation.reports } }),
    ...(lyrics === null
      ? {}
      : { lyrics: { assistant: lyrics.assistant, timedLyrics: lyrics.timedLyrics } }),
    ...(generation === null
      ? {}
      : {
          generation: {
            orchestrator: generation.orchestrator,
            events: generation.events,
            runtime: generation.runtime,
            ...(generation.songGateway === null
              ? {}
              : { songGateway: generation.songGateway }),
            ...(generation.editGateway === null
              ? {}
              : { editGateway: generation.editGateway }),
          },
        }),
  });

  return {
    app,
    accountService,
    clock,
    redis,
    repository,
    emails,
    engines,
    moderation,
    generation,
    lyrics,
    close: () => app.close(),
  };
}

/** Returns the lyrics harness, or throws if the gateway was built without one. */
export function requireLyrics(harness: GatewayHarness): GatewayLyricsHarness {
  if (harness.lyrics === null) {
    throw new Error('this gateway harness was built without lyric routes');
  }
  return harness.lyrics;
}

/** Returns the generation harness, or throws if the gateway was built without one. */
export function requireGeneration(harness: GatewayHarness): GatewayGenerationHarness {
  if (harness.generation === null) {
    throw new Error('this gateway harness was built without generation routes');
  }
  return harness.generation;
}

/** Returns the moderation harness, or throws if the gateway was built without one. */
export function requireModeration(harness: GatewayHarness): GatewayModerationHarness {
  if (harness.moderation === null) {
    throw new Error('this gateway harness was built without moderation routes');
  }
  return harness.moderation;
}

function createGatewayModerationHarness(
  clock: MutableClock,
  options: { readonly publishedAssetIds?: readonly string[] },
): GatewayModerationHarness {
  const store = createInMemoryContentReportStore();
  const publicAssets = createConfigurablePublicAssets(options.publishedAssetIds ?? []);
  let sequence = 0;

  return {
    store,
    publicAssets,
    reports: new ReportService({
      store,
      publicAssets,
      clock,
      newReportId: () => `report-${String(++sequence)}`,
    }),
  };
}

/** Returns the engine harness, or throws if the gateway was built without one. */
export function requireEngines(harness: GatewayHarness): GatewayEngineHarness {
  if (harness.engines === null) {
    throw new Error('this gateway harness was built without engine routes');
  }
  return harness.engines;
}

function createEngineHarness(
  clock: MutableClock,
  options: { readonly assignments?: Partial<Record<AssetKind, EngineAssignment>> },
): GatewayEngineHarness {
  const pricing = createConfigurablePricingPort();
  const audit = createRecordingAuditSink();
  const adapters = new Map<string, FakeEngineAdapter>();

  const assignments = createEngineAssignmentTable();
  for (const [assetKind, assignment] of Object.entries(options.assignments ?? {})) {
    assignments.set(assetKind as AssetKind, assignment);
  }

  const adapterFactory: EngineAdapterFactoryPort = {
    create(descriptor) {
      const existing = adapters.get(descriptor.engineId);
      if (existing !== undefined) return existing;
      const adapter = createFakeEngineAdapter({ engineId: descriptor.engineId });
      adapters.set(descriptor.engineId, adapter);
      return adapter;
    },
  };

  return {
    registry: new ProviderRegistry({ clock, auditSink: audit, pricing, assignments }),
    pricing,
    audit,
    adapters,
    adapterFactory,
  };
}
