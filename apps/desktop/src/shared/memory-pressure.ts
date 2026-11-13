export type MemoryPressureLevel = 'normal' | 'moderate' | 'critical' | 'unknown';

export type MemoryPressureSource =
  | 'darwin-sysctl'
  | 'linux-psi'
  | 'windows-available-memory'
  | 'forced'
  | 'unavailable';

export interface MemoryPressureSnapshot {
  level: MemoryPressureLevel;
  source: MemoryPressureSource;
  sampledAt: number;
}
