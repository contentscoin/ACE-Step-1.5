import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { EngineAdapterFactoryPort } from '../../adapters/registry/ports';
import type { AssetKind } from '../../domain/asset-kind';
import type { ProviderRegistry } from '../../adapters/registry/provider-registry';
import type { AccountService } from '../../services/account/account-service';
import { systemClock, type Clock } from '../../services/clock';
import type { CreditService } from '../../services/credit';
import type { EditGateway } from '../../services/generation/edit-gateway';
import type { JobEventBusPort } from '../../services/generation/job-events';
import type { JobOrchestrator } from '../../services/generation/job-orchestrator';
import type { JobRuntime } from '../../services/generation/runtime';
import type { SongGateway } from '../../services/generation/song-gateway';
import type { LyricsAssistant } from '../../services/lyrics/lyrics-assistant';
import type { TimedLyricsService } from '../../services/lyrics/timed-lyrics-service';
import type { ReportService } from '../../services/moderation/report-service';
import type { ApiKeyService } from '../../services/public-api/api-key-service';
import type { RateLimiter } from '../../services/public-api/rate-limiter';
import type { ConsentService } from '../../services/voice/consent-service';
import type { ProfileAccessService } from '../../services/voice/profile-access-service';
import type { WithdrawalService } from '../../services/voice/withdrawal-service';

import { createAuthenticationHook, registerAuthenticationDecorator } from './authentication';
import { registerErrorHandler } from './error-handler';
import {
  createApiKeyAuthenticationHook,
  createRateLimitHook,
  registerApiKeyDecorator,
} from './public-api-authentication';
import { registerAccountRoutes } from './routes/account-routes';
import { registerApiKeyRoutes } from './routes/api-key-routes';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerCreditRoutes } from './routes/credit-routes';
import { registerEditRoutes } from './routes/edit-routes';
import { registerEngineRoutes } from './routes/engine-routes';
import { registerGenerationRoutes } from './routes/generation-routes';
import { registerLyricsRoutes } from './routes/lyrics-routes';
import { registerModerationRoutes } from './routes/moderation-routes';
import { registerPublicApiRoutes } from './routes/public-api-routes';
import { registerSongRoutes } from './routes/song-routes';
import { registerVoiceConsentRoutes } from './routes/voice-consent-routes';

export const API_PREFIX = '/v1';

/**
 * The developer surface of Requirement 17, mounted separately from `/v1`.
 *
 * A separate prefix rather than the same one, because the two are authenticated differently —
 * a session cookie/JWT under `/v1`, an API key here — and mounting them together would mean one
 * route table where the credential a route accepts is a property of which hook someone
 * remembered to attach. A prefix makes it a property of the address.
 */
export const PUBLIC_API_PREFIX = '/public/v1';

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
  /**
   * Mounts the Simple/Custom song endpoints (Requirements 3, 4) when supplied.
   *
   * Optional beside the generic lifecycle routes rather than implied by them,
   * because the two are independent: a composition can expose the generic
   * `/generation-jobs` surface without the song-specific one, and the Requirement 5
   * tests stay unaffected by Requirements 3 and 4.
   */
  readonly songGateway?: SongGateway;
  /**
   * Mounts the five Edit_Task endpoints (Requirement 7) when supplied.
   *
   * Independent of `songGateway` for the same reason that one is independent of the
   * generic routes: a composition may expose generation without editing, and an edit
   * needs a Library_Service port that plain generation does not.
   */
  readonly editGateway?: EditGateway;
}

/**
 * Lyrics_Assistant wiring (Requirements 8, 10.8), optional like the blocks above.
 *
 * Independent of `generation`: enrichment creates no Generation_Job and charges
 * nothing (Requirement 8.6), so a composition can offer lyric help without the
 * generation surface, and the Requirement 8 tests need no orchestrator.
 *
 * `timedLyrics` is separately optional because Requirement 10.8's download depends on
 * timings that Transcription_Service (task 2.7) produces; without that source there
 * is nothing to serve, and mounting a route that always answers 404 would be worse
 * than not mounting it.
 */
export interface GatewayLyricsDependencies {
  readonly assistant: LyricsAssistant;
  readonly timedLyrics?: TimedLyricsService;
}

/**
 * Voice consent wiring (Requirements 26.12–26.23, 26.26–26.36), optional like the
 * blocks above.
 *
 * The three services travel together because the routes need all three and splitting
 * them would let a composition mount withdrawal intake without the profile state it
 * transitions — a gateway that can accept a claim but not act on it.
 */
export interface GatewayVoiceConsentDependencies {
  readonly consent: ConsentService;
  readonly withdrawal: WithdrawalService;
  readonly access: ProfileAccessService;
}

/**
 * Public_API wiring (Requirement 17), optional like every other block.
 *
 * The key service and the rate limiter travel together: a developer surface without a limiter
 * would satisfy 17.3 and silently drop 17.7, and the two are attached to the same routes as one
 * ordered pair of hooks — see `public-api-authentication.ts` for why the order matters.
 *
 * `gateways` is per Asset_Kind so the route table is derived from what is actually composed:
 * Requirement 17.11 wants four separate endpoints, and a kind with no gateway gets no endpoint
 * rather than a route that answers 500.
 */
export interface GatewayPublicApiDependencies {
  readonly apiKeys: ApiKeyService;
  readonly rateLimiter: RateLimiter;
  readonly gateways?: Partial<Record<AssetKind, SongGateway>>;
}

export interface GatewayDependencies {
  readonly accountService: AccountService;
  readonly clock?: Clock;
  readonly engines?: GatewayEngineDependencies;
  readonly moderation?: GatewayModerationDependencies;
  /** Mounts the Requirement 26 consent, withdrawal and sharing routes when supplied. */
  readonly voiceConsent?: GatewayVoiceConsentDependencies;
  /** Mounts the Requirement 8 / 10.8 lyric routes when supplied. */
  readonly lyrics?: GatewayLyricsDependencies;
  /** Mounts the Requirement 5 job lifecycle routes when supplied. */
  readonly generation?: GatewayGenerationDependencies;
  /** Mounts the Requirement 2.7 / 2.9–2.11 credit read routes when supplied. */
  readonly creditService?: CreditService;
  /** Mounts the Requirement 17 API key routes and the developer surface when supplied. */
  readonly publicApi?: GatewayPublicApiDependencies;
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
  registerApiKeyDecorator(app);
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
      if (deps.voiceConsent !== undefined) {
        registerVoiceConsentRoutes(scope, {
          consent: deps.voiceConsent.consent,
          withdrawal: deps.voiceConsent.withdrawal,
          access: deps.voiceConsent.access,
          authenticate,
        });
      }
      if (deps.creditService !== undefined) {
        registerCreditRoutes(scope, { creditService: deps.creditService, authenticate });
      }
      if (deps.publicApi !== undefined) {
        // Issuing a key is a signed-in action, not an API-key one: minting a credential with a
        // credential means a leaked key can mint its own successors.
        registerApiKeyRoutes(scope, { apiKeys: deps.publicApi.apiKeys, authenticate });
      }
      if (deps.lyrics !== undefined) {
        registerLyricsRoutes(scope, {
          assistant: deps.lyrics.assistant,
          authenticate,
          ...(deps.lyrics.timedLyrics === undefined
            ? {}
            : { timedLyrics: deps.lyrics.timedLyrics }),
        });
      }
      if (deps.generation !== undefined) {
        registerGenerationRoutes(scope, {
          orchestrator: deps.generation.orchestrator,
          events: deps.generation.events,
          runtime: deps.generation.runtime,
          clock,
          authenticate,
        });
        if (deps.generation.songGateway !== undefined) {
          registerSongRoutes(scope, { gateway: deps.generation.songGateway, authenticate });
        }
        if (deps.generation.editGateway !== undefined) {
          registerEditRoutes(scope, { gateway: deps.generation.editGateway, authenticate });
        }
      }
    },
    { prefix: API_PREFIX },
  );

  if (deps.publicApi !== undefined && deps.generation !== undefined) {
    const publicApi = deps.publicApi;
    const generation = deps.generation;
    app.register(
      async (scope) => {
        registerPublicApiRoutes(scope, {
          // Order matters: authenticate, then count. See `public-api-authentication.ts`.
          preHandlers: [
            createApiKeyAuthenticationHook(publicApi.apiKeys),
            createRateLimitHook(publicApi.rateLimiter),
          ],
          orchestrator: generation.orchestrator,
          gateways: publicApi.gateways ?? {},
          ...(deps.creditService === undefined ? {} : { creditService: deps.creditService }),
          ...(deps.engines === undefined ? {} : { registry: deps.engines.registry }),
        });
      },
      { prefix: PUBLIC_API_PREFIX },
    );
  }

  return app;
}
