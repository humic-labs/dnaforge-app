const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parse } = require('yaml');

const desktop = path.resolve(__dirname, '../..');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
const { copyFiles, getFileMatchers } = builderRequire('app-builder-lib/out/fileMatcher.js');

test('the actual builder keeps programs in Helpers and preserves license directories in Resources', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-tool-licenses-'));
  try {
    const source = path.join(root, 'project');
    const helpers = path.join(source, 'resources/helpers');
    const files = new Map([
      ['fastp', 'owned program bytes'],
      ['fastp.build.json', '{"schema":1}'],
      ['fastp.licenses/fastp-LICENSE', 'fastp license bytes'],
      ['ngs-tools.licenses/minimap2-COPYING', 'minimap2 license bytes'],
      ['README.md', 'source helper instructions'],
    ]);
    for (const [relative, bytes] of files) {
      const destination = path.join(helpers, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    const config = parse(readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8'));
    const selected = Object.fromEntries(['extraFiles', 'extraResources'].map((key) => [key,
      config[key].filter((entry) => entry.from === 'resources/helpers/') ]));
    const contents = path.join(root, 'output/DNAForge.app/Contents');
    const resources = path.join(contents, 'Resources');
    const options = { defaultSrc: source, globalOutDir: path.join(root, 'output'),
      macroExpander: (value) => value, customBuildOptions: {} };
    await copyFiles(getFileMatchers(selected, 'extraFiles', contents, options));
    await copyFiles(getFileMatchers(selected, 'extraResources', resources, options));

    assert.equal(readFileSync(path.join(contents, 'Helpers/fastp'), 'utf8'), files.get('fastp'));
    assert.equal(readFileSync(path.join(contents, 'Helpers/fastp.build.json'), 'utf8'), files.get('fastp.build.json'));
    assert.equal(existsSync(path.join(contents, 'Helpers/fastp.licenses')), false);
    assert.equal(existsSync(path.join(contents, 'Helpers/ngs-tools.licenses')), false);
    assert.equal(existsSync(path.join(contents, 'Helpers/README.md')), false);
    for (const relative of ['fastp.licenses/fastp-LICENSE', 'ngs-tools.licenses/minimap2-COPYING']) {
      assert.equal(readFileSync(path.join(resources, 'tool-licenses', relative), 'utf8'), files.get(relative));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
