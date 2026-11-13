export type OsMemoryPressureLevel = 'normal' | 'moderate' | 'critical' | 'unknown';

export function levelFromDarwinPressureLevel(raw: string): OsMemoryPressureLevel {
  switch (raw.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'moderate';
    case '4':
      return 'critical';
    default:
      return 'unknown';
  }
}

export interface LinuxPressureStall {
  someAvg10: number;
  fullAvg10: number;
}

export function parseLinuxPressureStall(text: string): LinuxPressureStall | null {
  const avg10 = (kind: 'some' | 'full'): number | null => {
    const line = text.split('\n').find((candidate) => candidate.startsWith(`${kind} `));
    const match = line?.match(/\bavg10=(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : null;
  };
  const someAvg10 = avg10('some');
  const fullAvg10 = avg10('full');
  if (someAvg10 === null || fullAvg10 === null) return null;
  return { someAvg10, fullAvg10 };
}

export const LINUX_MODERATE_SOME_AVG10 = 10;
export const LINUX_CRITICAL_FULL_AVG10 = 10;

export function levelFromLinuxPressureStall(stall: LinuxPressureStall): OsMemoryPressureLevel {
  if (stall.fullAvg10 >= LINUX_CRITICAL_FULL_AVG10) return 'critical';
  if (stall.someAvg10 >= LINUX_MODERATE_SOME_AVG10) return 'moderate';
  return 'normal';
}

const MIB = 1024 * 1024;

export function windowsLowMemoryNotificationBytes(totalBytes: number): number {
  const perFourGiB = (totalBytes / (4 * 1024 * MIB)) * 32 * MIB;
  return Math.min(64 * MIB, perFourGiB);
}

export const WINDOWS_MODERATE_AVAILABLE_FRACTION = 0.1;

export function levelFromWindowsMemory(
  availableBytes: number,
  totalBytes: number
): OsMemoryPressureLevel {
  if (!(totalBytes > 0) || !(availableBytes >= 0)) return 'unknown';
  if (availableBytes <= windowsLowMemoryNotificationBytes(totalBytes)) return 'critical';
  if (availableBytes < totalBytes * WINDOWS_MODERATE_AVAILABLE_FRACTION) return 'moderate';
  return 'normal';
}
