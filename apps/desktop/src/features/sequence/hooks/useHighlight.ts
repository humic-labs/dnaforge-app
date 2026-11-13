import { useState, useCallback, useEffect } from 'react';
import type { HighlightRegion } from '../types';

const highlightListeners = new Map<string, Map<string, (region: HighlightRegion) => void>>();
let subscriptionIdCounter = 0;

export function requestHighlight(sequenceId: string, region: HighlightRegion): void {
  const listeners = highlightListeners.get(sequenceId);
  listeners?.forEach((listener) => listener(region));
}

export function onHighlightRequest(
  sequenceId: string,
  callback: (region: HighlightRegion) => void
): () => void {
  let listeners = highlightListeners.get(sequenceId);
  if (!listeners) {
    listeners = new Map();
    highlightListeners.set(sequenceId, listeners);
  }

  const subscriptionId = `sub_${++subscriptionIdCounter}`;
  listeners.set(subscriptionId, callback);

  return () => {
    const currentListeners = highlightListeners.get(sequenceId);
    currentListeners?.delete(subscriptionId);
    if (currentListeners?.size === 0) {
      highlightListeners.delete(sequenceId);
    }
  };
}

export function clearAllHighlightListeners(): void {
  highlightListeners.clear();
}

interface UseHighlightResult {
  highlights: HighlightRegion[];
  addHighlight: (region: HighlightRegion) => void;
  removeHighlight: (id: string) => void;
  clearHighlights: () => void;
  clearHighlightsBySource: (source: 'ai' | 'search' | 'user') => void;
}

export function useHighlight(sequenceId: string): UseHighlightResult {
  const [highlights, setHighlights] = useState<HighlightRegion[]>([]);

  const addHighlight = useCallback((region: HighlightRegion) => {
    setHighlights((prev) => {
      const filtered = prev.filter((h) => h.id !== region.id);
      return [...filtered, region];
    });
  }, []);

  const removeHighlight = useCallback((id: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const clearHighlights = useCallback(() => {
    setHighlights([]);
  }, []);

  const clearHighlightsBySource = useCallback((source: 'ai' | 'search' | 'user') => {
    setHighlights((prev) => prev.filter((h) => h.source !== source));
  }, []);

  useEffect(() => {
    const unsubscribe = onHighlightRequest(sequenceId, (region) => {
      addHighlight(region);
    });
    return unsubscribe;
  }, [sequenceId, addHighlight]);

  return {
    highlights,
    addHighlight,
    removeHighlight,
    clearHighlights,
    clearHighlightsBySource,
  };
}

export function createHighlight(
  start: number,
  end: number,
  source: 'ai' | 'search' | 'user',
  options?: {
    wraps?: boolean;
    color?: string;
    label?: string;
  }
): HighlightRegion {
  return {
    id: `highlight_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    start,
    end,
    wraps: options?.wraps,
    color:
      options?.color ?? (source === 'ai' ? '#3b82f6' : source === 'search' ? '#eab308' : '#22c55e'),
    label: options?.label,
    source,
  };
}
