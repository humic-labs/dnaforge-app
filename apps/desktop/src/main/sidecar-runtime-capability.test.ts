import { execFileSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  assertDevGenomeRuntime,
  assertPackagedGenomeRuntime,
  GENOME_RUNTIME_CAPABILITY,
  shouldRequireGenomeRuntime,
} from './sidecar-runtime-capability';

function execFileReturning(stdout: string): typeof execFileSync {
  const child = { execFileSync };
  vi.spyOn(child, 'execFileSync').mockReturnValue(stdout);
  return child.execFileSync;
}

describe('sidecar BAM/CRAM runtime capability', () => {
  it('matches the Windows sidecar policy in development while preserving packaged verification', () => {
    expect(
      shouldRequireGenomeRuntime({ isPackaged: false, platform: 'win32', nodeEnv: 'development' })
    ).toBe(false);
    expect(shouldRequireGenomeRuntime({ isPackaged: true, platform: 'win32' })).toBe(true);
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        shouldRequireGenomeRuntime({ isPackaged: false, platform, nodeEnv: 'development' })
      ).toBe(true);
    }
  });

  it('permits an incomplete runtime only in the explicitly scoped non-BAM E2E lane', () => {
    expect(
      shouldRequireGenomeRuntime({
        isPackaged: false,
        nodeEnv: 'test',
        waypointTest: '1',
        allowIncompleteE2eRuntime: '1',
      })
    ).toBe(false);

    expect(
      shouldRequireGenomeRuntime({
        isPackaged: true,
        packagedRuntimeReceipt: {
          schema: 'dnaforge.genome-runtime-unavailable.v1',
          capability: 'genome.pysam-htslib.v1',
          reason: 'unsupported-on-target',
          target: 'win32',
        },
      })
    ).toBe(false);

    for (const input of [
      {
        isPackaged: true,
        nodeEnv: 'test',
        waypointTest: '1',
        allowIncompleteE2eRuntime: '1',
      },
      {
        isPackaged: false,
        nodeEnv: 'development',
        waypointTest: undefined,
        allowIncompleteE2eRuntime: '1',
      },
      {
        isPackaged: false,
        nodeEnv: 'test',
        waypointTest: '1',
        allowIncompleteE2eRuntime: undefined,
      },
    ] as const) {
      expect(shouldRequireGenomeRuntime(input)).toBe(true);
    }
  });

  it('accepts only the exact Python executable that can import pysam', () => {
    const receipt = {
      schema: 'dnaforge.genome-runtime-capability.v1',
      capability: 'genome.pysam-htslib.v1',
      pysamVersion: '0.24.0',
      coverageEngineIdentity: `dna-coverage:schema-1:sha256-${'a'.repeat(64)}`,
    } as const;
    const execFile = execFileReturning(JSON.stringify(receipt));

    expect(
      assertDevGenomeRuntime(
        '/worktree/apps/api/.venv/bin/python3',
        { cwd: '/worktree/apps/api', env: { DNAFORGE_HELPERS_DIR: '/worktree/helpers' } },
        execFile
      )
    ).toEqual(receipt);
    expect(execFile).toHaveBeenCalledWith(
      '/worktree/apps/api/.venv/bin/python3',
      [
        '-B',
        '-c',
        'import json; from src.runtime_capabilities import genome_runtime_receipt; print(json.dumps(genome_runtime_receipt()))',
      ],
      expect.objectContaining({
        cwd: '/worktree/apps/api',
        env: expect.objectContaining({
          DNAFORGE_HELPERS_DIR: '/worktree/helpers',
          PYTHONDONTWRITEBYTECODE: '1',
        }),
        timeout: 10_000,
      })
    );
    expect(GENOME_RUNTIME_CAPABILITY).toBe('genome.pysam-htslib.v1');
  });

  it('fails closed with the repair command when pysam is missing', () => {
    const importError = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from("ModuleNotFoundError: No module named 'pysam'"),
    });
    const execFile = vi.fn(() => {
      throw importError;
    });

    expect(() =>
      assertDevGenomeRuntime('/broken/apps/api/.venv/bin/python3', {}, execFile)
    ).toThrowError(
      /DNAForge will not start with a sidecar that cannot render BAM\/CRAM tracks[\s\S]*uv sync --frozen --extra dev[\s\S]*pnpm --dir apps\/desktop helpers:build[\s\S]*No module named 'pysam'/
    );
  });

  it('rejects a corrupt native install that imports without a usable version', () => {
    const execFile = execFileReturning('\n');

    expect(() => assertDevGenomeRuntime('/broken/python3', {}, execFile)).toThrowError(
      /Unexpected end of JSON input/
    );
  });

  it('rejects the former pysam-only receipt before the app opens', () => {
    const execFile = execFileReturning(
      JSON.stringify({
        schema: 'dnaforge.genome-runtime-capability.v1',
        capability: 'genome.pysam-htslib.v1',
        pysamVersion: '0.24.0',
      })
    );

    expect(() => assertDevGenomeRuntime('/stale/python3', {}, execFile)).toThrowError(
      /invalid capability receipt/
    );
  });

  it('accepts a frozen sidecar only after its native capability probe passes', () => {
    const execFile = execFileReturning(
      JSON.stringify({
        schema: 'dnaforge.genome-runtime-capability.v1',
        capability: 'genome.pysam-htslib.v1',
        pysamVersion: '0.24.0',
        coverageEngineIdentity: `dna-coverage:schema-1:sha256-${'b'.repeat(64)}`,
      })
    );

    expect(
      assertPackagedGenomeRuntime('/Applications/DNAForge/waypoint-api', {}, execFile)
    ).toEqual({
      schema: 'dnaforge.genome-runtime-capability.v1',
      capability: 'genome.pysam-htslib.v1',
      pysamVersion: '0.24.0',
      coverageEngineIdentity: `dna-coverage:schema-1:sha256-${'b'.repeat(64)}`,
    });
    expect(execFile).toHaveBeenCalledWith(
      '/Applications/DNAForge/waypoint-api',
      ['--verify-genome-runtime'],
      expect.objectContaining({ env: expect.any(Object), timeout: 20_000 })
    );
  });

  it('accepts a frozen sidecar that proves the runtime is intentionally absent', () => {
    const receipt = {
      schema: 'dnaforge.genome-runtime-unavailable.v1',
      capability: 'genome.pysam-htslib.v1',
      reason: 'unsupported-on-target',
      target: 'win32',
    } as const;
    const execFile = execFileReturning(JSON.stringify(receipt));

    expect(assertPackagedGenomeRuntime('C:\\DNAForge\\waypoint-api.exe', {}, execFile)).toEqual(
      receipt
    );
  });

  it('rejects an unrecognized frozen-sidecar absence claim', () => {
    const execFile = execFileReturning(
      JSON.stringify({
        schema: 'dnaforge.genome-runtime-unavailable.v1',
        capability: 'genome.pysam-htslib.v1',
        reason: 'missing-dll',
        target: 'win32',
      })
    );

    expect(() => assertPackagedGenomeRuntime('C:\\broken\\waypoint-api.exe', {}, execFile)).toThrow(
      /invalid capability receipt/
    );
  });

  it('fails closed when a frozen sidecar omits or cannot load pysam', () => {
    const execFile = vi.fn(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from("Required BAM/CRAM runtime is unavailable: No module named 'pysam'"),
      });
    });

    expect(() => assertPackagedGenomeRuntime('/broken/waypoint-api', {}, execFile)).toThrowError(
      /app will not open[\s\S]*Reinstall a complete DNAForge build[\s\S]*No module named 'pysam'/
    );
  });
});
