import type { FastifyInstance } from 'fastify';

import type { AccountService } from '../../../services/account/account-service';
import { systemClock, type Clock } from '../../../services/account/clock';
import { presentLogin, presentSocialLogin, type TokenPairBody } from '../presenters';
import {
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  socialAuthorizeSchema,
  socialCallbackSchema,
  verifyEmailSchema,
} from '../schemas/auth-schemas';

export interface AuthRouteOptions {
  readonly accountService: AccountService;
  readonly clock?: Clock;
}

interface CredentialsBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refreshToken: string;
}

interface ProviderParams {
  provider: string;
}

/**
 * Authentication routes (Requirement 1).
 *
 * Handlers stay thin on purpose: validation is the schema's job, failure
 * translation is the error handler's job, and the account rules live in
 * Account_Service. Each route is one call plus one presenter.
 */
export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const clock = options.clock ?? systemClock;
  const { accountService } = options;

  // Requirements 1.1, 1.2, 1.6.
  app.post<{ Body: CredentialsBody }>(
    '/auth/register',
    { schema: registerSchema },
    async (request, reply) => {
      const result = await accountService.register(request.body);
      return reply.code(201).send(result);
    },
  );

  // Requirements 1.3, 1.4, 1.5.
  app.post<{ Body: CredentialsBody }>(
    '/auth/login',
    { schema: loginSchema },
    async (request): Promise<TokenPairBody> =>
      presentLogin(await accountService.login(request.body), clock),
  );

  app.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    { schema: refreshSchema },
    async (request): Promise<TokenPairBody> =>
      presentLogin(await accountService.refresh(request.body), clock),
  );

  app.post<{ Body: RefreshBody }>(
    '/auth/logout',
    { schema: logoutSchema },
    async (request, reply) => {
      await accountService.logout(request.body);
      return reply.code(204).send();
    },
  );

  // Completes the verification link from Requirement 1.1.
  app.post<{ Body: { token: string } }>(
    '/auth/verify-email',
    { schema: verifyEmailSchema },
    async (request) => {
      const verified = await accountService.verifyEmail(request.body);
      return { ...verified, emailVerified: true };
    },
  );

  // Requirement 1.7 — 404 `social_login_not_configured` when unconfigured.
  app.get<{ Params: ProviderParams; Querystring: { redirectUri: string } }>(
    '/auth/social/:provider/authorize',
    { schema: socialAuthorizeSchema },
    async (request) =>
      accountService.beginAuthorization({
        provider: request.params.provider,
        redirectUri: request.query.redirectUri,
      }),
  );

  app.post<{
    Params: ProviderParams;
    Body: { code: string; state: string; expectedState: string; redirectUri: string };
  }>('/auth/social/:provider/callback', { schema: socialCallbackSchema }, async (request) =>
    presentSocialLogin(
      await accountService.completeAuthorization({
        provider: request.params.provider,
        ...request.body,
      }),
      clock,
    ),
  );
}
