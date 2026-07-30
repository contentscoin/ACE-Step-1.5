import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AccountService } from '../../services/account/account-service';
import { systemClock, type Clock } from '../../services/account/clock';

import { createAuthenticationHook, registerAuthenticationDecorator } from './authentication';
import { registerErrorHandler } from './error-handler';
import { registerAccountRoutes } from './routes/account-routes';
import { registerAuthRoutes } from './routes/auth-routes';

export const API_PREFIX = '/v1';

export interface GatewayDependencies {
  readonly accountService: AccountService;
  readonly clock?: Clock;
  readonly fastifyOptions?: FastifyServerOptions;
}

/**
 * Builds the API gateway (design §2.2).
 *
 * Returned unstarted so tests can drive it through `app.inject()` without
 * binding a port, which is what lets the signup -> login -> protected-call
 * end-to-end criterion run with no network at all.
 */
export function buildGatewayApp(deps: GatewayDependencies): FastifyInstance {
  const clock = deps.clock ?? systemClock;
  const app = Fastify({
    logger: false,
    // Requirement 1: credentials must never appear in a log or an echoed error.
    // Set through `logController` rather than the top-level
    // `disableRequestLogging`, which Fastify 5 deprecates and Fastify 6 removes.
    logController: new LogController({ disableRequestLogging: true }),
    ...deps.fastifyOptions,
  });

  registerErrorHandler(app);
  registerAuthenticationDecorator(app);
  const authenticate = createAuthenticationHook(deps.accountService);

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(
    async (scope) => {
      registerAuthRoutes(scope, { accountService: deps.accountService, clock });
      registerAccountRoutes(scope, { authenticate });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
