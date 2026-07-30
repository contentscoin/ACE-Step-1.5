/**
 * Engine_Descriptor schema (design §3.2, Requirement 20.1).
 *
 * Field domains are declared as named constants rather than inline numerals so
 * the validator (`descriptor-validation.ts`), the HTTP JSON schema
 * (`api/gateway/schemas/engine-schemas.ts`) and the tests all read the same
 * bounds from one place.
 */

import { ASSET_KINDS, type AssetKind } from '../../domain/asset-kind';
import { INPUT_MODALITIES, type InputModality } from '../normalized-generation';

import type { LicenseDescriptor } from './license-descriptor';

export const ENGINE_ID_MIN_LENGTH = 1;
export const ENGINE_ID_MAX_LENGTH = 64;

export const SUPPORTED_ASSET_KINDS_MIN = 1;
export const SUPPORTED_ASSET_KINDS_MAX = ASSET_KINDS.length; // 6
export const SUPPORTED_INPUT_MODALITIES_MIN = 1;
export const SUPPORTED_INPUT_MODALITIES_MAX = INPUT_MODALITIES.length; // 3

export const MAX_OUTPUT_DURATION_MS_MIN = 1_000;
export const MAX_OUTPUT_DURATION_MS_MAX = 3_600_000;

export const SAMPLE_RATE_MIN = 16_000;
export const SAMPLE_RATE_MAX = 48_000;

/** Requirement 20.12: both daily quotas are integers in 1..1000000. */
export const DAILY_QUOTA_MIN = 1;
export const DAILY_QUOTA_MAX = 1_000_000;

export const EXECUTION_LOCATIONS = ['local', 'remote'] as const;

export type ExecutionLocation = (typeof EXECUTION_LOCATIONS)[number];

export function isExecutionLocation(value: unknown): value is ExecutionLocation {
  return typeof value === 'string' && (EXECUTION_LOCATIONS as readonly string[]).includes(value);
}

export interface DailyQuota {
  readonly maxRequests: number;
  readonly maxGpuSeconds: number;
}

export interface EngineDescriptor {
  readonly engineId: string;
  readonly supportedAssetKinds: readonly AssetKind[];
  readonly supportedInputModalities: readonly InputModality[];
  readonly maxOutputDurationMs: number;
  readonly sampleRate: number;
  readonly executionLocation: ExecutionLocation;
  /** Exactly one descriptor (Requirement 20.1). */
  readonly license: LicenseDescriptor;
  /** Third-party components, folded into the ruling (Requirement 33.4). */
  readonly licenseComponents?: readonly LicenseDescriptor[];
  readonly dailyQuota: DailyQuota;
  /** GPU seconds one request is expected to consume; defaults to 1. */
  readonly gpuSecondsPerRequest?: number;
}

export function supportsAssetKind(descriptor: EngineDescriptor, kind: AssetKind): boolean {
  return descriptor.supportedAssetKinds.includes(kind);
}

export function supportsInputModality(
  descriptor: EngineDescriptor,
  modality: InputModality,
): boolean {
  return descriptor.supportedInputModalities.includes(modality);
}

export function gpuSecondsPerRequest(descriptor: EngineDescriptor): number {
  return descriptor.gpuSecondsPerRequest ?? 1;
}
