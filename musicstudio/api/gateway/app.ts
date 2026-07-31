import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { EngineAdapterFactoryPort } from '../../adapters/registry/ports';
import type { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { AccountService } from '../../services/account/account-service';
import { systemClock, type Clock } from '../../services/clock';
import type { CreditService } from '../../services/credit';
import type { JobEventBusPort } from '../../services/generation/job-events';
import type { JobOrchestrator } from '../../services/generation/job-orchestrator';
import type { JobRuntime } from '../../services/generation/runtime';
import type { ReportService } from '../../services/moderation/report-service';

import { createAuthenticationHook, registerAuthenticationDecorator } from './authentication';
import { registerErrorHandler } from './error-handler';
import { registerAccountRoutes } from './routes/account-routes';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerCreditRoutes } from './routes/credit-routes';
import { registerEngineRoutes } from './routes/engine-routes';
import { registerGenerationRoutes } from './routes/generation-routes';
import { registerModerationRoutes } from './routes/moderation-routes';

export const API_PREFIX = '/v1';

/**
 * Provider_Registry wiring is optional: an auth-only gateway is still a valid
 * composition, and leaving it out keeps the Requirement 1 tests independent of
 * the engine layer.
 */
export interface GatewayEngineDependencies {
  readonly registry: ProviderRegistry;
  readonly adapterFactory: EngineAdapterFactoryPort;
}

/**
 * Moderation wiring is optional for the same reason engine wiring is: a gateway
 * without report intake is a valid composition, and the Requirement 1 and 20 tests
 * stay independent of Requirement 16.
 */
export interface GatewayModerationDependencies {
  readonly reports: ReportService;
}

/**
 * Generation_Job wiring, optional like the engine and moderation blocks.
 *
 * The event bus is passed explicitly rather than read off the runtime so it is
 * visible at the composition site that the SSE routes and the orchestrator share
 * one bus — which is what the Requirement 5.4 delivery bound depends on.
 */
export interface GatewayGenerationDependencies {
  readonly orchestrator: JobOrchestrator;
  readonly events: JobEventBusPort;
  readonly runtime: JobRuntime;
}

export interface GatewayDependencies {
  readonly accountService: AccountService;
  readonly clock?: Clock;
  readonly engines?: GatewayEngineDependencies;
  readonly moderation?: GatewayModerationDependencies;
  /** Mounts the Requirement 5 job lifecycle routes when supplied. */
  readonly generation?: GatewayGenerationDependencies;
  /** Mounts the Requirement 2.7 / 2.9–2.11 credit read routes when supplied. */
  readonly creditService?: CreditService;
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
      if (deps.engines !== undefined) {
        registerEngineRoutes(scope, {
          registry: deps.engines.registry,
          adapterFactory: deps.engines.adapterFactory,
          authenticate,
        });
      }
      if (deps.moderation !== undefined) {
        registerModerationRoutes(scope, { reports: deps.moderation.reports, authenticate });
      }
      if (deps.creditService !== undefined) {
        registerCreditRoutes(scope, { creditService: deps.creditService, authenticate });
      }
      if (deps.generation !== undefined) {
        registerGenerationRoutes(scope, {
          orchestrator: deps.generation.orchestrator,
          events: deps.generation.events,
          runtime: deps.generation.runtime,
          clock,
          authenticate,
        });
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}
