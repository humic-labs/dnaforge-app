const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SOURCE_LOCK,
  ngsToolSuffix,
  verifyNgsVersion,
  macSystemDependencies,
} = require('./ngs-tools.cjs');

test('NGS tools retain the exact minimap2, samtools and external HTSlib reference versions', () => {
  assert.equal(verifyNgsVersion('minimap2', '2.31-r1302\n'), '2.31-r1302');
  assert.equal(
    verifyNgsVersion('samtools', 'samtools 1.24\nUsing htslib 1.25\nFeatures: test'),
    '1.24'
  );
  assert.throws(
    () => verifyNgsVersion('samtools', 'samtools 1.24\nUsing htslib 1.24'),
    /Unexpected/
  );
  assert.throws(() => verifyNgsVersion('minimap2', '2.30-r1287'), /Unexpected/);
  assert.deepEqual(SOURCE_LOCK.versions, {
    minimap2: '2.31-r1302',
    samtools: '1.24',
    htslib: '1.25',
  });
});

test('NGS tools expose only the two declared native Mac architecture suffixes', () => {
  assert.equal(ngsToolSuffix('arm64'), 'aarch64-apple-darwin');
  assert.equal(ngsToolSuffix('x64'), 'x86_64-apple-darwin');
  assert.throws(() => ngsToolSuffix('ia32'), /not built/);
});

test('NGS tool dependencies permit system libraries and reject Homebrew or unresolved dylibs', () => {
  assert.deepEqual(
    macSystemDependencies(
      '/tools/samtools:\n /usr/lib/libz.1.dylib (compatibility version 1.0.0)\n /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)'
    ),
    ['/usr/lib/libz.1.dylib', '/usr/lib/libSystem.B.dylib']
  );
  for (const dependency of [
    '/opt/homebrew/lib/libhts.3.dylib',
    '/usr/local/lib/libz.1.dylib',
    '@rpath/libhts.3.dylib',
  ]) {
    assert.throws(
      () => macSystemDependencies(`/tools/samtools:\n ${dependency} (compatibility version 1.0.0)`),
      /non-system/
    );
  }
  assert.throws(() => macSystemDependencies('/tools/samtools:'), /non-system/);
});
