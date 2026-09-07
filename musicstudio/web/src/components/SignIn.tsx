/**
 * Sign in, or register, against the gateway (Requirements 1.1, 1.2, 1.3).
 *
 * The smallest screen that makes a gateway build usable. Track C2 in the roadmap is the login
 * *screen* — the routed one, with password recovery and the social providers Requirement 1.7
 * allows; this is the panel the shell shows instead of a screen while there is no credential,
 * because a gateway build without one can render nothing else truthfully.
 *
 * ### Register and sign in are one form with two buttons
 *
 * They take the same two fields and differ in which route they post to, and a person arriving at
 * a fresh deployment does not know which they need. Two forms would make them choose first; two
 * buttons let them try one and press the other. Requirement 1.2's duplicate-email refusal is
 * what tells someone registering that they already have an account, and it is shown verbatim.
 *
 * ### The gateway's own words
 *
 * Every refusal here is rendered from the error body's `message`, not from a sentence written
 * here per status code. Requirement 1.2's 409, 1.6's weak password and 1.3's wrong password all
 * arrive with a `code` and a message the gateway chose, and restating them on this side would be
 * a second place for the product's wording to live.
 */

import { useState, type FormEvent, type ReactNode } from 'react';

import { GatewayError } from '../lib/api/http-api';
import { useGatewaySession } from '../lib/api/session-context';
import type { SessionTokens } from '../lib/api/session';
import { button, column, input, label, meta, panel, primaryButton, row } from '../styles/ui';
import { StatusMessage } from './StatusMessage';

export interface SignInProps {
  /** The gateway origin, so this can post without a `StudioApi` (there is no session yet). */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

type Busy = 'idle' | 'signing-in' | 'registering';

export function SignIn({ baseUrl, fetchImpl }: SignInProps): ReactNode {
  const session = useGatewaySession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<Busy>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  const send = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const origin = baseUrl.replace(/\/+$/, '');

  async function post(path: string): Promise<unknown> {
    const response = await send(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: unknown; message?: unknown };
      };
      throw new GatewayError(
        response.status,
        typeof body.error?.code === 'string' ? body.error.code : 'request_failed',
        typeof body.error?.message === 'string'
          ? body.error.message
          : `게이트웨이가 ${String(response.status)}을 반환했습니다.`,
      );
    }
    return response.json();
  }

  async function run(kind: Busy, action: () => Promise<void>): Promise<void> {
    setBusy(kind);
    setFailure(null);
    try {
      await action();
    } catch (error: unknown) {
      setFailure(
        error instanceof GatewayError
          ? error.message
          : '게이트웨이에 연결하지 못했습니다. 주소와 실행 상태를 확인해 주세요.',
      );
    } finally {
      setBusy('idle');
    }
  }

  const signIn = (event: FormEvent): void => {
    event.preventDefault();
    void run('signing-in', async () => {
      const tokens = (await post('/v1/auth/login')) as SessionTokens;
      session?.set({
        accountId: tokens.accountId,
        email: tokens.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    });
  };

  const register = (): void => {
    void run('registering', async () => {
      await post('/v1/auth/register');
      // Registration does not sign anyone in — Requirement 1.1 creates the account and 1.3 is a
      // separate act — so this says so rather than leaving the form looking as if nothing
      // happened. The password is still in the field, so the next press is one click away.
      setRegistered(true);
    });
  };

  return (
    <form style={{ ...panel, ...column, gap: 12, maxWidth: 420 }} onSubmit={signIn}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>로그인</h2>
        <p style={meta}>
          이 빌드는 <code>{origin}</code>의 게이트웨이에 연결되어 있습니다. 계정이 있어야 생성과
          라이브러리를 사용할 수 있습니다.
        </p>
      </div>

      <label style={column}>
        <span style={label}>이메일</span>
        <input
          style={input}
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>

      <label style={column}>
        <span style={label}>비밀번호</span>
        <input
          style={input}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>

      {failure !== null && (
        <StatusMessage kind="error" role="alert">
          {failure}
        </StatusMessage>
      )}
      {registered && failure === null && (
        <StatusMessage kind="success" role="status">
          계정을 만들었습니다. 같은 정보로 로그인해 주세요.
        </StatusMessage>
      )}

      <div style={{ ...row, gap: 8 }}>
        <button type="submit" style={primaryButton} disabled={busy !== 'idle'}>
          {busy === 'signing-in' ? '로그인 중…' : '로그인'}
        </button>
        <button type="button" style={button} onClick={register} disabled={busy !== 'idle'}>
          {busy === 'registering' ? '가입 중…' : '가입'}
        </button>
      </div>
    </form>
  );
}
