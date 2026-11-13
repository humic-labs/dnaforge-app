import { useRef, type MutableRefObject } from 'react';
import { diag } from '../diagnostics';

export function createTrackedRef<T>(
  name: string,
  initial: T,
  summarize?: (v: T) => unknown
): MutableRefObject<T> {
  const storage = { value: initial };
  const obj = {} as MutableRefObject<T>;
  Object.defineProperty(obj, 'current', {
    get(): T {
      return storage.value;
    },
    set(next: T): void {
      const prev = storage.value;
      storage.value = next;
      if (prev !== next) {
        diag.capture({
          type: 'ref-update',
          name,
          prev: summarize ? summarize(prev) : prev,
          next: summarize ? summarize(next) : next,
        });
      }
    },
    configurable: false,
    enumerable: true,
  });
  return obj;
}

export function useTrackedRef<T>(
  name: string,
  initial: T,
  summarize?: (v: T) => unknown
): MutableRefObject<T> {
  const wrapped = useRef<MutableRefObject<T> | null>(null);
  if (wrapped.current === null) {
    wrapped.current = createTrackedRef(name, initial, summarize);
  }
  return wrapped.current;
}

export const summarize = {
  viewport: (v: { scrollTop: number; height: number } | null): unknown => {
    if (!v) return null;
    return { scrollTop: v.scrollTop, height: v.height };
  },

  layout: (
    v: {
      lines?: Array<{ y: number }>;
      totalHeight?: number;
      sequenceLength?: number;
      isCircular?: boolean;
    } | null
  ): unknown => {
    if (!v) return null;
    const lines = v.lines ?? [];
    return {
      lineCount: lines.length,
      firstY: lines[0]?.y,
      lastY: lines[lines.length - 1]?.y,
      totalHeight: v.totalHeight,
      sequenceLength: v.sequenceLength,
      isCircular: v.isCircular,
    };
  },

  identity: <T>(v: T): T => v,
};
