import { composeGateway, type ComposedGateway } from './composition';
import { loadGatewayConfig, type Environment } from './config';
import { applyPendingMigrations } from './database';

/**
 * Production bootstrap: configuration -> composition -> listen.
 *
 * Composition only, no logic, therefore no unit tests of its own; the composition it calls is
 * exercised by `test/integration/composition-root.test.ts` through `app.inject()`, and the
 * behaviour behind every route by the suites over `buildGatewayApp`.
 *
 * Signals stop the loops before the listener: a poll that fires during shutdown would try to
 * publish an asset through a pool that is closing.
 */
export async function startGateway(env: Environment = process.env): Promise<ComposedGateway> {
  const config = loadGatewayConfig(env);

  if (config.migrateOnStart) {
    const applied = await applyPendingMigrations(config.databaseUrl);
    process.stdout.write(`${JSON.stringify({ event: 'database.migrated', applied })}\n`);
  }

  const gateway = composeGateway(config);
  await gateway.start();

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stdout.write(`${JSON.stringify({ event: 'gateway.stopping', signal })}\n`);
    void gateway.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${JSON.stringify({ event: 'gateway.stop_failed', error: String(error) })}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await gateway.app.listen({ host: config.host, port: config.port });
  return gateway;
}
