import { create } from 'zustand';
import type { MemoryPressureSnapshot } from '../../shared/memory-pressure';
import type { MemoryPressureLevel } from './pressure-level';

export type MemoryPressureReading = MemoryPressureSnapshot;

export interface MemoryPressureTransport {
  sample: () => Promise<MemoryPressureReading>;
  onChange: (listener: (reading: MemoryPressureReading) => void) => () => void;
}

interface MemoryPressureState extends MemoryPressureReading {
  apply: (reading: MemoryPressureReading) => void;
}

const INITIAL: MemoryPressureReading = { level: 'unknown', source: 'unavailable', sampledAt: 0 };

export const useMemoryPressureStore = create<MemoryPressureState>()((set) => ({
  ...INITIAL,
  apply: (reading) =>
    set((state) =>
      state.level === reading.level &&
      state.source === reading.source &&
      state.sampledAt >= reading.sampledAt
        ? state
        : { level: reading.level, source: reading.source, sampledAt: reading.sampledAt }
    ),
}));

export function useMemoryPressureLevel(): MemoryPressureLevel {
  return useMemoryPressureStore((state) => state.level);
}

let transport: MemoryPressureTransport | null = null;
let unsubscribe: (() => void) | null = null;
let inFlight: Promise<void> | null = null;

export function connectMemoryPressure(next: MemoryPressureTransport): () => void {
  unsubscribe?.();
  transport = next;
  unsubscribe = next.onChange((reading) => useMemoryPressureStore.getState().apply(reading));
  void requestMemoryPressureSample();
  return () => {
    unsubscribe?.();
    unsubscribe = null;
    transport = null;
  };
}

export function requestMemoryPressureSample(): Promise<void> {
  const current = transport;
  if (!current) return Promise.resolve();
  inFlight ??= current
    .sample()
    .then((reading) => useMemoryPressureStore.getState().apply(reading))
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
