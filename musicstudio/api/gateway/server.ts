import { createAccountService } from '../../services/account/account-service';
import { createLoggingEmailSender } from '../../services/account/adapters/logging-email-sender';
import { createRedisConnection } from '../../services/account/adapters/redis-client';
import { createRedisLoginAttemptStore } from '../../services/account/adapters/redis-login-attempt-store';
import { createRedisSessionStore } from '../../services/account/adapters/redis-session-store';
import type { AccountRepository } from '../../services/account/account-repository';

import { buildGatewayApp } from './app';
import { loadGatewayConfig } from './config';
import { buildSocialProviders } from './social-providers';

/**
 * Production bootstrap: configuration -> real adapters -> app -> listen.
 *
 * Composition only, no logic, therefore no unit tests; the behaviour it wires
 * is covered through `buildGatewayApp` with injected doubles.
 *
 * The PostgreSQL-backed `AccountRepository` arrives with the schema work in
 * task 1.1, so it is injected here rather than constructed.
 */
export interface BootstrapDependencies {
  readonly repository: AccountRepository;
}

export async function startGateway(deps: BootstrapDependencies): Promise<void> {
  const config = loadGatewayConfig();
  const redis = createRedisConnection(config.redisUrl);

  const accountService = createAccountService({
    repository: deps.repository,
    sessionStore: createRedisSessionStore({ commands: redis }),
    loginAttemptStore: createRedisLoginAttemptStore({ commands: redis }),
    emailSender: createLoggingEmailSender(),
    jwtSecret: config.jwtSecret,
    publicBaseUrl: config.publicBaseUrl,
    passwordHashCost: config.passwordHashCost,
    oauthProviders: buildSocialProviders(config),
  });

  const app = buildGatewayApp({ accountService, fastifyOptions: { logger: true } });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await redis.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
}
