// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION } from '@waypoint/share-bundle';

import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_MIGRATORS,
  SEQUENCE_PACKAGE_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_SCHEMA,
  SEQUENCE_PACKAGE_SCHEMA_ALIASES,
  SEQUENCE_PACKAGE_V1_MEMBER_DIRS,
} from './sequence-package-contract';
import { SEQUENCE_PACKAGE_REGISTRY } from './sequence-package-registry';
import {
  SEQUENCE_ASSETS_DIR,
  SEQUENCE_PACKAGE_SCHEMA as SCHEMA_FROM_PACKAGE,
  SEQUENCE_PRIMERS_DIR,
} from './sequence-package';

const DIR = dirname(fileURLToPath(import.meta.url));

describe('DNA sequence package contract (migrate-or-block)', () => {
  it('keeps portable workspace-sync authority aligned with the on-disk package contract', () => {
    expect(MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
  });

  it('writes the sequence family and still recognizes the older on-disk family', () => {
    expect(SEQUENCE_PACKAGE_SCHEMA).toBe('waypoint.sequence.v1');
    expect(SCHEMA_FROM_PACKAGE).toBe(SEQUENCE_PACKAGE_SCHEMA);
    expect(SEQUENCE_PACKAGE_SCHEMA_ALIASES).toContain('waypoint.sequence.v1');
    expect(SEQUENCE_PACKAGE_SCHEMA_ALIASES).toContain('waypoint.plasmid.v1');
  });

  it('re-exports v1 member dirs from the contract (no private copies)', () => {
    expect(SEQUENCE_PRIMERS_DIR).toBe('primers');
    expect(SEQUENCE_ASSETS_DIR).toBe('assets');
    expect(SEQUENCE_PACKAGE_V1_MEMBER_DIRS).toEqual(['primers', 'assets']);
    const packageSource = readFileSync(join(DIR, 'sequence-package.ts'), 'utf8');
    expect(packageSource).toMatch(/from '\.\/sequence-package-contract'/);
    expect(packageSource).not.toMatch(/export const SEQUENCE_PRIMERS_DIR\s*=/);
    expect(packageSource).not.toMatch(/export const SEQUENCE_ASSETS_DIR\s*=/);
    expect(packageSource).not.toMatch(/export const SEQUENCE_PACKAGE_SCHEMA\s*=/);
  });

  it('requires a migrator chain from 1 to FORMAT_VERSION', () => {
    if (SEQUENCE_PACKAGE_FORMAT_VERSION === 1) {
      expect(SEQUENCE_PACKAGE_MIGRATORS).toEqual([]);
      expect(SEQUENCE_PACKAGE_PAYLOAD_DIR).toBeNull();
      return;
    }
    let version = 1;
    for (const step of SEQUENCE_PACKAGE_MIGRATORS) {
      expect(step.from).toBe(version);
      expect(step.to).toBe(version + 1);
      expect(step.name).toMatch(/^migrateSequencePackageV\d+ToV\d+$/);
      version = step.to;
    }
    expect(version).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(SEQUENCE_PACKAGE_PAYLOAD_DIR).toBe('contents');
  });

  it('exposes one greppable registry of current version and steps', () => {
    expect(SEQUENCE_PACKAGE_REGISTRY.currentFormatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(SEQUENCE_PACKAGE_REGISTRY.steps).toBe(SEQUENCE_PACKAGE_MIGRATORS);
    expect(SEQUENCE_PACKAGE_REGISTRY.payloadDir).toBe('contents');
  });
});
