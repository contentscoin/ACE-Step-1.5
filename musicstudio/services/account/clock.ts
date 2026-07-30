/**
 * Injectable time source.
 *
 * Every time-dependent rule in Requirement 1 (token lifetimes 1.3/1.8, the
 * 15-minute login lockout 1.5) reads the current instant through this port so
 * tests can advance time deterministically instead of sleeping.
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
