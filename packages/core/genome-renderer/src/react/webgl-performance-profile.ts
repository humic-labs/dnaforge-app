import type { Genome } from '@waypoint/genome-renderer';

export type WebGLPerformanceMode = 'default' | 'stability';
export type WebGLPerformancePreference = 'auto' | 'quality' | 'stability';

export const WEBGL_PERFORMANCE_PREFERENCES: readonly WebGLPerformancePreference[] = [
  'auto',
  'quality',
  'stability',
] as const;

export function resolveWebGLPerformanceMode(
  genome: Genome,
  preference: WebGLPerformancePreference | WebGLPerformanceMode = 'auto'
): WebGLPerformanceMode {
  void genome;
  if (preference === 'default' || preference === 'quality') return 'default';
  if (preference === 'stability') return 'stability';

  return 'default';
}

function devicePixelResolution(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

export function pixiInitOptionsForPerformanceMode(mode: WebGLPerformanceMode): {
  antialias: boolean;
  resolution: number;
} {
  if (mode === 'stability') {
    return {
      antialias: false,
      resolution: devicePixelResolution(),
    };
  }
  return {
    antialias: true,
    resolution: devicePixelResolution(),
  };
}
