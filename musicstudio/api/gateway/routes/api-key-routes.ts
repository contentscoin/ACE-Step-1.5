import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type { ApiKeyService } from '../../../services/public-api/api-key-service';
import { requireAccount } from '../authentication';
import {
  clearWebhookSchema,
  issueApiKeySchema,
  listApiKeysSchema,
  revokeApiKeySchema,
  setWebhookSchema,
} from '../schemas/public-api-schemas';

/**
 * API key management (Requirements 17.1, 17.2, 17.9, 17.10, 17.14).
 *
 * These sit on the **session-authenticated** surface, not the API-key one, and that is the
 * point: minting a credential with a credential means a leaked key can mint its own successors,
 * so revoking the leaked one accomplishes nothing. A person signs in to issue a key, and the
 * key can do everything except make another.
 *
 * The 201 body is the only response in the product that contains a key. It is documented as
 * such in the schema so a client library generated from it stores the value on that one call
 * rather than expecting to read it back later.
 */
export interface ApiKeyRouteOptions {
  readonly apiKeys: ApiKeyService;
  readonly authenticate: preHandlerHookHandler;
}

export function registerApiKeyRoutes(app: FastifyInstance, options: ApiKeyRouteOptions): void {
  const { apiKeys, authenticate } = options;

  // Requirements 17.1, 17.2 — the one and only exposure of the plaintext.
  app.post<{ Body: { label: string } }>(
    '/api-keys',
    { schema: issueApiKeySchema, preHandler: authenticate },
    async (request, reply) => {
      const account = requireAccount(request);
      const issued = await apiKeys.issue(account.accountId, request.body.label);
      return reply.code(201).send(issued);
    },
  );

  // Requirement 17.9 — summaries, so this route cannot return a key.
  app.get('/api-keys', { schema: listApiKeysSchema, preHandler: authenticate }, async (request) => {
    const account = requireAccount(request);
    return { keys: await apiKeys.list(account.accountId) };
  });

  // Requirement 17.9.
  app.delete<{ Params: { keyId: string } }>(
    '/api-keys/:keyId',
    { schema: revokeApiKeySchema, preHandler: authenticate },
    async (request) => {
      const account = requireAccount(request);
      return apiKeys.revoke(account.accountId, request.params.keyId);
    },
  );

  // Requirements 17.10, 17.14 — one endpoint per key. `PUT`, because registering the same URL
  // twice is the same state and should not be an error.
  app.put<{ Params: { keyId: string }; Body: { url: string } }>(
    '/api-keys/:keyId/webhook',
    { schema: setWebhookSchema, preHandler: authenticate },
    async (request, reply) => {
      const account = requireAccount(request);
      await apiKeys.setWebhook(account.accountId, request.params.keyId, request.body.url);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { keyId: string } }>(
    '/api-keys/:keyId/webhook',
    { schema: clearWebhookSchema, preHandler: authenticate },
    async (request, reply) => {
      const account = requireAccount(request);
      await apiKeys.clearWebhook(account.accountId, request.params.keyId);
      return reply.code(204).send();
    },
  );
}
