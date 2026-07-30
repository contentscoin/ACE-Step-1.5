import type { AccountRepository } from './account-repository';
import { systemClock, type Clock } from '../clock';
import {
  createEmailVerificationTokens,
  type EmailSender,
  type EmailVerificationTokens,
} from './email-verification';
import { createLoginService, type LoginService } from './login-service';
import {
  createLoginThrottle,
  type LoginAttemptStore,
  type LoginThrottle,
} from './login-throttle';
import type { OAuthProvider, OAuthProviderRegistry } from './oauth-provider';
import { createOAuthProviderRegistry } from './oauth-provider';
import { createBcryptPasswordHasher, type PasswordHasher } from './password-hasher';
import { createRegistrationService, type RegistrationService } from './registration-service';
import { createSessionIssuer } from './session-issuer';
import type { SessionStore } from './session-store';
import { createSocialLoginService, type SocialLoginService } from './social-login-service';
import { createJwtTokenService, type TokenService } from './token-service';

/**
 * Account_Service (requirements §1, design §2.2).
 *
 * A facade over four collaborators — registration, login, social login and the
 * session issuer — so the API gateway depends on one object and the individual
 * use cases stay independently testable.
 */
export interface AccountService extends RegistrationService, LoginService, SocialLoginService {
  isSocialProviderConfigured(providerId: string): boolean;
  configuredSocialProviderIds(): readonly string[];
}

export interface AccountServiceDependencies {
  readonly repository: AccountRepository;
  readonly sessionStore: SessionStore;
  readonly loginAttemptStore: LoginAttemptStore;
  readonly emailSender: EmailSender;
  /** HS256 signing key for access, refresh and verification tokens. */
  readonly jwtSecret: string;
  /** Absolute base URL used to build verification links. */
  readonly publicBaseUrl: string;
  readonly oauthProviders?: readonly OAuthProvider[];
  readonly clock?: Clock;
  /** bcrypt work factor; must be >= 12 (Requirement 1.6). */
  readonly passwordHashCost?: number;

  // Seams used by tests; production wiring leaves these at their defaults.
  readonly passwordHasher?: PasswordHasher;
  readonly tokenService?: TokenService;
  readonly emailVerification?: EmailVerificationTokens;
  readonly throttle?: LoginThrottle;
  readonly oauthRegistry?: OAuthProviderRegistry;
  readonly generateAccountId?: () => string;
  readonly generateSessionId?: () => string;
  readonly generateState?: () => string;
}

export function createAccountService(deps: AccountServiceDependencies): AccountService {
  const clock = deps.clock ?? systemClock;

  const passwordHasher =
    deps.passwordHasher ?? createBcryptPasswordHasher(deps.passwordHashCost);
  const tokenService =
    deps.tokenService ?? createJwtTokenService({ secret: deps.jwtSecret, clock });
  const emailVerification =
    deps.emailVerification ??
    createEmailVerificationTokens({
      secret: deps.jwtSecret,
      publicBaseUrl: deps.publicBaseUrl,
      clock,
    });
  const throttle =
    deps.throttle ?? createLoginThrottle({ store: deps.loginAttemptStore, clock });
  const oauthRegistry =
    deps.oauthRegistry ?? createOAuthProviderRegistry(deps.oauthProviders ?? []);

  const sessionIssuer = createSessionIssuer({
    sessionStore: deps.sessionStore,
    tokenService,
    clock,
    ...(deps.generateSessionId === undefined
      ? {}
      : { generateSessionId: deps.generateSessionId }),
  });

  const registration = createRegistrationService({
    repository: deps.repository,
    passwordHasher,
    emailVerification,
    emailSender: deps.emailSender,
    clock,
    ...(deps.generateAccountId === undefined
      ? {}
      : { generateAccountId: deps.generateAccountId }),
  });

  const login = createLoginService({
    repository: deps.repository,
    passwordHasher,
    throttle,
    sessionIssuer,
    sessionStore: deps.sessionStore,
    tokenService,
  });

  const socialLogin = createSocialLoginService({
    registry: oauthRegistry,
    repository: deps.repository,
    sessionIssuer,
    clock,
    ...(deps.generateAccountId === undefined
      ? {}
      : { generateAccountId: deps.generateAccountId }),
    ...(deps.generateState === undefined ? {} : { generateState: deps.generateState }),
  });

  return {
    register: registration.register,
    verifyEmail: registration.verifyEmail,
    login: login.login,
    refresh: login.refresh,
    logout: login.logout,
    authenticateAccessToken: login.authenticateAccessToken,
    beginAuthorization: socialLogin.beginAuthorization,
    completeAuthorization: socialLogin.completeAuthorization,
    isSocialProviderConfigured: (providerId) => oauthRegistry.isConfigured(providerId),
    configuredSocialProviderIds: () => oauthRegistry.configuredProviderIds(),
  };
}
