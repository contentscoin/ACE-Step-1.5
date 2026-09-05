import {
  DAILY_QUOTA_MAX,
  DAILY_QUOTA_MIN,
  isExecutionLocation,
  type DailyQuota,
  type ExecutionLocation,
} from '../../adapters/registry/engine-descriptor';
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
 *
 * The connection strings for the two stores are required for the same reason the
 * secret is: a gateway that silently fell back to an in-memory account table would
 * pass every request and lose every account at restart. The engine, the DSP sidecar
 * and the object store default to where `run_api_server.sh`, `python -m
 * musicstudio_dsp.sidecar` and a fresh checkout put them, because a developer's
 * first `npm start` should need only the two URLs and a secret.
 */
export interface SocialProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Where ACE-Step is, and what the registry records about it (Requirements 20.1, 33.1). */
export interface EngineConfig {
  /** Engine origin; `run_api_server.sh` listens on 8001. */
  readonly baseUrl: string;
  /** Sent as a bearer token when the engine was started with one; otherwise absent. */
  readonly apiToken: string | null;
  readonly executionLocation: ExecutionLocation;
  /**
   * The weight licence recorded on every asset this engine produces (Requirement 33.7).
   * Overridable because the weights and the code can be licensed differently, and the
   * registry's non-commercial list rules on the identifier, not on a hard-coded belief.
   */
  readonly weightLicenseId: string;
  readonly dailyQuota: DailyQuota;
}

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly jwtSecret: string;
  readonly passwordHashCost: number;
  readonly publicBaseUrl: string;
  readonly redisUrl: string;
  readonly databaseUrl: string;
  /** Origin of the DSP HTTP sidecar (slice S2); `python -m musicstudio_dsp.sidecar` listens on 8002. */
  readonly dspUrl: string;
  /** Root directory of the filesystem object store (slice S1). */
  readonly objectStoreDirectory: string;
  /** Apply pending migrations before listening. Off by default: a deploy decides when the schema moves. */
  readonly migrateOnStart: boolean;
  readonly engine: EngineConfig;
  readonly google: SocialProviderCredentials | null;
  readonly apple: SocialProviderCredentials | null;
}

export type Environment = Readonly<Partial<Record<string, string>>>;

export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8001';
export const DEFAULT_DSP_URL = 'http://127.0.0.1:8002';
export const DEFAULT_OBJECT_STORE_DIRECTORY = 'data/objects';
export const DEFAULT_ENGINE_DAILY_QUOTA: DailyQuota = { maxRequests: 10_000, maxGpuSeconds: 1_000_000 };

export function loadGatewayConfig(env: Environment = process.env): GatewayConfig {
  return {
    host: env.MUSICSTUDIO_HOST ?? '0.0.0.0',
    port: readPort(env.MUSICSTUDIO_PORT),
    jwtSecret: readJwtSecret(env.MUSICSTUDIO_JWT_SECRET),
    passwordHashCost: readHashCost(env.MUSICSTUDIO_PASSWORD_HASH_COST),
    publicBaseUrl: readRequired(env, 'MUSICSTUDIO_PUBLIC_BASE_URL'),
    redisUrl: readRequired(env, 'MUSICSTUDIO_REDIS_URL'),
    databaseUrl: readRequired(env, 'MUSICSTUDIO_DATABASE_URL'),
    dspUrl: readNonEmpty(env.MUSICSTUDIO_DSP_URL) ?? DEFAULT_DSP_URL,
    objectStoreDirectory:
      readNonEmpty(env.MUSICSTUDIO_OBJECT_STORE_DIR) ?? DEFAULT_OBJECT_STORE_DIRECTORY,
    migrateOnStart: readFlag(env, 'MUSICSTUDIO_MIGRATE_ON_START'),
    engine: {
      baseUrl: readNonEmpty(env.MUSICSTUDIO_ENGINE_URL) ?? DEFAULT_ENGINE_URL,
      apiToken: readNonEmpty(env.MUSICSTUDIO_ENGINE_API_TOKEN) ?? null,
      executionLocation: readExecutionLocation(env.MUSICSTUDIO_ENGINE_EXECUTION_LOCATION),
      weightLicenseId: readNonEmpty(env.MUSICSTUDIO_ENGINE_WEIGHT_LICENSE_ID) ?? 'MIT',
      dailyQuota: {
        maxRequests: readQuota(env, 'MUSICSTUDIO_ENGINE_DAILY_MAX_REQUESTS', DEFAULT_ENGINE_DAILY_QUOTA.maxRequests),
        maxGpuSeconds: readQuota(
          env,
          'MUSICSTUDIO_ENGINE_DAILY_MAX_GPU_SECONDS',
          DEFAULT_ENGINE_DAILY_QUOTA.maxGpuSeconds,
        ),
      },
    },
    google: readProviderCredentials(env, 'GOOGLE'),
    apple: readProviderCredentials(env, 'APPLE'),
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function readRequired(env: Environment, name: string): string {
  const value = readNonEmpty(env[name]);
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

/** `true`/`1`/`yes` on; anything else — including unset — off. */
function readFlag(env: Environment, name: string): boolean {
  const value = env[name];
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;
  throw new Error(`${name} must be true or false.`);
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

function readExecutionLocation(value: string | undefined): ExecutionLocation {
  if (value === undefined || value.length === 0) return 'local';
  if (!isExecutionLocation(value)) {
    throw new Error('MUSICSTUDIO_ENGINE_EXECUTION_LOCATION must be "local" or "remote".');
  }
  return value;
}

/** Requirement 20.12: both daily quotas are integers in 1..1000000. */
function readQuota(env: Environment, name: string, fallback: number): number {
  const value = readNonEmpty(env[name]);
  if (value === undefined) return fallback;
  const quota = Number.parseInt(value, 10);
  if (!Number.isInteger(quota) || quota < DAILY_QUOTA_MIN || quota > DAILY_QUOTA_MAX) {
    throw new Error(
      `${name} must be an integer between ${String(DAILY_QUOTA_MIN)} and ${String(DAILY_QUOTA_MAX)} (Requirement 20.12).`,
    );
  }
  return quota;
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
