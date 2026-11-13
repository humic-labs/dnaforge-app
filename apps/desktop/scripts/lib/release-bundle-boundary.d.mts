import type { Plugin } from 'vite';

export type ReleaseBundleTarget = 'main' | 'preload' | 'renderer' | 'renderer-worker';

export interface ReleaseBundleViolation {
  path: string;
  reason: string;
  shipped: boolean;
}

export type ReleaseBundlePolicy = 'release' | 'internal';

export interface ReleaseBundleReport {
  schema: string;
  policy: ReleaseBundlePolicy;
  target: ReleaseBundleTarget;
  sources: string[];
  dependencySources: string[];
  exceptions: string[];
  violations: ReleaseBundleViolation[];
}

export const RELEASE_SOURCES_SCHEMA: string;
export const RELEASE_SOURCES_TARGETS: ReleaseBundleTarget[];
export const SHIPPED_DESKTOP_SCRIPTS: string[];
export const SHIPPED_EXCEPTIONS: string[];
export const SHIPPED_EXCEPTIONS_TICKET: string;
export const RELEASE_POLICY: 'release';
export const INTERNAL_POLICY: 'internal';
export const INTERNAL_MODES: string[];
export function boundaryPolicyForMode(mode: string): ReleaseBundlePolicy;
export function bundleSourcePath(id: string, repoRoot: string, baseDir?: string): string | null;
export function isDependencySourcePath(path: unknown): path is string;
export function releaseSourceViolation(
  path: string,
  options?: { shippedTextFiles?: string[] }
): string | null;
export function neverImportableViolation(path: string): string | null;
export function releaseBundleReport(input: {
  target: ReleaseBundleTarget;
  loadedIds: string[];
  chunks: unknown[];
  repoRoot: string;
  viteRoot?: string;
  shippedTextFiles?: string[];
  policy?: ReleaseBundlePolicy;
}): ReleaseBundleReport;
export function formatReleaseBundleViolations(report: ReleaseBundleReport): string;
export function createReleaseBundleBoundary(options: {
  repoRoot: string;
  shippedTextFiles?: string[];
}): (target: ReleaseBundleTarget) => Plugin;
