/**
 * Account_Service public surface (requirements §1, design §2.2).
 *
 * The API gateway imports from here only; the individual modules stay internal
 * so their composition can change without touching the transport layer.
 */
export type {
  AccountRecord,
  AccountRepository,
  NewAccount,
  SocialIdentity,
} from './account-repository';
export { createAccountService } from './account-service';
export type { AccountService, AccountServiceDependencies } from './account-service';
export { addSeconds, systemClock, toUnixSeconds } from './clock';
export type { Clock } from './clock';
export { maskEmail, normalizeEmail } from './email';
export {
  createEmailVerificationTokens,
  EMAIL_VERIFICATION_TTL_SECONDS,
} from './email-verification';
export type {
  EmailSender,
  EmailVerificationTokens,
  VerificationEmail,
} from './email-verification';
export { AccountError, isAccountError } from './errors';
export type { AccountErrorCode } from './errors';
export type { AuthenticatedAccount, LoginResult, LoginService } from './login-service';
export {
  createLoginThrottle,
  LOGIN_LOCK_DURATION_SECONDS,
  MAX_CONSECUTIVE_LOGIN_FAILURES,
} from './login-throttle';
export type { LoginAttemptState, LoginAttemptStore, LoginThrottle } from './login-throttle';
export {
  createOAuthProviderRegistry,
  isSupportedSocialProvider,
  SUPPORTED_SOCIAL_PROVIDERS,
} from './oauth-provider';
export type {
  OAuthIdentity,
  OAuthProvider,
  OAuthProviderRegistry,
  SocialProviderId,
} from './oauth-provider';
export {
  createBcryptPasswordHasher,
  MAX_PASSWORD_BYTES,
  MINIMUM_PASSWORD_HASH_COST,
  parsePasswordHashCost,
} from './password-hasher';
export type { PasswordHasher } from './password-hasher';
export type { RegistrationResult, RegistrationService } from './registration-service';
export type { SessionRecord, SessionStore } from './session-store';
export type { SocialLoginResult, SocialLoginService } from './social-login-service';
export {
  ACCESS_TOKEN_TTL_SECONDS,
  createJwtTokenService,
  REFRESH_TOKEN_TTL_SECONDS,
} from './token-service';
export type { TokenClaims, TokenPair, TokenService } from './token-service';
