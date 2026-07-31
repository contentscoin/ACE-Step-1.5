/**
 * Engine_Descriptor validation (Requirements 20.1, 20.23, 33.6).
 *
 * 20.23 asks for the *list* of missing or out-of-range field names, so this
 * validator never short-circuits: it collects every violation and returns them
 * in a stable declaration order, which makes the rejection body deterministic.
 */

import { isAssetKind } from '../../domain/asset-kind';
import { isInputModality } from '../normalized-generation';

import {
  DAILY_QUOTA_MAX,
  DAILY_QUOTA_MIN,
  ENGINE_ID_MAX_LENGTH,
  ENGINE_ID_MIN_LENGTH,
  MAX_OUTPUT_DURATION_MS_MAX,
  MAX_OUTPUT_DURATION_MS_MIN,
  SAMPLE_RATE_MAX,
  SAMPLE_RATE_MIN,
  SUPPORTED_ASSET_KINDS_MAX,
  SUPPORTED_ASSET_KINDS_MIN,
  SUPPORTED_INPUT_MODALITIES_MAX,
  SUPPORTED_INPUT_MODALITIES_MIN,
  isExecutionLocation,
  type EngineDescriptor,
} from './engine-descriptor';
import { LICENSE_COMPONENTS_MAX, validateLicenseDescriptor } from './license-descriptor';

export function validateEngineDescriptor(descriptor: unknown): string[] {
  if (descriptor === null || typeof descriptor !== 'object') {
    return ['descriptor'];
  }
  const candidate = descriptor as Partial<EngineDescriptor>;
  const violations: string[] = [];

  if (!isValidEngineId(candidate.engineId)) violations.push('engineId');
  if (!isValidEnumList(candidate.supportedAssetKinds, isAssetKind, SUPPORTED_ASSET_KINDS_MIN, SUPPORTED_ASSET_KINDS_MAX)) {
    violations.push('supportedAssetKinds');
  }
  if (
    !isValidEnumList(
      candidate.supportedInputModalities,
      isInputModality,
      SUPPORTED_INPUT_MODALITIES_MIN,
      SUPPORTED_INPUT_MODALITIES_MAX,
    )
  ) {
    violations.push('supportedInputModalities');
  }
  if (!isIntegerInRange(candidate.maxOutputDurationMs, MAX_OUTPUT_DURATION_MS_MIN, MAX_OUTPUT_DURATION_MS_MAX)) {
    violations.push('maxOutputDurationMs');
  }
  if (!isIntegerInRange(candidate.sampleRate, SAMPLE_RATE_MIN, SAMPLE_RATE_MAX)) {
    violations.push('sampleRate');
  }
  if (!isExecutionLocation(candidate.executionLocation)) violations.push('executionLocation');

  violations.push(...validateLicenseDescriptor(candidate.license));
  violations.push(...validateLicenseComponents(candidate.licenseComponents));
  violations.push(...validateDailyQuota(candidate.dailyQuota));

  const gpuPerRequest = candidate.gpuSecondsPerRequest;
  if (gpuPerRequest !== undefined && !isIntegerInRange(gpuPerRequest, DAILY_QUOTA_MIN, DAILY_QUOTA_MAX)) {
    violations.push('gpuSecondsPerRequest');
  }

  return violations;
}

/** True when the value satisfies every Requirement 20.1 field domain. */
export function isValidEngineDescriptor(descriptor: unknown): descriptor is EngineDescriptor {
  return validateEngineDescriptor(descriptor).length === 0;
}

function validateDailyQuota(quota: unknown): string[] {
  if (quota === null || typeof quota !== 'object') return ['dailyQuota'];
  const candidate = quota as Partial<EngineDescriptor['dailyQuota']>;
  const violations: string[] = [];

  if (!isIntegerInRange(candidate.maxRequests, DAILY_QUOTA_MIN, DAILY_QUOTA_MAX)) {
    violations.push('dailyQuota.maxRequests');
  }
  if (!isIntegerInRange(candidate.maxGpuSeconds, DAILY_QUOTA_MIN, DAILY_QUOTA_MAX)) {
    violations.push('dailyQuota.maxGpuSeconds');
  }

  return violations;
}

function validateLicenseComponents(components: unknown): string[] {
  if (components === undefined) return [];
  if (!Array.isArray(components) || components.length > LICENSE_COMPONENTS_MAX) {
    return ['licenseComponents'];
  }
  return components.flatMap((component, index) =>
    validateLicenseDescriptor(component, `licenseComponents[${index}]`),
  );
}

function isValidEngineId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length >= ENGINE_ID_MIN_LENGTH &&
    value.length <= ENGINE_ID_MAX_LENGTH
  );
}

function isValidEnumList<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
  min: number,
  max: number,
): boolean {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  if (!value.every(guard)) return false;
  return new Set(value).size === value.length;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
