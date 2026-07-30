import { addSeconds, systemClock, type Clock } from './clock';
import { tokenInvalid } from './errors';
import { createJwtSigner, type JwtSigner } from './jwt';

/** Verification links stay usable for 48 hours. */
export const EMAIL_VERIFICATION_TTL_SECONDS = 48 * 60 * 60;

export const EMAIL_VERIFICATION_ISSUER = 'musicstudio:email-verification';

export interface VerificationEmail {
  readonly to: string;
  readonly verificationLink: string;
  readonly expiresAt: Date;
}

/**
 * Outbound mail port (Requirement 1.1: "이메일 인증 링크를 발송한다").
 * A real SMTP/provider adapter and the development logging adapter both
 * implement this; tests record the message instead of sending it.
 */
export interface EmailSender {
  sendEmailVerification(message: VerificationEmail): Promise<void>;
}

export interface IssuedVerification {
  readonly token: string;
  readonly verificationLink: string;
  readonly expiresAt: Date;
}

export interface EmailVerificationTokens {
  issue(input: { accountId: string; email: string }): Promise<IssuedVerification>;
  consume(token: string): Promise<{ accountId: string; email: string }>;
}

export interface EmailVerificationOptions {
  readonly secret: string;
  /** Absolute base URL of the web app, e.g. `https://studio.example.com`. */
  readonly publicBaseUrl: string;
  readonly clock?: Clock;
  readonly ttlSeconds?: number;
  readonly signer?: JwtSigner;
}

/**
 * Stateless verification tokens.
 *
 * The token is self-describing and signed, so no extra table or cache entry is
 * needed to validate a link. Single-use semantics come from the account's
 * `email_verified_at` column: a second use is a no-op, not a second state
 * change.
 */
export function createEmailVerificationTokens(
  options: EmailVerificationOptions,
): EmailVerificationTokens {
  const clock = options.clock ?? systemClock;
  const ttlSeconds = options.ttlSeconds ?? EMAIL_VERIFICATION_TTL_SECONDS;
  const signer = options.signer ?? createJwtSigner(options.secret);

  return {
    async issue({ accountId, email }): Promise<IssuedVerification> {
      const issuedAt = clock.now();
      const expiresAt = addSeconds(issuedAt, ttlSeconds);
      const token = await signer.sign({
        subject: accountId,
        issuer: EMAIL_VERIFICATION_ISSUER,
        issuedAt,
        expiresAt,
        claims: { email },
      });

      const link = new URL('/verify-email', options.publicBaseUrl);
      link.searchParams.set('token', token);

      return { token, verificationLink: link.toString(), expiresAt };
    },

    async consume(token): Promise<{ accountId: string; email: string }> {
      const verified = await signer.verify(token, {
        issuer: EMAIL_VERIFICATION_ISSUER,
        currentDate: clock.now(),
      });

      const email = verified.payload.email;
      if (typeof email !== 'string' || email.length === 0) {
        throw tokenInvalid('missing email claim');
      }

      return { accountId: verified.subject, email };
    },
  };
}
