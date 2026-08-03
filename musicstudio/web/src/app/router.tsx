/**
 * A hash router, in forty lines.
 *
 * ### Why not React Router
 *
 * Design §8.1 fixes the stack — React, Tailwind, Motion, Amicro, Zustand, React Query, Vite — and
 * a router is not on it. Adding one would be a dependency the design did not choose, carrying its
 * own licence obligation (Requirement 31.17) and its own version floor to keep. What this app
 * needs from a router is a location and a way to change it, and that is `hashchange`.
 *
 * The hash rather than the History API because the build is a static bundle: a deep link under
 * `/library/asset-1` needs a server rewriting unknown paths to `index.html`, and the app has no
 * server yet (task 9.1). A hash works from `file://`, from a preview, and from any static host.
 *
 * If a later task needs nested routes, loaders or transitions, this is a small thing to replace —
 * every screen takes its parameters as props and none of them imports the router.
 */

import { useEffect, useState } from 'react';

export interface Route {
  readonly name: string;
  /** The segment after the route name, when there is one: `#/asset/asset-1` → `asset-1`. */
  readonly parameter: string | null;
}

export const DEFAULT_ROUTE: Route = { name: 'generate', parameter: null };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const [name = '', parameter] = path.split('/');
  if (name === '') return DEFAULT_ROUTE;
  return { name, parameter: parameter === undefined || parameter === '' ? null : parameter };
}

export function hrefFor(name: string, parameter?: string): string {
  return parameter === undefined ? `#/${name}` : `#/${name}/${parameter}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(globalThis.location?.hash ?? ''),
  );

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(globalThis.location.hash));
    };
    globalThis.addEventListener('hashchange', onChange);
    return () => {
      globalThis.removeEventListener('hashchange', onChange);
    };
  }, []);

  return route;
}

/** Navigate without a full render pass through the browser's own history stack. */
export function navigate(name: string, parameter?: string): void {
  globalThis.location.hash = hrefFor(name, parameter);
}
