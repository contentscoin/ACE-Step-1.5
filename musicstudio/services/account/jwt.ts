import { SignJWT, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

import { toUnixSeconds } from '../clock';
import { tokenExpired, tokenInvalid } from './errors';

/**
 * Thin HS256 sign/verify wrapper shared by every signed artefact the account
 * layer issues (access tokens, refresh tokens, e-mail verification tokens).
 *
 * Two behaviours matter to Requirement 1 and are therefore pinned here rather
 * than at each call site:
 *
 * - expiry is evaluated against an injected instant, never `Date.now()`, so the
 *   "expired token" path of 1.8 is testable without waiting 24 hours;
 * - an expired token maps to the distinct `token_expired` reason code required
 *   by 1.8, while every other verification failure collapses to
 *   `token_invalid`.
 */
export const MINIMUM_JWT_SECRET_LENGTH = 32;

export interface SignedTokenRequest {
  readonly subject: string;
  readonly issuer: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly claims: JWTPayload;
}

export interface VerifiedToken {
  readonly payload: JWTPayload;
  readonly subject: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface JwtSigner {
  sign(request: SignedTokenRequest): Promise<string>;
  verify(token: string, options: { issuer: string; currentDate: Date }): Promise<VerifiedToken>;
}

export function createJwtSigner(secret: string): JwtSigner {
  if (secret.length < MINIMUM_JWT_SECRET_LENGTH) {
    throw new RangeError(
      `JWT secret must be at least ${MINIMUM_JWT_SECRET_LENGTH} characters; received ${secret.length}.`,
    );
  }
  const key = new TextEncoder().encode(secret);

  return {
    async sign(request: SignedTokenRequest): Promise<string> {
      return new SignJWT(request.claims)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(request.subject)
        .setIssuer(request.issuer)
        .setIssuedAt(toUnixSeconds(request.issuedAt))
        .setExpirationTime(toUnixSeconds(request.expiresAt))
        .sign(key);
    },

    async verify(token, options): Promise<VerifiedToken> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          currentDate: options.currentDate,
        }));
      } catch (cause) {
        throw translateVerificationFailure(cause);
      }

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw tokenInvalid('missing subject claim');
      }
      if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
        throw tokenInvalid('missing iat or exp claim');
      }

      return {
        payload,
        subject: payload.sub,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
      };
    },
  };
}

function translateVerificationFailure(cause: unknown): Error {
  if (cause instanceof joseErrors.JWTExpired) {
    return tokenExpired();
  }
  if (cause instanceof joseErrors.JOSEError) {
    return tokenInvalid(cause.code);
  }
  return tokenInvalid('verification failed');
}
