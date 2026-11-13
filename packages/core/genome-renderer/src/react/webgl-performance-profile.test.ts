// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Genome } from '@waypoint/genome-renderer';
import {
  pixiInitOptionsForPerformanceMode,
  resolveWebGLPerformanceMode,
} from './webgl-performance-profile';

function genome(overrides: Partial<Genome>): Genome {
  return {
    name: 'test',
    length: 10_000,
    circular: true,
    features: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebGL performance profile', () => {
  it('keeps small genomes on the default profile', () => {
    expect(resolveWebGLPerformanceMode(genome({ length: 20_000 }))).toBe('default');
  });

  it('keeps large genomes on the default profile on capable hardware', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      hardwareConcurrency: 12,
      deviceMemory: 16,
    });

    expect(resolveWebGLPerformanceMode(genome({ length: 4_600_000 }))).toBe('default');
  });

  it('keeps capable Windows hardware on the default profile', () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 16,
      deviceMemory: 16,
    });

    expect(resolveWebGLPerformanceMode(genome({ length: 4_600_000 }))).toBe('default');
  });

  it('keeps weak hardware on the default profile', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0',
      hardwareConcurrency: 4,
      deviceMemory: 4,
    });

    expect(resolveWebGLPerformanceMode(genome({ length: 4_600_000 }))).toBe('default');
  });

  it('honors caller quality overrides', () => {
    expect(resolveWebGLPerformanceMode(genome({ length: 4_600_000 }), 'quality')).toBe('default');
    expect(resolveWebGLPerformanceMode(genome({ length: 4_600_000 }), 'default')).toBe('default');
  });

  it('keeps auto mode on the default profile even when the render loop observes slow frames', () => {
    expect(resolveWebGLPerformanceMode(genome({ length: 20_000 }), 'auto')).toBe('default');
  });

  it('preserves high-DPI rendering in stability mode', () => {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });

    expect(pixiInitOptionsForPerformanceMode('stability')).toEqual({
      antialias: false,
      resolution: 2,
    });
  });
});
