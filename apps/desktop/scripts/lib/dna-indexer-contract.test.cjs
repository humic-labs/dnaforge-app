'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  EXPECTED_OUTPUTS,
  dnaIndexerBundleProblem,
  inspectDnaIndexerContract,
} = require('./dna-indexer-contract.cjs');

function bgzfFixture() {
  return Buffer.from([
    0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43, 0x02, 0x00,
    0x1b, 0x00,
  ]);
}

function writeCurrentBundle(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of EXPECTED_OUTPUTS) {
    fs.writeFileSync(path.join(outputDir, name), bgzfFixture());
  }
  fs.writeFileSync(path.join(outputDir, 'contract.fa.gz.fai'), 'contract\t80\t10\t80\t81\n');
  fs.writeFileSync(path.join(outputDir, 'contract.fa.gz.gzi'), Buffer.alloc(8));
}

describe('dna-indexer executable output contract', () => {
  it('accepts the current compressed and randomly seekable five-file bundle', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-indexer-contract-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeCurrentBundle(root);
    assert.equal(dnaIndexerBundleProblem(root), null);
  });

  it('rejects the legacy plain-FASTA layout even when an executable exits successfully', () => {
    const result = inspectDnaIndexerContract('/synthetic/dna-indexer', {
      run: (_helper, args) => {
        const outputDir = args[args.indexOf('--out-dir') + 1];
        fs.writeFileSync(path.join(outputDir, 'contract.fa'), 'legacy');
        fs.writeFileSync(path.join(outputDir, 'contract.fa.fai'), 'legacy');
        return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
      },
    });
    assert.match(result.problem, /contract\.fa\.gz/);
    assert.match(result.problem, /contract\.fa, contract\.fa\.fai/);
  });

  it('rejects ordinary gzip bytes masquerading as a BGZF bundle', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-indexer-contract-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeCurrentBundle(root);
    fs.writeFileSync(
      path.join(root, 'contract.fa.gz'),
      Buffer.from([
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
      ])
    );
    assert.match(dnaIndexerBundleProblem(root), /gzip, but not BGZF/);
  });

  it('reports the helper failure before inspecting partial output', () => {
    const result = inspectDnaIndexerContract('/synthetic/dna-indexer', {
      run: () => ({ status: 7, stdout: '', stderr: 'controlled failure' }),
    });
    assert.match(result.problem, /indexing probe failed \(exit 7\): controlled failure/);
  });
});
