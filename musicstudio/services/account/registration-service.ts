import { randomUUID } from 'node:crypto';

import type { AccountRepository } from './account-repository';
import { systemClock, type Clock } from './clock';
import { normalizeEmail } from './email';
import type { EmailSender, EmailVerificationTokens } from './email-verification';
import { emailAlreadyRegistered } from './errors';
import type { PasswordHasher } from './password-hasher';

export interface RegistrationResult {
  readonly accountId: string;
  readonly email: string;
  readonly emailVerificationSent: boolean;
}

export interface RegistrationService {
  /** Requirements 1.1, 1.2, 1.6. */
  register(input: { email: string; password: string }): Promise<RegistrationResult>;
  /** Completes the link from Requirement 1.1. Idempotent. */
  verifyEmail(input: { token: string }): Promise<{ accountId: string; email: string }>;
}

export interface RegistrationServiceOptions {
  readonly repository: AccountRepository;
  readonly passwordHasher: PasswordHasher;
  readonly emailVerification: EmailVerificationTokens;
  readonly emailSender: EmailSender;
  readonly clock?: Clock;
  readonly generateAccountId?: () => string;
}

export function createRegistrationService(
  options: RegistrationServiceOptions,
): RegistrationService {
  const clock = options.clock ?? systemClock;
  const generateAccountId = options.generateAccountId ?? randomUUID;
  const { repository, passwordHasher, emailVerification, emailSender } = options;

  return {
    async register({ email, password }): Promise<RegistrationResult> {
      const normalized = normalizeEmail(email);

      // Fast path for the common case. The authoritative duplicate check is the
      // repository's unique constraint, which also closes the concurrent-signup
      // race (Requirement 1.2).
      if ((await repository.findByEmail(normalized)) !== null) {
        throw emailAlreadyRegistered(normalized);
      }

      const created = await repository.create({
        id: generateAccountId(),
        email: normalized,
        passwordHash: await passwordHasher.hash(password),
        emailVerifiedAt: null,
        createdAt: clock.now(),
        socialIdentities: [],
      });

      const verification = await emailVerification.issue({
        accountId: created.id,
        email: created.email,
      });
      await emailSender.sendEmailVerification({
        to: created.email,
        verificationLink: verification.verificationLink,
        expiresAt: verification.expiresAt,
      });

      return { accountId: created.id, email: created.email, emailVerificationSent: true };
    },

    async verifyEmail({ token }): Promise<{ accountId: string; email: string }> {
      const claims = await emailVerification.consume(token);
      await repository.markEmailVerified(claims.accountId, clock.now());
      return claims;
    },
  };
}
