import { useEffect } from 'react';
import { platform } from '../../platform';
import { connectMemoryPressure } from './pressure-store';

let connections = 0;
let disconnect: (() => void) | null = null;

export function useMemoryPressureMonitoring(): void {
  useEffect(() => {
    connections += 1;
    if (connections === 1) {
      const runtime = platform().runtime;
      disconnect = connectMemoryPressure({
        sample: () => runtime.sampleMemoryPressure(),
        onChange: (listener) => runtime.onMemoryPressureChanged(listener),
      });
    }
    return () => {
      connections -= 1;
      if (connections === 0) {
        disconnect?.();
        disconnect = null;
      }
    };
  }, []);
}
