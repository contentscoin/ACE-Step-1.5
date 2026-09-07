/**
 * `npm start`.
 *
 *     MUSICSTUDIO_DATABASE_URL=postgresql://… MUSICSTUDIO_REDIS_URL=redis://… \
 *     MUSICSTUDIO_JWT_SECRET=… MUSICSTUDIO_PUBLIC_BASE_URL=http://localhost:8080 npm start
 *
 * Everything else defaults to a local ACE-Step on 8001, a local DSP sidecar on 8002 and
 * `data/objects` for audio; see `config.ts`. A configuration error is printed and the process
 * exits non-zero before anything listens, so a misconfigured deployment fails its health check
 * rather than serving a gateway that cannot store what it generates.
 */

import { startGateway } from './server';

try {
  await startGateway();
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({ event: 'gateway.start_failed', error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
}
