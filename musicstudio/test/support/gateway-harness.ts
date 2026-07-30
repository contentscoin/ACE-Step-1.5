import type { FastifyInstance } from 'fastify';

import { buildGatewayApp } from '../../api/gateway/app';
import {
  createAccountService,
  type AccountService,
} from '../../services/account/account-service';
import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../services/account/adapters/redis-session-store';
import type { OAuthProvider } from '../../services/account/oauth-provider';

import { createFakeRedis, type FakeRedis } from './fake-redis';
import {
  createInMemoryAccountRepository,
  type InMemoryAccountRepository,
} from './in-memory-account-repository';
import { createMutableClock, type MutableClock } from './mutable-clock';
import { createRecordingEmailSender, type RecordingEmailSender } from './recording-email-sender';

export const HARNESS_JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
export const HARNESS_BASE_URL = 'https://studio.test';

export interface GatewayHarness {
  readonly app: FastifyInstance;
  readonly accountService: AccountService;
  readonly clock: MutableClock;
  readonly redis: FakeRedis;
  readonly repository: InMemoryAccountRepository;
  readonly emails: RecordingEmailSender;
  close(): Promise<void>;
}

export interface GatewayHarnessOptions {
  readonly oauthProviders?: readonly OAuthProvider[];
  /** Requirement 1.6 forbids anything below 12; tests keep the real cost. */
  readonly passwordHashCost?: number;
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

  const app = buildGatewayApp({ accountService, clock });

  return {
    app,
    accountService,
    clock,
    redis,
    repository,
    emails,
    close: () => app.close(),
  };
}
