import type { FastifyInstance } from 'fastify';

import { buildGatewayApp } from '../../api/gateway/app';
import {
  createAccountService,
  type AccountService,
} from '../../services/account/account-service';
import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../services/account/adapters/redis-session-store';
import type { OAuthProvider } from '../../services/account/oauth-provider';

import { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { EngineAdapterFactoryPort } from '../../adapters/registry/ports';
import { createEngineAssignmentTable } from '../../adapters/registry/default-engines';
import type { EngineAssignment } from '../../adapters/registry/default-engines';
import type { AssetKind } from '../../domain/asset-kind';

import { createFakeEngineAdapter, type FakeEngineAdapter } from './fake-engine-adapter';
import { createFakeRedis, type FakeRedis } from './fake-redis';
import {
  createInMemoryAccountRepository,
  type InMemoryAccountRepository,
} from './in-memory-account-repository';
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

export interface GatewayHarness {
  readonly app: FastifyInstance;
  readonly accountService: AccountService;
  readonly clock: MutableClock;
  readonly redis: FakeRedis;
  readonly repository: InMemoryAccountRepository;
  readonly emails: RecordingEmailSender;
  readonly engines: GatewayEngineHarness | null;
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

  const app = buildGatewayApp({
    accountService,
    clock,
    ...(engines === null
      ? {}
      : { engines: { registry: engines.registry, adapterFactory: engines.adapterFactory } }),
  });

  return {
    app,
    accountService,
    clock,
    redis,
    repository,
    emails,
    engines,
    close: () => app.close(),
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
