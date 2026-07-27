export interface MonitoringClock {
  now(): Date;
}

export const systemClock: MonitoringClock = {
  now: () => new Date()
};

export function fixedClock(isoTimestamp: string | Date): MonitoringClock {
  const fixed = isoTimestamp instanceof Date ? new Date(isoTimestamp) : new Date(isoTimestamp);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(`Invalid fixed clock timestamp: ${String(isoTimestamp)}`);
  }
  return { now: () => new Date(fixed) };
}
