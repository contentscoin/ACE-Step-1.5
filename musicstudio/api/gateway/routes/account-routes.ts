import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import { requireAccount } from '../authentication';
import { currentAccountSchema } from '../schemas/auth-schemas';

export interface AccountRouteOptions {
  readonly authenticate: preHandlerHookHandler;
}

/**
 * Protected account routes.
 *
 * `GET /v1/me` is the reference protected endpoint for the task's end-to-end
 * criterion (signup -> login -> token -> protected call), and the route that
 * demonstrates Requirement 1.8: with an expired access token it answers 401
 * with reason code `token_expired`.
 */
export function registerAccountRoutes(app: FastifyInstance, options: AccountRouteOptions): void {
  app.get(
    '/me',
    { schema: currentAccountSchema, preHandler: options.authenticate },
    async (request) => {
      const account = requireAccount(request);
      return {
        accountId: account.accountId,
        email: account.email,
        emailVerified: account.emailVerified,
        sessionId: account.sessionId,
      };
    },
  );
}
