const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SOURCE_LOCK_BYTES } = require('./ngs-tools.cjs');
const { collectAppOwnedToolSources } = require('./app-owned-tool-sources.cjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('package collection requires the complete native NGS source set and retains the producer receipt', (t) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-tool-source-'));
  t.after(() => fs.rmSync(appPath, { recursive: true, force: true }));
  const helpers = path.join(appPath, 'Contents', 'Helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, 'minimap2-aarch64-apple-darwin'), 'unsigned');
  assert.throws(
    () => collectAppOwnedToolSources({ appPath, arch: 'arm64' }),
    /no source-build receipt/
  );
  fs.writeFileSync(path.join(helpers, 'ngs-tools.source.lock.json'), SOURCE_LOCK_BYTES);
  const receipt = {
    schema: 'dnaforge.ngs-tools-build.v1',
    phase: 'source-build-before-package-signing',
    sourceLockSha256: hash(SOURCE_LOCK_BYTES),
    target: 'aarch64-apple-darwin',
    profile: 'local-bam-v1',
    tools: Object.fromEntries(
      ['minimap2', 'samtools'].map((name) => [
        name,
        { file: `${name}-aarch64-apple-darwin`, sha256: hash(name) },
      ])
    ),
  };
  fs.writeFileSync(path.join(helpers, 'ngs-tools.build.json'), JSON.stringify(receipt));
  const sources = collectAppOwnedToolSources({ appPath, arch: 'arm64' });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].sourceReceiptFile, 'ngs-tools.build.json');
  assert.throws(() => collectAppOwnedToolSources({ appPath, arch: 'x64' }), /incompatible/);
  fs.writeFileSync(
    path.join(helpers, 'coverage-build-provenance.json'),
    JSON.stringify({
      schema: 'dnaforge.coverage-helper-artifact/v1',
      target: receipt.target,
      binarySha256: hash('fresh-coverage'),
    })
  );
  const withCoverage = collectAppOwnedToolSources({ appPath, arch: 'arm64' });
  assert.equal(withCoverage[2].sourceBuildSha256, hash('fresh-coverage'));
  assert.equal(withCoverage[2].sourceReceiptFile, 'coverage-build-provenance.json');
});
