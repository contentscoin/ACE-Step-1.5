import { maskEmail } from '../email';
import type { EmailSender, VerificationEmail } from '../email-verification';

export type StructuredLog = (record: Readonly<Record<string, unknown>>) => void;

/**
 * Development e-mail sender: emits a structured record instead of delivering
 * mail. It exists so a local gateway can complete Requirement 1.1 without an
 * SMTP dependency; a production adapter implements the same `EmailSender` port.
 *
 * The recipient is masked per design §11.2 — the verification link is logged in
 * full only because the link *is* the development delivery channel.
 */
export function createLoggingEmailSender(
  log: StructuredLog = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
): EmailSender {
  return {
    async sendEmailVerification(message: VerificationEmail): Promise<void> {
      log({
        event: 'account.email_verification.sent',
        recipient: maskEmail(message.to),
        verification_link: message.verificationLink,
        expires_at: message.expiresAt.toISOString(),
      });
    },
  };
}
