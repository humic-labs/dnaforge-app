// @vitest-environment node

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'staleness-detection');

const FILES = {
  reference: path.join(FIXTURE_DIR, 'reference.gb'),
  query: path.join(FIXTURE_DIR, 'query-identical.fasta'),
  substitutions: path.join(FIXTURE_DIR, 'reference-with-substitutions.gb'),
  insertions: path.join(FIXTURE_DIR, 'reference-with-insertions.gb'),
  deletions: path.join(FIXTURE_DIR, 'reference-with-deletions.gb'),
};

function computeHash(content: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

describe('staleness detection with live fixtures', () => {
  let referenceContent: string;
  let referenceHash: string;

  beforeAll(() => {
    for (const [name, filePath] of Object.entries(FILES)) {
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `Fixture file missing: ${name} at ${filePath}\n` +
            'Check __fixtures__/staleness-detection/ directory'
        );
      }
    }

    referenceContent = fs.readFileSync(FILES.reference, 'utf-8');
    referenceHash = computeHash(referenceContent);
  });

  it('reference hash is a valid sha256 string', () => {
    expect(referenceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('same file content produces the same hash (deterministic)', () => {
    const hash2 = computeHash(referenceContent);
    expect(hash2).toBe(referenceHash);
  });

  it('re-reading the same file produces the same hash', () => {
    const content2 = fs.readFileSync(FILES.reference, 'utf-8');
    const hash2 = computeHash(content2);
    expect(hash2).toBe(referenceHash);
  });

  it('identical query FASTA has different hash (different file format)', () => {
    const queryContent = fs.readFileSync(FILES.query, 'utf-8');
    const queryHash = computeHash(queryContent);
    expect(queryHash).not.toBe(referenceHash);
  });

  describe('mutation variants produce different hashes (staleness detected)', () => {
    it('substitution variant has different hash', () => {
      const content = fs.readFileSync(FILES.substitutions, 'utf-8');
      const hash = computeHash(content);
      expect(hash).not.toBe(referenceHash);
    });

    it('insertion variant has different hash', () => {
      const content = fs.readFileSync(FILES.insertions, 'utf-8');
      const hash = computeHash(content);
      expect(hash).not.toBe(referenceHash);
    });

    it('deletion variant has different hash', () => {
      const content = fs.readFileSync(FILES.deletions, 'utf-8');
      const hash = computeHash(content);
      expect(hash).not.toBe(referenceHash);
    });
  });

  describe('all variant hashes are unique', () => {
    it('no two variants share a hash', () => {
      const hashes = new Map<string, string>();
      const allFiles = {
        reference: FILES.reference,
        substitutions: FILES.substitutions,
        insertions: FILES.insertions,
        deletions: FILES.deletions,
      };

      for (const [name, filePath] of Object.entries(allFiles)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = computeHash(content);

        for (const [existingName, existingHash] of hashes) {
          expect(hash).not.toBe(existingHash);
        }
        hashes.set(name, hash);
      }

      expect(hashes.size).toBe(4);
    });
  });

  describe('staleness check simulation', () => {
    function checkStaleness(storedChecksum: string, currentFileContent: string): boolean {
      const currentHash = computeHash(currentFileContent);
      return storedChecksum !== currentHash;
    }

    it('original reference is NOT stale', () => {
      const isStale = checkStaleness(referenceHash, referenceContent);
      expect(isStale).toBe(false);
    });

    it('substitution variant IS stale', () => {
      const content = fs.readFileSync(FILES.substitutions, 'utf-8');
      const isStale = checkStaleness(referenceHash, content);
      expect(isStale).toBe(true);
    });

    it('insertion variant IS stale', () => {
      const content = fs.readFileSync(FILES.insertions, 'utf-8');
      const isStale = checkStaleness(referenceHash, content);
      expect(isStale).toBe(true);
    });

    it('deletion variant IS stale', () => {
      const content = fs.readFileSync(FILES.deletions, 'utf-8');
      const isStale = checkStaleness(referenceHash, content);
      expect(isStale).toBe(true);
    });
  });

  describe('sequence length validation (coordinate space mismatch)', () => {
    function extractSequence(gbContent: string): string {
      const match = gbContent.match(/ORIGIN\s*\n([\s\S]*?)\/\//);
      if (!match) return '';
      return match[1].replace(/[\s0-9]/g, '').toUpperCase();
    }

    it('reference has expected length (2686 bp)', () => {
      const seq = extractSequence(referenceContent);
      expect(seq.length).toBe(2686);
    });

    it('substitution variant has same length (2686 bp)', () => {
      const content = fs.readFileSync(FILES.substitutions, 'utf-8');
      const seq = extractSequence(content);
      expect(seq.length).toBe(2686);
    });

    it('insertion variant is longer (2698 bp)', () => {
      const content = fs.readFileSync(FILES.insertions, 'utf-8');
      const seq = extractSequence(content);
      expect(seq.length).toBe(2698);
    });

    it('deletion variant is shorter (2674 bp)', () => {
      const content = fs.readFileSync(FILES.deletions, 'utf-8');
      const seq = extractSequence(content);
      expect(seq.length).toBe(2674);
    });

    it('insertion/deletion would cause gapped sequence length mismatch', () => {
      const originalLen = extractSequence(referenceContent).length;
      const insertionLen = extractSequence(fs.readFileSync(FILES.insertions, 'utf-8')).length;
      const deletionLen = extractSequence(fs.readFileSync(FILES.deletions, 'utf-8')).length;

      expect(originalLen).not.toBe(insertionLen);
      expect(originalLen).not.toBe(deletionLen);
    });

    it('substitution would NOT cause length mismatch (but hash differs)', () => {
      const originalLen = extractSequence(referenceContent).length;
      const subLen = extractSequence(fs.readFileSync(FILES.substitutions, 'utf-8')).length;
      expect(originalLen).toBe(subLen);
    });
  });
});
