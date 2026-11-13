import { describe, it, expect } from 'vitest';
import {
  getSidecarPath,
  isSidecarPath,
  getSourcePath,
  serializeSidecar,
  parseSidecar,
  computeChecksum,
  verifyChecksum,
  createRelativePath,
  resolveRelativePath,
  createVerificationResult,
  summarizeVerification,
} from './sidecar';
import type { VerificationResult } from './types';

describe('sidecar path utilities', () => {
  describe('getSidecarPath', () => {
    it('appends .waypoint.json extension', () => {
      expect(getSidecarPath('/data/sample.ab1')).toBe('/data/sample.ab1.waypoint.json');
      expect(getSidecarPath('relative/path.fastq')).toBe('relative/path.fastq.waypoint.json');
    });
  });

  describe('isSidecarPath', () => {
    it('returns true for sidecar paths', () => {
      expect(isSidecarPath('/data/sample.ab1.waypoint.json')).toBe(true);
    });

    it('returns false for non-sidecar paths', () => {
      expect(isSidecarPath('/data/sample.ab1')).toBe(false);
      expect(isSidecarPath('/data/sample.json')).toBe(false);
    });
  });

  describe('getSourcePath', () => {
    it('removes sidecar extension', () => {
      expect(getSourcePath('/data/sample.ab1.waypoint.json')).toBe('/data/sample.ab1');
    });

    it('returns null for non-sidecar paths', () => {
      expect(getSourcePath('/data/sample.ab1')).toBeNull();
    });
  });
});

describe('sidecar serialization', () => {
  const mockResult: VerificationResult = {
    type: 'verification',
    version: '1.0',
    createdAt: '2026-01-15T12:00:00Z',
    reference: {
      name: 'pUC19',
      path: '../refs/pUC19.gb',
      checksum: 'sha256:abc123',
    },
    result: {
      status: 'pass',
      identity: 99.8,
      mutations: [],
    },
    alignment: {
      algorithm: 'MAFFT',
      alignedRef: 'ATGC',
      alignedQuery: 'ATGC',
    },
    input: {
      checksum: 'sha256:def456',
      format: 'ab1',
      queryLength: 1000,
    },
  };

  describe('serializeSidecar', () => {
    it('produces valid JSON', () => {
      const json = serializeSidecar(mockResult);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('produces pretty-printed JSON', () => {
      const json = serializeSidecar(mockResult);
      expect(json).toContain('\n');
    });
  });

  describe('parseSidecar', () => {
    it('parses valid sidecar JSON', () => {
      const json = serializeSidecar(mockResult);
      const parsed = parseSidecar(json);

      expect(parsed.type).toBe('verification');
      expect(parsed.reference.name).toBe('pUC19');
    });

    it('throws on invalid JSON', () => {
      expect(() => parseSidecar('not json')).toThrow('Invalid sidecar JSON');
    });

    it('throws on missing required fields', () => {
      expect(() => parseSidecar('{}')).toThrow('Invalid sidecar structure');
    });
  });
});

describe('checksum utilities', () => {
  describe('computeChecksum', () => {
    it('computes SHA-256 checksum for string', async () => {
      const checksum = await computeChecksum('test data');

      expect(checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('computes SHA-256 checksum for ArrayBuffer', async () => {
      const buffer = new TextEncoder().encode('test data').buffer;
      const checksum = await computeChecksum(buffer);

      expect(checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('produces consistent checksums', async () => {
      const checksum1 = await computeChecksum('test');
      const checksum2 = await computeChecksum('test');

      expect(checksum1).toBe(checksum2);
    });

    it('produces different checksums for different data', async () => {
      const checksum1 = await computeChecksum('test1');
      const checksum2 = await computeChecksum('test2');

      expect(checksum1).not.toBe(checksum2);
    });
  });

  describe('verifyChecksum', () => {
    it('returns true for matching checksum', async () => {
      const data = 'test data';
      const checksum = await computeChecksum(data);

      expect(await verifyChecksum(data, checksum)).toBe(true);
    });

    it('returns false for non-matching checksum', async () => {
      const result = await verifyChecksum('test data', 'sha256:wrong');

      expect(result).toBe(false);
    });
  });
});

describe('relative path utilities', () => {
  describe('createRelativePath', () => {
    it('creates relative path to sibling directory', () => {
      const sidecar = '/data/samples/sample.ab1.waypoint.json';
      const ref = '/data/references/pUC19.gb';

      const relative = createRelativePath(sidecar, ref);

      expect(relative).toBe('../references/pUC19.gb');
    });

    it('creates relative path to parent directory', () => {
      const sidecar = '/data/samples/deep/sample.ab1.waypoint.json';
      const ref = '/data/pUC19.gb';

      const relative = createRelativePath(sidecar, ref);

      expect(relative).toBe('../../pUC19.gb');
    });

    it('creates relative path to child directory', () => {
      const sidecar = '/data/sample.ab1.waypoint.json';
      const ref = '/data/refs/pUC19.gb';

      const relative = createRelativePath(sidecar, ref);

      expect(relative).toBe('refs/pUC19.gb');
    });
  });

  describe('resolveRelativePath', () => {
    it('resolves relative path with ../', () => {
      const sidecar = '/data/samples/sample.ab1.waypoint.json';
      const relative = '../references/pUC19.gb';

      const resolved = resolveRelativePath(sidecar, relative);

      expect(resolved).toBe('/data/references/pUC19.gb');
    });

    it('resolves relative path without ../', () => {
      const sidecar = '/data/sample.ab1.waypoint.json';
      const relative = 'refs/pUC19.gb';

      const resolved = resolveRelativePath(sidecar, relative);

      expect(resolved).toBe('/data/refs/pUC19.gb');
    });
  });
});

describe('createVerificationResult', () => {
  it('creates valid verification result', () => {
    const result = createVerificationResult({
      reference: {
        name: 'pUC19',
        path: '../refs/pUC19.gb',
        checksum: 'sha256:abc123',
      },
      result: {
        status: 'pass',
        identity: 99.8,
        mutations: [],
      },
      alignment: {
        algorithm: 'MAFFT',
        alignedRef: 'ATGC',
        alignedQuery: 'ATGC',
      },
      input: {
        checksum: 'sha256:def456',
        format: 'ab1',
        queryLength: 1000,
      },
    });

    expect(result.type).toBe('verification');
    expect(result.version).toBe('1.0');
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('summarizeVerification', () => {
  it('summarizes verification result', () => {
    const result: VerificationResult = {
      type: 'verification',
      version: '1.0',
      createdAt: '2026-01-15T12:00:00Z',
      reference: {
        name: 'pUC19',
        path: '../refs/pUC19.gb',
        checksum: 'sha256:abc123',
      },
      result: {
        status: 'pass',
        identity: 99.8,
        coverage: 95,
        mutations: [
          { position: 100, type: 'substitution', ref: 'A', alt: 'G', length: 1 },
          {
            position: 200,
            type: 'substitution',
            ref: 'T',
            alt: 'C',
            length: 1,
            classification: { in_cds: true, classification: 'synonymous' },
          },
          {
            position: 300,
            type: 'insertion',
            ref: '-',
            alt: 'A',
            length: 1,
            classification: { in_cds: true, classification: 'frameshift' },
          },
        ],
      },
      alignment: {
        algorithm: 'MAFFT',
        alignedRef: 'ATGC',
        alignedQuery: 'ATGC',
      },
      input: {
        checksum: 'sha256:def456',
        format: 'ab1',
        queryLength: 1000,
      },
    };

    const summary = summarizeVerification(result);

    expect(summary.status).toBe('pass');
    expect(summary.identity).toBe(99.8);
    expect(summary.coverage).toBe(95);
    expect(summary.mutationCount).toBe(3);
    expect(summary.substitutions).toBe(2);
    expect(summary.insertions).toBe(1);
    expect(summary.deletions).toBe(0);
    expect(summary.inCds).toBe(2);
    expect(summary.nonSynonymous).toBe(1);
  });
});
