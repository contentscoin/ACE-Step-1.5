/**
 * Account_Service failure vocabulary.
 *
 * Each failure carries the HTTP status code and the machine-readable reason
 * code that Requirement 1 demands, so the transport layer (api/gateway) never
 * has to re-derive them from message text:
 *
 * - 1.2 duplicate e-mail        -> 409 `email_already_registered`
 * - 1.4 wrong password          -> 401 `invalid_credentials`
 * - 1.5 too many failures       -> 429 `login_temporarily_locked`
 * - 1.7 provider not configured -> 404 `social_login_not_configured`
 * - 1.8 expired access token    -> 401 `token_expired`
 */
export type AccountErrorCode =
  | 'email_already_registered'
  | 'invalid_credentials'
  | 'login_temporarily_locked'
  | 'password_too_long'
  | 'authorization_header_missing'
  | 'token_expired'
  | 'token_invalid'
  | 'session_not_found'
  | 'account_not_found'
  | 'social_login_not_configured'
  | 'social_login_state_mismatch'
  | 'social_login_exchange_failed';

export type AccountErrorDetails = Readonly<Record<string, unknown>>;

export class AccountError extends Error {
  readonly statusCode: number;
  readonly code: AccountErrorCode;
  readonly details: AccountErrorDetails;

  constructor(
    statusCode: number,
    code: AccountErrorCode,
    message: string,
    details: AccountErrorDetails = {},
  ) {
    super(message);
    this.name = 'AccountError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAccountError(value: unknown): value is AccountError {
  return value instanceof AccountError;
}

/** Requirement 1.2. */
export function emailAlreadyRegistered(email: string): AccountError {
  return new AccountError(409, 'email_already_registered', 'Email is already registered.', {
    email,
  });
}

/** Requirement 1.4. Deliberately identical for unknown e-mail and wrong password. */
export function invalidCredentials(): AccountError {
  return new AccountError(401, 'invalid_credentials', 'Email or password is incorrect.');
}

/** Requirement 1.5. */
export function loginTemporarilyLocked(retryAfterSeconds: number): AccountError {
  return new AccountError(
    429,
    'login_temporarily_locked',
    'Too many consecutive login failures; login is temporarily locked.',
    { retryAfterSeconds },
  );
}

/** bcrypt only consumes the first 72 bytes, so longer secrets are rejected outright. */
export function passwordTooLong(maxBytes: number): AccountError {
  return new AccountError(400, 'password_too_long', `Password must be at most ${maxBytes} bytes.`, {
    maxBytes,
  });
}

export function authorizationHeaderMissing(): AccountError {
  return new AccountError(
    401,
    'authorization_header_missing',
    'A Bearer access token is required.',
  );
}

/** Requirement 1.8. */
export function tokenExpired(): AccountError {
  return new AccountError(401, 'token_expired', 'The token has expired.');
}

export function tokenInvalid(reason: string): AccountError {
  return new AccountError(401, 'token_invalid', 'The token is not valid.', { reason });
}

export function sessionNotFound(): AccountError {
  return new AccountError(401, 'session_not_found', 'The session is no longer active.');
}

export function accountNotFound(): AccountError {
  return new AccountError(401, 'account_not_found', 'The account no longer exists.');
}

/** Requirement 1.7 — the `WHERE ... 설정된 경우` guard. */
export function socialLoginNotConfigured(provider: string): AccountError {
  return new AccountError(
    404,
    'social_login_not_configured',
    `Social login provider "${provider}" is not configured.`,
    { provider },
  );
}

export function socialLoginStateMismatch(): AccountError {
  return new AccountError(
    400,
    'social_login_state_mismatch',
    'The OAuth state parameter does not match the value issued for this authorization.',
  );
}

export function socialLoginExchangeFailed(provider: string, reason: string): AccountError {
  return new AccountError(
    502,
    'social_login_exchange_failed',
    `Authorization code exchange with "${provider}" failed.`,
    { provider, reason },
  );
}
