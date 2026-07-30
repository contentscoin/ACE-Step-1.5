import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import type { EngineDescriptor } from '../../../adapters/registry/engine-descriptor';
import { engineNotFound } from '../../../adapters/registry/errors';
import type { EngineAdapterFactoryPort } from '../../../adapters/registry/ports';
import type { ProviderRegistry } from '../../../adapters/registry/provider-registry';
import { selectionCatalogueFor } from '../../../adapters/registry/selection-catalogue';
import type { AssetKind } from '../../../domain/asset-kind';
import { requireAccount } from '../authentication';
import {
  deactivateEngineSchema,
  deleteEngineSchema,
  engineSelectionSchema,
  getEngineSchema,
  listEnginesSchema,
  registerEngineSchema,
  setDefaultEngineSchema,
  updateEngineSchema,
} from '../schemas/engine-schemas';

/**
 * Engine_Descriptor CRUD and engine list routes (design §3.2; Requirements 20.1,
 * 20.9, 20.17, 20.19, 20.20, 20.23).
 *
 * Every mutating route is behind the existing auth middleware, and the acting
 * account id is what Requirement 20.20 records as the audit actor — which is why
 * registration cannot be anonymous.
 */
export interface EngineRouteOptions {
  readonly registry: ProviderRegistry;
  readonly adapterFactory: EngineAdapterFactoryPort;
  readonly authenticate: preHandlerHookHandler;
}

export function registerEngineRoutes(app: FastifyInstance, options: EngineRouteOptions): void {
  const { registry, adapterFactory } = options;

  // Requirements 20.1, 20.16/20.17, 20.23, 20.20.
  app.post<{ Body: EngineDescriptor }>(
    '/engines',
    { schema: registerEngineSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      const descriptor = request.body;
      const adapter = adapterFactory.create(descriptor);
      if (adapter === undefined) {
        throw engineNotFound(descriptor.engineId);
      }

      const result = registry.register({ descriptor, adapter, actorId: actor.accountId });
      // 201 even when the pricing entry is missing: Requirement 20.17 registers
      // the engine inactive and reports the gap rather than refusing it.
      return reply.code(201).send(result);
    },
  );

  // Requirement 20.19 — optionally narrowed to one Asset_Kind.
  app.get<{ Querystring: { assetKind?: AssetKind } }>(
    '/engines',
    { schema: listEnginesSchema, preHandler: options.authenticate },
    async (request) => {
      const { assetKind } = request.query;
      const engines = registry
        .listEngines()
        .filter((listing) => assetKind === undefined || listing.supportedAssetKinds.includes(assetKind));
      return { engines };
    },
  );

  // Requirement 20.9.
  app.get<{ Querystring: { assetKind: AssetKind } }>(
    '/engines/selection',
    { schema: engineSelectionSchema, preHandler: options.authenticate },
    async (request) => ({
      assetKind: request.query.assetKind,
      engines: selectionCatalogueFor(registry, request.query.assetKind),
    }),
  );

  app.get<{ Params: { engineId: string } }>(
    '/engines/:engineId',
    { schema: getEngineSchema, preHandler: options.authenticate },
    async (request) => listingOf(registry, request.params.engineId),
  );

  app.put<{ Params: { engineId: string }; Body: EngineDescriptor }>(
    '/engines/:engineId',
    { schema: updateEngineSchema, preHandler: options.authenticate },
    async (request) => {
      const actor = requireAccount(request);
      registry.update(request.params.engineId, request.body, actor.accountId);
      return listingOf(registry, request.params.engineId);
    },
  );

  // Requirement 20.20 deactivation event.
  app.post<{ Params: { engineId: string } }>(
    '/engines/:engineId/deactivate',
    { schema: deactivateEngineSchema, preHandler: options.authenticate },
    async (request) => {
      const actor = requireAccount(request);
      registry.setActivation(request.params.engineId, 'inactive', actor.accountId);
      return listingOf(registry, request.params.engineId);
    },
  );

  app.delete<{ Params: { engineId: string } }>(
    '/engines/:engineId',
    { schema: deleteEngineSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const actor = requireAccount(request);
      registry.remove(request.params.engineId, actor.accountId);
      return reply.code(204).send();
    },
  );

  // Requirements 20.2, 20.20.
  app.put<{ Params: { assetKind: AssetKind }; Body: { engineId: string } }>(
    '/engine-defaults/:assetKind',
    { schema: setDefaultEngineSchema, preHandler: options.authenticate },
    async (request) => {
      const actor = requireAccount(request);
      const { assetKind } = request.params;
      registry.setDefaultEngine(assetKind, request.body.engineId, actor.accountId);
      const assignment = registry.assignmentFor(assetKind);
      return {
        assetKind,
        defaultEngineId: assignment?.defaultEngineId ?? request.body.engineId,
        fallbackEngineId: assignment?.fallbackEngineId ?? null,
      };
    },
  );
}

function listingOf(registry: ProviderRegistry, engineId: string) {
  registry.require(engineId);
  const listing = registry.listEngines().find((entry) => entry.engineId === engineId);
  if (listing === undefined) throw engineNotFound(engineId);
  return listing;
}
