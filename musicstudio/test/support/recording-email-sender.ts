import type { EmailSender, VerificationEmail } from '../../services/account/email-verification';

/**
 * Captures verification mail instead of sending it, so a test can assert that
 * Requirement 1.1's link was produced and then follow it.
 */
export interface RecordingEmailSender extends EmailSender {
  readonly sent: readonly VerificationEmail[];
  lastLinkToken(): string | null;
}

export function createRecordingEmailSender(): RecordingEmailSender {
  const sent: VerificationEmail[] = [];

  return {
    sent,

    async sendEmailVerification(message) {
      sent.push(message);
    },

    lastLinkToken() {
      const last = sent.at(-1);
      if (last === undefined) {
        return null;
      }
      return new URL(last.verificationLink).searchParams.get('token');
    },
  };
}
