import { describe, expect, it } from 'vitest';
import {
  levelFromDarwinPressureLevel,
  levelFromLinuxPressureStall,
  levelFromWindowsMemory,
  parseLinuxPressureStall,
  windowsLowMemoryNotificationBytes,
} from './probes';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('macOS kern.memorystatus_vm_pressure_level', () => {
  it('maps the kernel levels 1, 2 and 4', () => {
    expect(levelFromDarwinPressureLevel('1\n')).toBe('normal');
    expect(levelFromDarwinPressureLevel('2\n')).toBe('moderate');
    expect(levelFromDarwinPressureLevel('4\n')).toBe('critical');
  });

  it('reports anything else as unknown', () => {
    expect(levelFromDarwinPressureLevel('')).toBe('unknown');
    expect(levelFromDarwinPressureLevel('3')).toBe('unknown');
  });
});

describe('Linux /proc/pressure/memory', () => {
  const psi = (some: number, full: number) =>
    `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=123\n` +
    `full avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=45\n`;

  it('parses the avg10 of both lines', () => {
    expect(parseLinuxPressureStall(psi(12.5, 0.75))).toEqual({ someAvg10: 12.5, fullAvg10: 0.75 });
  });

  it('rejects text that is not PSI', () => {
    expect(parseLinuxPressureStall('')).toBeNull();
    expect(parseLinuxPressureStall('some avg10=1.00 avg60=0.00 avg300=0.00 total=1\n')).toBeNull();
  });

  it('is moderate when some task stalls 10% of the time, critical when all do', () => {
    expect(levelFromLinuxPressureStall({ someAvg10: 2, fullAvg10: 0 })).toBe('normal');
    expect(levelFromLinuxPressureStall({ someAvg10: 10, fullAvg10: 1 })).toBe('moderate');
    expect(levelFromLinuxPressureStall({ someAvg10: 60, fullAvg10: 10 })).toBe('critical');
  });
});

describe('Windows available physical memory', () => {
  it('uses the low-memory notification threshold: 32 MB per 4 GB, at most 64 MB', () => {
    expect(windowsLowMemoryNotificationBytes(4 * GIB)).toBe(32 * MIB);
    expect(windowsLowMemoryNotificationBytes(16 * GIB)).toBe(64 * MIB);
  });

  it('is critical at the notification threshold and moderate under 10% available', () => {
    expect(levelFromWindowsMemory(4 * GIB, 16 * GIB)).toBe('normal');
    expect(levelFromWindowsMemory(1 * GIB, 16 * GIB)).toBe('moderate');
    expect(levelFromWindowsMemory(64 * MIB, 16 * GIB)).toBe('critical');
  });

  it('reports nonsense totals as unknown', () => {
    expect(levelFromWindowsMemory(1, 0)).toBe('unknown');
  });
});
