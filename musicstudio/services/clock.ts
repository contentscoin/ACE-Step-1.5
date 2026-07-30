/**
 * Injectable time source, shared by every service in the product layer.
 *
 * Time-dependent rules read the current instant through this port so tests can
 * advance time deterministically instead of sleeping:
 *
 * - Requirement 1.3/1.8 token lifetimes and 1.5 login lockout (Account_Service)
 * - Requirement 20.7 health-check interval and 20.12 daily quota reset at
 *   00:00 UTC (Provider_Registry)
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Seconds since the Unix epoch, the unit JWT `iat`/`exp` claims use. */
export function toUnixSeconds(instant: Date): number {
  return Math.floor(instant.getTime() / 1000);
}

/** `instant` shifted forward by `seconds`. */
export function addSeconds(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() + seconds * 1000);
}
