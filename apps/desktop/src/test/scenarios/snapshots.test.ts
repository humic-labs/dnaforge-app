import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sidecarScenarios, withMafft, withPlugin } from './sidecar';
import type { ToolboxStatusResponse } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = resolve(__dirname, '../../../../../apps/api/tests/snapshots');

function readSnapshot(name: string): Record<string, unknown> | null {
  const path = resolve(snapshotsDir, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function stripUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        result[key] = stripUndefined(value);
      }
    }
    return result;
  }
  return obj;
}

function assertMatchesSnapshot(name: string, scenario: ToolboxStatusResponse) {
  const snapshot = readSnapshot(name);
  if (snapshot === null) {
    console.warn(`Snapshot ${name}.json not found — run Python tests first`);
    return;
  }
  expect(stripUndefined(scenario)).toEqual(snapshot);
}

describe('Scenario snapshot parity (Python → TS)', () => {
  it('fresh_install matches Python snapshot', () => {
    assertMatchesSnapshot('fresh_install', sidecarScenarios.freshInstall());
  });

  it('fully_ready matches Python snapshot', () => {
    assertMatchesSnapshot('fully_ready', sidecarScenarios.fullyReady());
  });

  it('downloading_tools_50 matches Python snapshot', () => {
    assertMatchesSnapshot('downloading_tools_50', sidecarScenarios.downloadingTools(50));
  });

  it('downloading_databases_30 matches Python snapshot', () => {
    assertMatchesSnapshot('downloading_databases_30', sidecarScenarios.downloadingDatabases(30));
  });

  it('downloading_all_25_60 matches Python snapshot', () => {
    assertMatchesSnapshot('downloading_all_25_60', sidecarScenarios.downloadingAll(25, 60));
  });

  it('tools_error matches Python snapshot', () => {
    assertMatchesSnapshot('tools_error', sidecarScenarios.toolsError());
  });

  it('partial_ready_blastn matches Python snapshot', () => {
    assertMatchesSnapshot('partial_ready_blastn', sidecarScenarios.partialReady(['blastn']));
  });

  it('mixed_component_status matches Python snapshot', () => {
    assertMatchesSnapshot('mixed_component_status', sidecarScenarios.mixedComponentStatus());
  });

  it('with_mafft_fresh matches Python snapshot', () => {
    assertMatchesSnapshot('with_mafft_fresh', withMafft(sidecarScenarios.freshInstall()));
  });

  it('with_plugin_alphafold matches Python snapshot', () => {
    assertMatchesSnapshot(
      'with_plugin_alphafold',
      withPlugin(sidecarScenarios.fullyReady(), 'alphafold', {
        label: 'AlphaFold',
        url: 'http://localhost:9001',
      })
    );
  });
});
