import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { MemoryPressureSnapshot, MemoryPressureSource } from '../../shared/memory-pressure';
import {
  levelFromDarwinPressureLevel,
  levelFromLinuxPressureStall,
  levelFromWindowsMemory,
  parseLinuxPressureStall,
  type OsMemoryPressureLevel,
} from './probes';

export type MemoryPressureSample = MemoryPressureSnapshot;
export type { MemoryPressureSource };

export const MEMORY_PRESSURE_SAMPLE_INTERVAL_MS = 5_000;

export interface MemoryPressureReaders {
  platform: NodeJS.Platform;
  darwinPressureLevel: () => Promise<string>;
  linuxPressureStall: () => Promise<string>;
  windowsMemory: () => { availableBytes: number; totalBytes: number };
  now: () => number;
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export const systemMemoryPressureReaders: MemoryPressureReaders = {
  platform: process.platform,
  darwinPressureLevel: () =>
    execText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
  linuxPressureStall: () => readFile('/proc/pressure/memory', 'utf8'),
  windowsMemory: () => ({ availableBytes: os.freemem(), totalBytes: os.totalmem() }),
  now: () => Date.now(),
};

export class MemoryPressureMonitor {
  private current: MemoryPressureSample;
  private forced: OsMemoryPressureLevel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<MemoryPressureSample> | null = null;
  private readonly listeners = new Set<(sample: MemoryPressureSample) => void>();

  constructor(private readonly readers: MemoryPressureReaders = systemMemoryPressureReaders) {
    this.current = { level: 'unknown', source: 'unavailable', sampledAt: 0 };
  }

  latest(): MemoryPressureSample {
    return this.current;
  }

  sample(): Promise<MemoryPressureSample> {
    this.inFlight ??= this.read()
      .then((sample) => {
        this.publish(sample);
        return sample;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  start(intervalMs = MEMORY_PRESSURE_SAMPLE_INTERVAL_MS): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChange(listener: (sample: MemoryPressureSample) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  force(level: OsMemoryPressureLevel | null): Promise<MemoryPressureSample> {
    this.forced = level;
    return this.sample();
  }

  private async read(): Promise<MemoryPressureSample> {
    const sampledAt = this.readers.now();
    if (this.forced) return { level: this.forced, source: 'forced', sampledAt };
    try {
      switch (this.readers.platform) {
        case 'darwin':
          return {
            level: levelFromDarwinPressureLevel(await this.readers.darwinPressureLevel()),
            source: 'darwin-sysctl',
            sampledAt,
          };
        case 'linux': {
          const stall = parseLinuxPressureStall(await this.readers.linuxPressureStall());
          return stall
            ? { level: levelFromLinuxPressureStall(stall), source: 'linux-psi', sampledAt }
            : { level: 'unknown', source: 'unavailable', sampledAt };
        }
        case 'win32': {
          const { availableBytes, totalBytes } = this.readers.windowsMemory();
          return {
            level: levelFromWindowsMemory(availableBytes, totalBytes),
            source: 'windows-available-memory',
            sampledAt,
          };
        }
        default:
          return { level: 'unknown', source: 'unavailable', sampledAt };
      }
    } catch {
      return { level: 'unknown', source: 'unavailable', sampledAt };
    }
  }

  private publish(sample: MemoryPressureSample): void {
    const changed = sample.level !== this.current.level || sample.source !== this.current.source;
    this.current = sample;
    if (!changed) return;
    for (const listener of this.listeners) listener(sample);
  }
}
