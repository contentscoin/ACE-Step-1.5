import { MINIMUM_JWT_SECRET_LENGTH } from '../../services/account/jwt';
import { MINIMUM_PASSWORD_HASH_COST } from '../../services/account/password-hasher';

/**
 * Gateway configuration, read from the environment.
 *
 * Secrets are never defaulted: a missing signing key or an under-strength
 * bcrypt cost fails at boot rather than degrading Requirement 1.6 silently. The
 * OAuth section is optional by design — Requirement 1.7 applies only
 * `WHERE 소셜 로그인 제공자가 설정된 경우`, so an absent client id simply means the
 * provider is not offered.
 */
export interface SocialProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly jwtSecret: string;
  readonly passwordHashCost: number;
  readonly publicBaseUrl: string;
  readonly redisUrl: string;
  readonly google: SocialProviderCredentials | null;
  readonly apple: SocialProviderCredentials | null;
}

export type Environment = Readonly<Partial<Record<string, string>>>;

export function loadGatewayConfig(env: Environment = process.env): GatewayConfig {
  return {
    host: env.MUSICSTUDIO_HOST ?? '0.0.0.0',
    port: readPort(env.MUSICSTUDIO_PORT),
    jwtSecret: readJwtSecret(env.MUSICSTUDIO_JWT_SECRET),
    passwordHashCost: readHashCost(env.MUSICSTUDIO_PASSWORD_HASH_COST),
    publicBaseUrl: readRequired(env, 'MUSICSTUDIO_PUBLIC_BASE_URL'),
    redisUrl: readRequired(env, 'MUSICSTUDIO_REDIS_URL'),
    google: readProviderCredentials(env, 'GOOGLE'),
    apple: readProviderCredentials(env, 'APPLE'),
  };
}

function readRequired(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function readJwtSecret(value: string | undefined): string {
  if (value === undefined || value.length < MINIMUM_JWT_SECRET_LENGTH) {
    throw new Error(
      `Environment variable MUSICSTUDIO_JWT_SECRET is required and must be at least ${MINIMUM_JWT_SECRET_LENGTH} characters.`,
    );
  }
  return value;
}

function readHashCost(value: string | undefined): number {
  if (value === undefined) {
    return MINIMUM_PASSWORD_HASH_COST;
  }
  const cost = Number.parseInt(value, 10);
  if (!Number.isInteger(cost) || cost < MINIMUM_PASSWORD_HASH_COST) {
    throw new Error(
      `MUSICSTUDIO_PASSWORD_HASH_COST must be an integer >= ${MINIMUM_PASSWORD_HASH_COST} (Requirement 1.6).`,
    );
  }
  return cost;
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 8080;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MUSICSTUDIO_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function readProviderCredentials(
  env: Environment,
  provider: 'GOOGLE' | 'APPLE',
): SocialProviderCredentials | null {
  const clientId = env[`MUSICSTUDIO_OAUTH_${provider}_CLIENT_ID`];
  const clientSecret = env[`MUSICSTUDIO_OAUTH_${provider}_CLIENT_SECRET`];

  if (clientId === undefined || clientId.length === 0) {
    return null;
  }
  if (clientSecret === undefined || clientSecret.length === 0) {
    throw new Error(
      `MUSICSTUDIO_OAUTH_${provider}_CLIENT_SECRET is required when MUSICSTUDIO_OAUTH_${provider}_CLIENT_ID is set.`,
    );
  }
  return { clientId, clientSecret };
}
