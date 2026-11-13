import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  generateThirdPartyNotices,
  isCopyleftLicense,
  readManifest,
  spdxIdentifiers,
} from '../generate-third-party-notices.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageVersions = readFileSync(
  new URL('./fixtures/dugite-3.3.2-win32-x64-package-versions.txt', import.meta.url)
);
const expectedRows = [...new Set(packageVersions.toString('utf8').trim().split(/\r?\n/u))].map(
  (line) => line.split(/\s+/u)
);
const archiveSha256 = 'f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14';
const manifest = readManifest(repoRoot);

function fixture(operation, suffix = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'ucrt-notice-contract-'));
  try {
    mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    symlinkSync(
      path.join(repoRoot, 'apps/desktop/third-party'),
      path.join(root, 'apps/desktop/third-party'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    mkdirSync(path.join(root, 'node_modules/dugite/git/etc'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules/dugite/package.json'),
      '{"name":"dugite","version":"3.3.2"}'
    );
    writeFileSync(
      path.join(root, 'node_modules/dugite/git/etc/package-versions.txt'),
      Buffer.concat([packageVersions, Buffer.from(suffix)])
    );
    for (const relative of manifest.components
      .flatMap((component) => component.licenseFiles)
      .filter((relative) => !relative.startsWith('apps/desktop/third-party/'))) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(path.join(repoRoot, relative), target, 'file');
    }
    const run = (command, args, cwd) => {
      assert.equal(cwd, root);
      if (command === 'pnpm') {
        assert.deepEqual(args, [
          '--filter',
          '@waypoint/desktop',
          'licenses',
          'list',
          '--prod',
          '--json',
        ]);
        return JSON.stringify({
          MIT: [{ name: 'unrelated-npm-fixture', versions: ['1.0.0'], paths: [] }],
        });
      }
      assert.equal(command, 'cargo');
      throw new Error('Unrelated Rust payload is absent in this focused notice fixture');
    };
    return operation(() =>
      generateThirdPartyNotices({
        repoRoot: root,
        appVersion: '0.9.20',
        run,
        require: { python: false, rust: false },
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packageRows(output) {
  const start = output.indexOf('## Packages in the Windows Git bundle (65)');
  assert.ok(start >= 0, 'All65 actual packages must be listed');
  const section = output.slice(start, output.indexOf('## Bundled data', start));
  return section
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Package ') && !line.startsWith('| ---')
    )
    .map((line) => {
      const [, name, version, license, links] = line.split('|').map((cell) => cell.trim());
      return { name, version, license, links };
    });
}
function packageSource(output, pkg) {
  const prefix = `- ${pkg.name} ${pkg.version} (${pkg.license}), package in the Windows Git bundle: `;
  const line = output
    .slice(0, output.indexOf('## Programs, code and data'))
    .split('\n')
    .find((line) => line.startsWith(prefix));
  assert.ok(line, `${pkg.name} needs its complete copyleft source notice`);
  return line.slice(prefix.length);
}

test('UCRT fixture is exact pinned Dugite3.3.2 Windows archive metadata, including duplicates', () => {
  assert.equal(
    createHash('sha256').update(packageVersions).digest('hex'),
    'f4e00a9348e84414ade6f4e82cd72f0fca97f04b672a7ea803b5c74e32a37f0f'
  );
  assert.equal(packageVersions.toString('utf8').trim().split(/\r?\n/u).length, 67);
  assert.equal(expectedRows.length, 65);
  assert.equal(
    expectedRows.filter(([name]) => name.startsWith('mingw-w64-ucrt-x86_64-')).length,
    37
  );
  const pinned = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules/dugite/script/embedded-git.json'), 'utf8')
  )['win32-x64'];
  assert.equal(pinned.checksum, archiveSha256);
});

test('actual UCRT package inventory retains every exact name/version and complete license texts', () =>
  fixture((load) => {
    const output = load();
    const packages = packageRows(output);
    assert.equal(packages.length, 65);
    assert.deepEqual(
      new Set(packages.map(({ name, version }) => `${name} ${version}`)),
      new Set(expectedRows.map((row) => row.join(' ')))
    );
    for (const pkg of packages) {
      assert.equal(typeof pkg.license, 'string', pkg.name);
      assert.ok(pkg.license.trim().length > 0, pkg.name);
      const links = [...pkg.links.matchAll(/\[([^\]]+)\]\(#(text-\d+)\)/gu)];
      assert.ok(links.length > 0, `${pkg.name} needs actual license text links`);
      for (const [, , anchor] of links)
        assert.ok(output.includes(`### ${anchor}\n`), `${pkg.name} missing full text ${anchor}`);
      if (isCopyleftLicense(pkg.license)) {
        const source = packageSource(output, pkg);
        assert.match(source, /^https:\/\//u);
        assert.doesNotMatch(source, /\{[^}]+\}/u);
      }
      if (links.every(([, label]) => label.startsWith('standard '))) {
        for (const identifier of spdxIdentifiers(pkg.license))
          assert.ok(
            links.some(([, label]) => label === `standard ${identifier} text`),
            `${pkg.name} missing ${identifier}`
          );
      }
    }
  }));

test('UCRT split GCC and docx2txt notices preserve evidenced licenses and exact source identities', () =>
  fixture((load) => {
    const output = load();
    const packages = packageRows(output);
    const find = (suffix) => {
      const pkg = packages.find((entry) => entry.name === `mingw-w64-ucrt-x86_64-${suffix}`);
      assert.ok(pkg, suffix);
      return pkg;
    };
    const gccSource = 'https://repo.msys2.org/mingw/sources/mingw-w64-gcc-16.2.0-6.src.tar.zst';
    for (const name of ['cc-libs', 'gcc-libs', 'libatomic', 'libgcc', 'libgomp', 'libstdc++']) {
      const pkg = find(name);
      assert.match(pkg.license, /GPL-3\.0-or-later/u);
      assert.match(pkg.license, /GCC-exception-3\.1/u);
      assert.equal(packageSource(output, pkg), gccSource);
    }
    const quadmath = find('libquadmath');
    assert.match(quadmath.license, /LGPL-2\.1-or-later/u);
    assert.equal(packageSource(output, quadmath), gccSource);
    const docx = find('docx2txt-rs');
    assert.equal(docx.license, 'GPL-3.0-or-later');
    assert.ok(
      [
        'https://repo.msys2.org/mingw/sources/mingw-w64-docx2txt-rs-0.2.0-1.src.tar.zst',
        'https://github.com/dscho/docx2txt-rs/archive/v0.2.0/docx2txt-rs-0.2.0.tar.gz',
        'https://github.com/dscho/docx2txt-rs/archive/refs/tags/v0.2.0.tar.gz',
      ].includes(packageSource(output, docx))
    );
    for (const name of [
      'git',
      'git-credential-wincred',
      'git-for-windows-addons',
      'git-gui',
      'git-perl',
      'git-send-email',
      'git-subtree',
      'gitk',
    ])
      assert.equal(
        packageSource(output, find(name)),
        'https://github.com/git-for-windows/git/archive/refs/tags/v2.56.0.windows.4.tar.gz'
      );
    assert.equal(
      packageSource(output, find('git-extra')),
      'https://github.com/git-for-windows/build-extra/tree/85f886165/git-extra'
    );
    assert.match(output, /## Packages in the Windows Git bundle \(65\)/u);
  }));

test('unknown UCRT packages still refuse instead of inheriting an invented license or source', () =>
  fixture((load) => {
    assert.throws(
      load,
      /mingitPackages has no license or source for .*mingw-w64-ucrt-x86_64-unreviewed-license-fixture/u
    );
  }, 'mingw-w64-ucrt-x86_64-unreviewed-license-fixture 1.0-1\n'));
