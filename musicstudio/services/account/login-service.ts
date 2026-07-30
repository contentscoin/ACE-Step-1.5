import type { AccountRepository } from './account-repository';
import { normalizeEmail } from './email';
import { accountNotFound, invalidCredentials, sessionNotFound } from './errors';
import type { LoginThrottle } from './login-throttle';
import type { PasswordHasher } from './password-hasher';
import type { SessionIssuer } from './session-issuer';
import type { SessionStore } from './session-store';
import type { TokenPair, TokenService } from './token-service';

export interface AuthenticatedAccount {
  readonly accountId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly sessionId: string;
}

export interface LoginResult {
  readonly accountId: string;
  readonly email: string;
  readonly tokens: TokenPair;
}

export interface LoginService {
  /** Requirements 1.3, 1.4, 1.5. */
  login(input: { email: string; password: string }): Promise<LoginResult>;
  /** Exchanges a refresh token for a fresh pair. */
  refresh(input: { refreshToken: string }): Promise<LoginResult>;
  logout(input: { refreshToken: string }): Promise<void>;
  /** Requirement 1.8 — the guard every protected route runs. */
  authenticateAccessToken(accessToken: string): Promise<AuthenticatedAccount>;
}

export interface LoginServiceOptions {
  readonly repository: AccountRepository;
  readonly passwordHasher: PasswordHasher;
  readonly throttle: LoginThrottle;
  readonly sessionIssuer: SessionIssuer;
  readonly sessionStore: SessionStore;
  readonly tokenService: TokenService;
}

export function createLoginService(options: LoginServiceOptions): LoginService {
  const { repository, passwordHasher, throttle, sessionIssuer, sessionStore, tokenService } =
    options;

  async function loadAccount(accountId: string) {
    const account = await repository.findById(accountId);
    if (account === null) {
      throw accountNotFound();
    }
    return account;
  }

  return {
    async login({ email, password }): Promise<LoginResult> {
      const normalized = normalizeEmail(email);

      // Requirement 1.5 is checked before the credential itself, so a locked
      // account cannot be probed during the lock window.
      await throttle.assertNotLocked(normalized);

      const account = await repository.findByEmail(normalized);
      const passwordMatches =
        account?.passwordHash != null &&
        (await passwordHasher.verify(password, account.passwordHash));

      if (account === null || !passwordMatches) {
        // Requirement 1.4: the failure counter advances for every rejected
        // attempt. Keying it on the submitted address (not the account row)
        // keeps unknown addresses from being cheaper to probe.
        await throttle.recordFailure(normalized);
        throw invalidCredentials();
      }

      await throttle.reset(normalized);
      const { tokens } = await sessionIssuer.issue(account.id);
      return { accountId: account.id, email: account.email, tokens };
    },

    async refresh({ refreshToken }): Promise<LoginResult> {
      const claims = await tokenService.verify(refreshToken, 'refresh');
      const session = await sessionStore.find(claims.sessionId);
      if (session === null || session.accountId !== claims.accountId) {
        throw sessionNotFound();
      }

      const account = await loadAccount(claims.accountId);
      const tokens = await sessionIssuer.renew({
        accountId: account.id,
        sessionId: claims.sessionId,
      });
      return { accountId: account.id, email: account.email, tokens };
    },

    async logout({ refreshToken }): Promise<void> {
      const claims = await tokenService.verify(refreshToken, 'refresh');
      await sessionIssuer.revoke(claims.sessionId);
    },

    async authenticateAccessToken(accessToken): Promise<AuthenticatedAccount> {
      // Throws `token_expired` (Requirement 1.8) or `token_invalid`.
      const claims = await tokenService.verify(accessToken, 'access');

      const session = await sessionStore.find(claims.sessionId);
      if (session === null || session.accountId !== claims.accountId) {
        throw sessionNotFound();
      }

      const account = await loadAccount(claims.accountId);
      return {
        accountId: account.id,
        email: account.email,
        emailVerified: account.emailVerifiedAt !== null,
        sessionId: claims.sessionId,
      };
    },
  };
}
