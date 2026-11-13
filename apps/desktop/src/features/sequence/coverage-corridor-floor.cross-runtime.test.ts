// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlignedReadSourceGenerationV1 } from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';
import { describe, expect, it } from 'vitest';
import { prepareAuthenticatedCoverageCorridorFloorPayload } from './coverage-corridor-floor';

const OUTPUT_PREFIX = 'DNAFORGE_COVERAGE_CORRIDOR_CROSS_RUNTIME=';
const EXPECTED_GRCH38_LENGTH = 3_088_269_832;
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/api');
const FIXTURE_SCRIPT = resolve(API_ROOT, 'tests/coverage_corridor_floor_cross_runtime_fixture.py');
const CROSS_RUNTIME_PYTHON = process.env.DNAFORGE_CROSS_RUNTIME_PYTHON;

interface CrossRuntimeReceipt {
  source: {
    bamPath: string;
    indexPath: string;
    referencePath: string;
    generation: AlignedReadSourceGenerationV1;
  };
  assembly: Assembly;
  payload: {
    bytesBase64: string;
    contractHeader: string;
    sourceHeader: string;
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseReceipt(stdout: string): CrossRuntimeReceipt {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith(OUTPUT_PREFIX));
  if (line == null) throw new Error(`Python fixture did not emit ${OUTPUT_PREFIX}`);
  const value: unknown = JSON.parse(line.slice(OUTPUT_PREFIX.length));
  const receipt = requireRecord(value, 'receipt');
  const source = requireRecord(receipt.source, 'source');
  const generation = requireRecord(source.generation, 'source.generation');
  const assembly = requireRecord(receipt.assembly, 'assembly');
  const payload = requireRecord(receipt.payload, 'payload');
  if (
    typeof source.bamPath !== 'string' ||
    typeof source.indexPath !== 'string' ||
    typeof source.referencePath !== 'string' ||
    generation.contract !== 'aligned-read-source-generation.v1' ||
    typeof assembly.id !== 'string' ||
    typeof assembly.displayName !== 'string' ||
    typeof assembly.totalLengthBp !== 'number' ||
    !Array.isArray(assembly.chromosomes) ||
    typeof payload.bytesBase64 !== 'string' ||
    typeof payload.contractHeader !== 'string' ||
    typeof payload.sourceHeader !== 'string'
  ) {
    throw new Error('Python fixture emitted an invalid corridor receipt');
  }
  return value as CrossRuntimeReceipt;
}

describe.runIf(CROSS_RUNTIME_PYTHON != null)(
  'coverage corridor floor Python-to-TypeScript contract',
  () => {
    it('admits a generation-bound complete 24-chromosome GRCh38 route artifact', async () => {
      if (CROSS_RUNTIME_PYTHON == null) {
        throw new Error('DNAFORGE_CROSS_RUNTIME_PYTHON is required by the seam-test driver');
      }
      const stdout = execFileSync(CROSS_RUNTIME_PYTHON, [FIXTURE_SCRIPT], {
        cwd: API_ROOT,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      const receipt = parseReceipt(stdout);
      const encoded = Buffer.from(receipt.payload.bytesBase64, 'base64');
      const bytes = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      ) as ArrayBuffer;

      const prepared = await prepareAuthenticatedCoverageCorridorFloorPayload(
        {
          baseUrl: 'http://sidecar.test',
          source: receipt.source,
          assembly: receipt.assembly,
        },
        {
          bytes,
          contractHeader: receipt.payload.contractHeader,
          sourceHeader: receipt.payload.sourceHeader,
        }
      );

      expect(receipt.assembly.totalLengthBp).toBe(EXPECTED_GRCH38_LENGTH);
      expect(receipt.assembly.chromosomes).toHaveLength(24);
      expect(prepared.floor.assemblyEnd).toBe(EXPECTED_GRCH38_LENGTH);
      expect([...prepared.floor.layers.keys()]).toEqual(
        receipt.assembly.chromosomes.map((placement) => placement.chromosome.id)
      );
      expect(prepared.atlas.assemblyEndBp).toBe(EXPECTED_GRCH38_LENGTH);
      expect(prepared.atlas.chromosomes).toHaveLength(24);
      expect(prepared.atlas.authorityKey).not.toHaveLength(0);
    }, 20_000);
  }
);
