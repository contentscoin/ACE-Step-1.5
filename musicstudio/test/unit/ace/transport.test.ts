import { describe, expect, it } from 'vitest';

import { createAceHttpTransport } from '../../../adapters/ace/transport';

/** What the production transport puts on the wire, read off an injected `fetch`. */

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function capturingFetch(body: unknown): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('createAceHttpTransport.getJson', () => {
  it('sends a GET with the bearer token and decodes the envelope', async () => {
    const { fetchImpl, calls } = capturingFetch({ data: { status: 'ok' }, code: 200 });
    const transport = createAceHttpTransport({
      baseUrl: 'http://engine.test:8001/',
      apiToken: 'secret',
      fetchImpl,
    });

    const response = await transport.getJson({ path: '/health', query: {} });

    expect(response).toEqual({ httpStatus: 200, envelope: { data: { status: 'ok' }, code: 200 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://engine.test:8001/health');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer secret' });
  });

  it('sends no authorization header when no token is configured', async () => {
    const { fetchImpl, calls } = capturingFetch({ data: null });
    const transport = createAceHttpTransport({ baseUrl: 'http://engine.test', fetchImpl });

    await transport.getJson({ path: '/health', query: { verbose: '1' } });

    expect(calls[0]?.url).toBe('http://engine.test/health?verbose=1');
    expect(calls[0]?.init?.headers).toEqual({});
  });
});

describe('createAceHttpTransport.getBinary', () => {
  it('encodes the engine path as one query value', async () => {
    const { fetchImpl, calls } = capturingFetch({});
    const transport = createAceHttpTransport({ baseUrl: 'http://engine.test', fetchImpl });

    await transport.getBinary({ path: '/v1/audio', query: { path: '/tmp/a b.flac' } });

    expect(calls[0]?.url).toBe('http://engine.test/v1/audio?path=%2Ftmp%2Fa+b.flac');
    expect(calls[0]?.init?.method).toBe('GET');
  });
});
