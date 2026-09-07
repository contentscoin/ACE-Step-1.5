/**
 * Which backend this build talks to (roadmap §4.4, slice S7).
 *
 * One environment variable decides it, and it decides it by being *present*: `VITE_MUSICSTUDIO_API_URL`
 * names a gateway, and its absence is the demo. There is no `VITE_USE_DEMO` to disagree with it,
 * because two switches for one decision is how a build ends up pointing at a gateway while
 * telling the user it is a demo — and `DemoModeBanner` is careful not to rely on a flag for
 * exactly that reason. It reads `api.backend`, which is decided here and nowhere else.
 */

import { createDemoApi } from './demo-api';
import { createHttpApi } from './http-api';
import type { StudioApi } from './port';
import { createSession, type Session } from './session';

export interface StudioBackend {
  readonly api: StudioApi;
  /** The gateway session, or `null` for the demo backend, which has no accounts. */
  readonly session: Session | null;
  /** The configured origin, so the sign-in panel does not have to read the environment again. */
  readonly gatewayUrl: string | null;
}

/**
 * The configured gateway origin, or `null` when this build is a demo.
 *
 * The trailing slash is trimmed here, once, so every consumer holds the same string: the client
 * and the sign-in panel both build paths onto it, and two of them trimming separately is two
 * places for `//v1/auth/login` to appear.
 */
export function configuredGatewayUrl(env: Readonly<Record<string, unknown>>): string | null {
  const value = env.VITE_MUSICSTUDIO_API_URL;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

export function createStudioBackend(
  env: Readonly<Record<string, unknown>> = import.meta.env,
): StudioBackend {
  const baseUrl = configuredGatewayUrl(env);
  if (baseUrl === null) return { api: createDemoApi(), session: null, gatewayUrl: null };

  const session = createSession({ baseUrl });
  return { api: createHttpApi({ baseUrl, session }), session, gatewayUrl: baseUrl };
}
