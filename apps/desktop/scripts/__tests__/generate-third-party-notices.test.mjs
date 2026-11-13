import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import coverage from '../third-party-coverage.cjs';
import {
  applyLicenseOverride,
  buildNotices,
  collectPackages,
  commandOptions,
  indexInstalledPackages,
  isCopyleftLicense,
  npmPackages,
  licenseFilesIn,
  manifestComponents,
  mingitPackageVersionsFile,
  mingitPackages,
  noticesAppVersion,
  packageSource,
  parsePnpmLicenses,
  pythonPackages,
  readManifest,
  shippedPayloads,
  shippedRustPackages,
  sidecarInventories,
  sidecarPythonRuntime,
  spdxIdentifiers,
  standardLicenseTexts,
} from '../generate-third-party-notices.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const INSTALLED_0_9_15_ENTRIES = [
  'binaries/blastn',
  'binaries/cmscan',
  'binaries/codex-app-server',
  'binaries/diamond',
  'binaries/mafft',
  'binaries/mafft-mac',
  'binaries/makeblastdb',
  'binaries/opendataloader-pdf',
  'binaries/sequence-wheel-arm64.node',
  'binaries/waypoint-api-aarch64-apple-darwin',
  'Helpers/dna-coverage-aarch64-apple-darwin',
  'Helpers/dna-indexer-aarch64-apple-darwin',
  'Helpers/dnaforge-file-association',
  'Helpers/dnaforge-update-status',
];

const INSTALLED_0_9_13_WINDOWS_ENTRIES = [
  'binaries/blastn.exe',
  'binaries/blastn.exe.manifest',
  'binaries/cmpress.exe',
  'binaries/cmscan-build-metadata.json',
  'binaries/cmscan-SHA256SUMS.txt',
  'binaries/cmscan.exe',
  'binaries/codex-app-server',
  'binaries/diamond.exe',
  'binaries/EASEL-LICENSE.txt',
  'binaries/HMMER-LICENSE.txt',
  'binaries/INFERNAL-LICENSE.txt',
  'binaries/libgcc_s_seh-1.dll',
  'binaries/libwinpthread-1.dll',
  'binaries/mafft-win',
  'binaries/mafft.bat',
  'binaries/makeblastdb.exe',
  'binaries/makeblastdb.exe.manifest',
  'binaries/ncbi-vdb-md.dll',
  'binaries/nghttp2.dll',
  'binaries/opendataloader-pdf',
  'binaries/waypoint-api-x86_64-pc-windows-msvc',
  'Helpers/dna-indexer-x86_64-pc-windows-msvc.exe',
  'Helpers/dna-process-guardian-x86_64-pc-windows-msvc.exe',
];

const MINGIT_2_53_0_3_PACKAGES = [
  'bash',
  'coreutils',
  'dash',
  'diffutils',
  'file',
  'filesystem',
  'findutils',
  'gawk',
  'gcc-libs',
  'gmp',
  'grep',
  'heimdal-libs',
  'libbz2',
  'libcbor',
  'libfido2',
  'libiconv',
  'libintl',
  'liblzma',
  'libopenssl',
  'libpcre',
  'libreadline',
  'libsasl',
  'libsqlite',
  'libutil-linux',
  'libxcrypt',
  'libzstd',
  'mingw-w64-x86_64-brotli',
  'mingw-w64-x86_64-ca-certificates',
  'mingw-w64-x86_64-curl-openssl-alternate',
  'mingw-w64-x86_64-curl-winssl',
  'mingw-w64-x86_64-expat',
  'mingw-w64-x86_64-gcc-libs',
  'mingw-w64-x86_64-gettext-runtime',
  'mingw-w64-x86_64-git',
  'mingw-w64-x86_64-git-credential-manager',
  'mingw-w64-x86_64-git-credential-wincred',
  'mingw-w64-x86_64-git-extra',
  'mingw-w64-x86_64-git-for-windows-addons',
  'mingw-w64-x86_64-git-gui',
  'mingw-w64-x86_64-git-perl',
  'mingw-w64-x86_64-git-send-email',
  'mingw-w64-x86_64-git-subtree',
  'mingw-w64-x86_64-gitk',
  'mingw-w64-x86_64-libffi',
  'mingw-w64-x86_64-libiconv',
  'mingw-w64-x86_64-libidn2',
  'mingw-w64-x86_64-libpsl',
  'mingw-w64-x86_64-libssh2-wincng',
  'mingw-w64-x86_64-libtasn1',
  'mingw-w64-x86_64-libunistring',
  'mingw-w64-x86_64-libwinpthread',
  'mingw-w64-x86_64-nghttp2',
  'mingw-w64-x86_64-openssl',
  'mingw-w64-x86_64-pcre2',
  'mingw-w64-x86_64-zlib',
  'mingw-w64-x86_64-zstd',
  'mpfr',
  'msys2-runtime',
  'ncurses',
  'openssh',
  'openssl',
  'rebase',
  'sed',
  'zlib',
];

const GCC_RUNTIME_COMPONENT = {
  id: 'gcc-runtime',
  kind: 'library',
  name: 'GCC runtime',
  version: 'windows-runtime:libgcc_s_seh-1.dll',
  license: 'GPL-3.0-or-later WITH GCC-exception-3.1',
  licenseFiles: [],
  source: 'https://repo.msys2.org/mingw/sources/{base}-{version}.src.tar.zst',
  ships: ['binaries/libgcc_s_seh-1.dll'],
};

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'third-party-notices-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the checked-in manifest is valid and covers every program in the 0.9.15 macOS bundle', () => {
  const manifest = readManifest(repoRoot);
  assert.deepEqual(coverage.uncoveredShippedEntries(manifest, INSTALLED_0_9_15_ENTRIES), []);
  assert.deepEqual(
    coverage.uncoveredShippedEntries(manifest, ['binaries/unlisted-tool', 'Helpers/new-helper']),
    ['binaries/unlisted-tool', 'Helpers/new-helper']
  );
});

test('the checked-in manifest covers every file seen in the 0.9.13 Windows bundle', () => {
  const manifest = readManifest(repoRoot);
  assert.deepEqual(
    coverage.uncoveredShippedEntries(manifest, [
      ...INSTALLED_0_9_13_WINDOWS_ENTRIES,
      'binaries/blast-dll-versions.json',
    ]),
    []
  );
  assert.deepEqual(coverage.uncoveredShippedEntries(manifest, ['binaries/libstdc++-6.dll']), [
    'binaries/libstdc++-6.dll',
  ]);
});

test('every copyleft component links its exact source, DNAForge code at the public release tag', () => {
  const manifest = readManifest(repoRoot);
  const withoutSource = manifest.components
    .filter((component) => component.copyleft && !component.source)
    .map((component) => component.id);
  assert.deepEqual(withoutSource, []);
  const components = manifestComponents(manifest, { repoRoot, appVersion: '1.2.3' });
  const source = (id) => components.find((component) => component.id === id).source;
  assert.equal(
    source('dnaforge-sidecar'),
    'https://github.com/humic-labs/dnaforge-app/tree/v1.2.3/apps/api'
  );
  assert.equal(
    source('plannotate'),
    'https://github.com/humic-labs/dnaforge-app/tree/v1.2.3/packages/annotation'
  );
});

test('ship patterns match one path segment per wildcard', () => {
  assert.equal(coverage.shipPatternMatches('binaries/blastn*', 'binaries/blastn.exe'), true);
  assert.equal(
    coverage.shipPatternMatches('binaries/waypoint-api-*', 'binaries/waypoint-api-x'),
    true
  );
  assert.equal(coverage.shipPatternMatches('binaries/mafft', 'binaries/mafft-mac'), false);
  assert.equal(coverage.shipPatternMatches('binaries/*', 'binaries/nested/file'), false);
  assert.equal(coverage.shipPatternMatches('binaries/a.b', 'binaries/aXb'), false);
});

test('pnpm license groups become one sorted entry per installed version, without workspace packages', () => {
  const packages = parsePnpmLicenses({
    MIT: [
      {
        name: 'zeta',
        versions: ['2.0.0', '1.0.0'],
        paths: [
          '/repo/node_modules/.pnpm/zeta@1.0.0/node_modules/zeta',
          '/repo/node_modules/.pnpm/zeta@2.0.0/node_modules/zeta',
        ],
        homepage: 'https://zeta.example',
      },
      { name: '@waypoint/core', versions: ['0.0.0'], paths: ['/repo/packages/core'] },
    ],
    'Apache-2.0': [{ name: 'alpha', versions: ['3.1.0'], paths: ['/repo/node_modules/alpha'] }],
  });
  assert.deepEqual(
    packages.map(({ name, version, license, directory }) => [name, version, license, directory]),
    [
      ['alpha', '3.1.0', 'Apache-2.0', '/repo/node_modules/alpha'],
      ['zeta', '1.0.0', 'MIT', '/repo/node_modules/.pnpm/zeta@1.0.0/node_modules/zeta'],
      ['zeta', '2.0.0', 'MIT', '/repo/node_modules/.pnpm/zeta@2.0.0/node_modules/zeta'],
    ]
  );
});

test('pnpm license paths from a Windows build keep each installed version and its directory', () => {
  const zeta = (version) =>
    `D:\\repo\\node_modules\\.pnpm\\@scope+zeta@${version}\\node_modules\\@scope\\zeta`;
  const packages = parsePnpmLicenses({
    MIT: [
      { name: '@scope/zeta', versions: ['2.0.0', '1.0.0'], paths: [zeta('1.0.0'), zeta('2.0.0')] },
      { name: 'local', versions: ['0.1.0'], paths: ['D:\\repo\\packages\\local'] },
    ],
  });
  assert.deepEqual(
    packages.map(({ name, version, directory }) => [name, version, directory]),
    [
      ['@scope/zeta', '1.0.0', zeta('1.0.0')],
      ['@scope/zeta', '2.0.0', zeta('2.0.0')],
    ]
  );
});

test('pnpm starts through the command shell on Windows, and other commands start directly', () => {
  assert.equal(commandOptions('pnpm', 'D:\\repo', 'win32').shell, true);
  assert.equal(commandOptions('cargo', 'D:\\repo', 'win32').shell, false);
  assert.equal(commandOptions('pnpm', '/repo', 'darwin').shell, false);
  assert.equal(commandOptions('pnpm', '/repo', 'darwin').cwd, '/repo');
});

test('npm packages come from the desktop package alone, not the whole workspace', () =>
  withTemporaryDirectory((root) => {
    const calls = [];
    const run = (command, args, cwd) => {
      calls.push([command, args, cwd]);
      return JSON.stringify({ MIT: [{ name: 'left', versions: ['1.0.0'], paths: [] }] });
    };
    const packages = npmPackages({ repoRoot: root, run });
    assert.deepEqual(calls, [
      ['pnpm', ['--filter', '@waypoint/desktop', 'licenses', 'list', '--prod', '--json'], root],
    ]);
    assert.deepEqual(
      packages.map(({ name, version }) => [name, version]),
      [['left', '1.0.0']]
    );
  }));

test('installed package index finds hoisted, scoped and nested copies by exact version', () =>
  withTemporaryDirectory((root) => {
    const write = (relative, name, version) => {
      mkdirSync(path.join(root, relative), { recursive: true });
      writeFileSync(path.join(root, relative, 'package.json'), JSON.stringify({ name, version }));
    };
    write('node_modules/left', 'left', '1.0.0');
    write('node_modules/@scope/right', '@scope/right', '2.0.0');
    write('node_modules/left/node_modules/@scope/right', '@scope/right', '1.5.0');
    const index = indexInstalledPackages([path.join(root, 'node_modules')]);
    assert.equal(index.get('left@1.0.0'), path.join(root, 'node_modules/left'));
    assert.equal(index.get('@scope/right@2.0.0'), path.join(root, 'node_modules/@scope/right'));
    assert.equal(
      index.get('@scope/right@1.5.0'),
      path.join(root, 'node_modules/left/node_modules/@scope/right')
    );
  }));

test('license files are found by name, sorted, and read with normalized line endings', () =>
  withTemporaryDirectory((root) => {
    writeFileSync(path.join(root, 'LICENSE-MIT'), 'MIT text\r\n\r\n\r\n\r\nend  \r\n');
    writeFileSync(path.join(root, 'NOTICE'), 'notice');
    writeFileSync(path.join(root, 'README.md'), 'readme');
    mkdirSync(path.join(root, 'LICENSES'));
    assert.deepEqual(licenseFilesIn(root), [
      { file: 'LICENSE-MIT', text: 'MIT text\n\nend' },
      { file: 'NOTICE', text: 'notice' },
    ]);
  }));

function writeInventory(root, target, python, packages) {
  const directory = path.join(root, 'apps/desktop/resources/binaries', `waypoint-api-${target}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'python-licenses.json'),
    JSON.stringify({ schema: 'dnaforge.sidecar-python-licenses.v1', target, python, packages })
  );
}

test('each sidecar build supplies its Python packages and interpreter versions', () =>
  withTemporaryDirectory((root) => {
    const libraries = { OpenSSL: '3.0.16', SQLite: '3.49.1' };
    writeInventory(root, 'aarch64-apple-darwin', { version: '3.12.11', libraries }, [
      {
        name: 'zeta',
        version: '1.0',
        license: 'BSD',
        homepage: null,
        licenses: [{ file: 'LICENSE', text: 'Zeta\r\nlicense  \r\n' }],
      },
      { name: 'alpha', version: '2.0', license: 'MIT', homepage: null, licenses: [] },
    ]);
    writeInventory(root, 'x86_64-apple-darwin', { version: '3.12.10', libraries }, [
      { name: 'zeta', version: '1.0', license: 'BSD', homepage: null, licenses: [] },
    ]);
    assert.deepEqual(shippedPayloads(root), { python: true, rust: false });
    const inventories = sidecarInventories(root);
    const packages = pythonPackages(inventories, repoRoot);
    assert.deepEqual(
      packages.map(({ name, version, licenses }) => [name, version, licenses[0].file]),
      [
        ['alpha', '2.0', 'standard MIT text'],
        ['zeta', '1.0', 'LICENSE'],
      ]
    );
    assert.equal(packages[1].licenses[0].text, 'Zeta\nlicense');
    assert.deepEqual(sidecarPythonRuntime(inventories), {
      version: '3.12.11 / 3.12.10',
      includes: 'OpenSSL 3.0.16, SQLite 3.49.1',
    });
    assert.equal(sidecarPythonRuntime([]), null);
  }));

test('a sidecar without a current license inventory cannot be packaged', () =>
  withTemporaryDirectory((root) => {
    mkdirSync(path.join(root, 'apps/desktop/resources/binaries/waypoint-api-old'), {
      recursive: true,
    });
    assert.throws(
      () => sidecarInventories(root),
      /waypoint-api-old has no python-licenses\.json; rebuild it with apps\/api\/scripts\/build-sidecar\.sh/
    );
    writeInventory(root, 'old', { version: '3.12.11', libraries: {} }, []);
    writeFileSync(
      path.join(root, 'apps/desktop/resources/binaries/waypoint-api-old/python-licenses.json'),
      JSON.stringify({ schema: 'dnaforge.sidecar-python-licenses.v0', packages: [] })
    );
    assert.throws(
      () => sidecarInventories(root),
      /waypoint-api-old\/python-licenses\.json has an unknown format/
    );
    assert.deepEqual(sidecarInventories(path.join(root, 'missing')), []);
  }));

test('the notices take the app version from the build identity, never the package template', () =>
  withTemporaryDirectory((root) => {
    const template = JSON.parse(
      readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8')
    ).version;
    mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps/desktop/package.json'),
      JSON.stringify({ name: '@waypoint/desktop', version: template })
    );
    const mainOutDir = path.join(root, 'apps/desktop/out/main');
    assert.throws(
      () => noticesAppVersion({ mainOutDir }),
      /app-build-identity\.json is missing; build the desktop app before generating its notices/
    );
    mkdirSync(mainOutDir, { recursive: true });
    const version = '0.9.16+local.63.g9db89a8cfc66';
    writeFileSync(
      path.join(mainOutDir, 'app-build-identity.json'),
      JSON.stringify({ kind: 'local', version, sourceCommit: 'f'.repeat(40) })
    );
    assert.equal(noticesAppVersion({ mainOutDir }), version);
    assert.equal(noticesAppVersion({ appVersion: '0.9.17', mainOutDir }), '0.9.17');
    assert.throws(() => noticesAppVersion({ appVersion: '', mainOutDir }), /app build version/);

    const manifest = readManifest(repoRoot);
    const notices = buildNotices({
      appVersion: version,
      manifest,
      components: manifestComponents(manifest, { repoRoot, appVersion: version }),
      npm: [],
      python: null,
      rust: null,
      data: { sampleData: [], tracks: [] },
    });
    const dnaforgeLines = notices.split('\n').filter((line) => line.includes('DNAForge'));
    assert.ok(notices.startsWith(`${coverage.NOTICES_HEADING}${version}\n`));
    assert.ok(
      dnaforgeLines.some((line) => line.includes(`DNAForge sidecar (waypoint-api) ${version} `))
    );
    assert.deepEqual(
      dnaforgeLines.filter(
        (line) => line.includes(` ${template} `) || line.endsWith(` ${template}`)
      ),
      []
    );
  }));

test('the Python runtime entry takes its version from the sidecar and its texts from upstream', () => {
  const manifest = readManifest(repoRoot);
  const runtime = (pythonRuntime) =>
    manifestComponents(manifest, { repoRoot, appVersion: '1.0.0', pythonRuntime }).find(
      (component) => component.id === 'python-runtime'
    );
  const shipped = runtime({ version: '3.12.11', includes: 'OpenSSL 3.0.16' });
  assert.equal(shipped.version, '3.12.11');
  assert.equal(shipped.includes, 'OpenSSL 3.0.16');
  assert.match(shipped.licenses[0].text, /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/);
  assert.match(shipped.licenses[0].text, /^libmpdec$/m);
  assert.match(shipped.licenses[1].text, /copyright \(C\) 1996-2019 Julian R Seward/);
  assert.equal(runtime(null).version, null);
});

test('a Windows runtime library takes its version and exact MSYS2 source from the tools build', () =>
  withTemporaryDirectory((root) => {
    const binaries = path.join(root, 'apps/desktop/resources/binaries');
    mkdirSync(binaries, { recursive: true });
    writeFileSync(path.join(binaries, 'libgcc_s_seh-1.dll'), '');
    writeFileSync(
      path.join(binaries, 'cmscan-build-metadata.json'),
      JSON.stringify({
        runtimeLibraries: [
          {
            file: 'libgcc_s_seh-1.dll',
            package: 'mingw-w64-x86_64-gcc-libs',
            version: '15.2.0-8',
            base: 'mingw-w64-gcc',
          },
        ],
      })
    );
    const [component] = manifestComponents(
      { components: [GCC_RUNTIME_COMPONENT] },
      { repoRoot: root, appVersion: '1.0.0' }
    );
    assert.equal(component.version, '15.2.0-8');
    assert.equal(
      component.source,
      'https://repo.msys2.org/mingw/sources/mingw-w64-gcc-15.2.0-8.src.tar.zst'
    );
  }));

test('a BLAST+ library takes its version from the Windows tools record, even with a byte-order mark', () =>
  withTemporaryDirectory((root) => {
    const binaries = path.join(root, 'apps/desktop/resources/binaries');
    mkdirSync(binaries, { recursive: true });
    writeFileSync(path.join(binaries, 'ncbi-vdb-md.dll'), '');
    writeFileSync(
      path.join(binaries, 'blast-dll-versions.json'),
      `\uFEFF${JSON.stringify({
        dlls: [
          {
            file: 'ncbi-vdb-md.dll',
            productName: 'NCBI VDB',
            productVersion: '3.1.1',
            fileVersion: '3.1.1.0',
          },
        ],
      })}`
    );
    const [component] = manifestComponents(
      {
        components: [
          {
            id: 'ncbi-vdb',
            kind: 'library',
            name: 'NCBI VDB',
            version: 'windows-runtime:ncbi-vdb-md.dll',
            license: 'LGPL-2.1-or-later',
            licenseFiles: [],
            source: 'https://github.com/ncbi/ncbi-vdb/archive/refs/tags/{version}.tar.gz',
            ships: ['binaries/ncbi-vdb-md.dll'],
          },
        ],
      },
      { repoRoot: root, appVersion: '1.0.0' }
    );
    assert.equal(component.version, '3.1.1');
    assert.equal(
      component.source,
      'https://github.com/ncbi/ncbi-vdb/archive/refs/tags/3.1.1.tar.gz'
    );
  }));

test('a Windows runtime library is absent from other builds and cannot ship unrecorded', () =>
  withTemporaryDirectory((root) => {
    const manifest = { components: [GCC_RUNTIME_COMPONENT] };
    const [absent] = manifestComponents(manifest, { repoRoot: root, appVersion: '1.0.0' });
    assert.equal(absent.version, null);
    assert.equal(absent.source, null);
    const binaries = path.join(root, 'apps/desktop/resources/binaries');
    mkdirSync(binaries, { recursive: true });
    writeFileSync(path.join(binaries, 'libgcc_s_seh-1.dll'), '');
    assert.throws(
      () => manifestComponents(manifest, { repoRoot: root, appVersion: '1.0.0' }),
      /libgcc_s_seh-1\.dll ships without a recorded version/
    );
  }));

test('copyleft packages are recognized from SPDX and free-text labels', () => {
  for (const license of [
    'GPLv2',
    'LGPL-3.0-or-later',
    'GNU Affero General Public License v3',
    'MPL-2.0',
    '(MPL-2.0 OR Apache-2.0)',
    'EPL-2.0',
  ]) {
    assert.equal(isCopyleftLicense(license), true, license);
  }
  for (const license of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'Unknown', undefined]) {
    assert.equal(isCopyleftLicense(license), false, String(license));
  }
});

test('package sources point at the exact version, with manifest patterns taking precedence', () => {
  const sources = {
    'npm:@img/sharp-libvips-*': 'https://example.com/sharp-libvips/v{version}.tar.gz',
  };
  const pkg = (name) => ({ name, version: '1.2.4' });
  assert.equal(
    packageSource('npm', pkg('@img/sharp-libvips-darwin-arm64'), sources),
    'https://example.com/sharp-libvips/v1.2.4.tar.gz'
  );
  assert.equal(
    packageSource('npm', pkg('@scope/lib'), sources),
    'https://registry.npmjs.org/@scope/lib/-/lib-1.2.4.tgz'
  );
  assert.equal(packageSource('python', pkg('certifi')), 'https://pypi.org/project/certifi/1.2.4/');
  assert.equal(
    packageSource('rust', pkg('serde')),
    'https://crates.io/api/v1/crates/serde/1.2.4/download'
  );
  const overrides = { 'npm:@vendor/sdk*': { license: 'LicenseRef-Vendor', evidence: 'terms' } };
  assert.equal(
    applyLicenseOverride({ name: '@vendor/sdk-darwin-arm64' }, 'npm', overrides).license,
    'LicenseRef-Vendor'
  );
  assert.equal(applyLicenseOverride({ name: '@vendor/sdk' }, 'npm', overrides).evidence, 'terms');
  assert.deepEqual(applyLicenseOverride({ name: '@vendor/other' }, 'npm', overrides), {
    name: '@vendor/other',
  });
});

test('SPDX expressions yield their identifiers and the matching standard texts', () => {
  assert.deepEqual(spdxIdentifiers('(MPL-2.0 OR Apache-2.0)'), ['MPL-2.0', 'Apache-2.0']);
  assert.deepEqual(spdxIdentifiers('MIT/Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(spdxIdentifiers('GPL-2.0-only WITH Classpath-exception-2.0'), [
    'GPL-2.0-only',
    'Classpath-exception-2.0',
  ]);
  const texts = standardLicenseTexts('MIT AND LicenseRef-Unknown', repoRoot);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].file, 'standard MIT text');
  assert.match(texts[0].text, /Permission is hereby granted/);
});

test('shipped Rust crates follow normal dependencies only and exclude the workspace', () => {
  const pkg = (name, workspace = false) => ({
    id: `${name}-id`,
    name,
    version: '1.0.0',
    license: 'MIT',
    manifest_path: `/${workspace ? 'repo' : 'registry'}/${name}/Cargo.toml`,
  });
  const metadata = {
    packages: [
      pkg('helper', true),
      pkg('runtime'),
      pkg('nested'),
      pkg('test-only'),
      pkg('build-only'),
    ],
    workspace_members: ['helper-id'],
    resolve: {
      nodes: [
        {
          id: 'helper-id',
          deps: [
            { pkg: 'runtime-id', dep_kinds: [{ kind: null }] },
            { pkg: 'test-only-id', dep_kinds: [{ kind: 'dev' }] },
            { pkg: 'build-only-id', dep_kinds: [{ kind: 'build' }] },
          ],
        },
        { id: 'runtime-id', deps: [{ pkg: 'nested-id', dep_kinds: [{ kind: null }] }] },
      ],
    },
  };
  assert.deepEqual(
    shippedRustPackages(metadata, ['helper']).map(({ name }) => name),
    ['nested', 'runtime']
  );
  assert.throws(() => shippedRustPackages(metadata, ['missing']), /no shipped crate named missing/);
});

test('a required package source fails loudly, and an optional one is marked absent', () => {
  assert.throws(
    () => collectPackages('Python packages', true, () => []),
    /Python packages: no packages found/
  );
  assert.throws(
    () =>
      collectPackages('Rust crates', true, () => {
        throw new Error('offline');
      }),
    /Rust crates: offline/
  );
  assert.equal(
    collectPackages('Rust crates', false, () => {
      throw new Error('offline');
    }),
    null
  );
  assert.equal(
    collectPackages('Python packages', false, () => []),
    null
  );
});

test('required package commands retain captured failure output', () => {
  const error = Object.assign(new Error('command failed'), {
    stdout: Buffer.from('ERR_PNPM_LICENSE_INPUT: dependency inventory is incomplete'),
    stderr: Buffer.from('The package manager could not inspect the installed graph'),
  });
  assert.throws(
    () =>
      collectPackages('npm packages', true, () => {
        throw error;
      }),
    (failure) => {
      assert.match(failure.message, /npm packages: command failed/);
      assert.match(failure.message, /ERR_PNPM_LICENSE_INPUT/);
      assert.match(failure.message, /could not inspect the installed graph/);
      return true;
    }
  );
});

test('package command diagnostics stay bounded', () => {
  const error = Object.assign(new Error('command failed'), {
    stdout: Buffer.from('x'.repeat(20_000) + 'overflow-tail'),
  });
  assert.throws(
    () =>
      collectPackages('npm packages', true, () => {
        throw error;
      }),
    (failure) => {
      assert.ok(failure.message.length < 9_000);
      assert.ok(!failure.message.includes('overflow-tail'));
      assert.ok(failure.message.includes('xxxx'));
      return true;
    }
  );
});

test('notices dedupe license texts, fence backticks safely and keep the section headings', () => {
  const shared = { file: 'LICENSE', text: 'Shared ```fenced``` text' };
  const notices = buildNotices({
    appVersion: '1.2.3',
    manifest: { distributor: 'Example Co', sourceRequestContact: 'source@example.com' },
    components: [
      {
        name: 'Tool',
        version: '1.0',
        license: 'GPL-3.0-only',
        copyleft: true,
        source: 'https://example.com/tool-1.0.tar.gz',
        licenses: [shared],
      },
      {
        name: 'Own',
        version: '1.2.3',
        license: 'GPL-3.0-only',
        copyleft: true,
        licenses: [shared],
      },
      {
        name: 'Runtime',
        version: '3.12.11',
        license: 'PSF-2.0',
        includes: 'OpenSSL 3.0.16',
        licenses: [],
      },
      { name: 'Absent', version: null, license: 'PSF-2.0', licenses: [] },
    ],
    npm: [
      { name: 'lib', version: '1.0.0', license: 'MIT', licenses: [shared] },
      { name: '@scope/weak', version: '2.0.0', license: 'LGPL-3.0-or-later', licenses: [shared] },
    ],
    python: null,
    rust: [],
    data: { sampleData: [], tracks: [] },
  });
  assert.ok(notices.startsWith(`${coverage.NOTICES_HEADING}1.2.3\n`));
  assert.equal(notices.match(/^### text-\d+$/gm).length, 1);
  assert.match(notices, /^````text\nShared ```fenced``` text\n````$/m);
  assert.match(
    notices,
    /- Tool 1\.0 \(GPL-3\.0-only\): https:\/\/example\.com\/tool-1\.0\.tar\.gz/
  );
  assert.match(notices, /- Own 1\.2\.3 \(GPL-3\.0-only\): source available on request/);
  assert.match(notices, /Write to source@example\.com\./);
  const sourceSection = notices.slice(0, notices.indexOf('## Programs, code and data'));
  assert.match(
    sourceSection,
    /- @scope\/weak 2\.0\.0 \(LGPL-3\.0-or-later\), npm package: https:\/\/registry\.npmjs\.org\/@scope\/weak\/-\/weak-2\.0\.0\.tgz/
  );
  assert.doesNotMatch(sourceSection, /- lib 1\.0\.0/);
  assert.match(
    notices,
    /### Runtime 3\.12\.11\n\n- License: PSF-2\.0\n- Includes: OpenSSL 3\.0\.16\n/
  );
  assert.match(notices, /### Absent\n\n- Not part of this build\.\n- License: PSF-2\.0\n/);
  assert.match(
    notices,
    /## Python packages in the DNAForge sidecar \(not part of this build\)\n\nNot part of this build\./
  );
  assert.deepEqual(
    coverage
      .noticesProblems({
        resourcesDir: withTemporaryDirectory((root) => root),
        appVersion: '1.2.3',
      })
      .slice(0, 1),
    ['THIRD_PARTY_NOTICES.md is missing from Resources']
  );
});

const MINGIT_FIXTURE = {
  sed: {
    license: 'GPL-3.0-or-later',
    source: 'https://repo.msys2.org/msys/sources/sed-{version}.src.tar.zst',
  },
  'mingw-w64-x86_64-git': {
    license: 'GPL-2.0-only',
    source: 'https://github.com/git-for-windows/git/archive/refs/tags/{windowsTag}.tar.gz',
  },
  'mingw-w64-x86_64-git-extra': {
    license: 'GPL-2.0-or-later',
    source: 'https://github.com/git-for-windows/build-extra/archive/{commit}.tar.gz',
  },
  'mingw-w64-x86_64-zlib': {
    license: 'Zlib',
    source: 'https://repo.msys2.org/mingw/sources/mingw-w64-zlib-{version}.src.tar.zst',
  },
};

test('the checked-in MinGit table covers MinGit 2.53.0.3, with a standard text for every license', () => {
  const { mingitPackages: table } = readManifest(repoRoot);
  assert.deepEqual(
    Object.keys(table).filter((name) => !MINGIT_2_53_0_3_PACKAGES.includes(name)),
    []
  );
  assert.deepEqual(
    MINGIT_2_53_0_3_PACKAGES.filter((name) => !table[name]),
    []
  );
  for (const [name, { license, source, licenseFiles }] of Object.entries(table)) {
    const missing = licenseFiles
      ? licenseFiles.filter((relative) => !existsSync(path.join(repoRoot, relative)))
      : spdxIdentifiers(license).filter(
          (identifier) => standardLicenseTexts(identifier, repoRoot).length === 0
        );
    assert.deepEqual(missing, [], `${name} (${license}) has no license text`);
    if (isCopyleftLicense(license)) assert.match(source, /^https:\/\//, `${name} needs its source`);
  }
});

test('the MinGit package list is read from the dugite that the desktop app resolves', () => {
  assert.equal(
    mingitPackageVersionsFile(repoRoot),
    path.join(repoRoot, 'node_modules/dugite/git/etc/package-versions.txt')
  );
  withTemporaryDirectory((root) => assert.equal(mingitPackageVersionsFile(root), null));
});

test('MinGit packages come from the bundle list with their licenses and exact sources', () =>
  withTemporaryDirectory((root) => {
    const dugite = path.join(root, 'node_modules/dugite');
    mkdirSync(path.join(dugite, 'git/etc'), { recursive: true });
    writeFileSync(path.join(dugite, 'package.json'), '{"name":"dugite","version":"3.2.2"}');
    const file = mingitPackageVersionsFile(root);
    writeFileSync(
      file,
      'sed 4.9-1\r\nmingw-w64-x86_64-git 2.53.0.3-1\r\nsed 4.9-1\r\nmingw-w64-x86_64-git-extra 1.1.687.f502a63dc-1\r\n\r\n'
    );
    assert.deepEqual(
      mingitPackages({ repoRoot: root, known: MINGIT_FIXTURE }).map(({ name, version, source }) => [
        name,
        version,
        source,
      ]),
      [
        [
          'mingw-w64-x86_64-git',
          '2.53.0.3-1',
          'https://github.com/git-for-windows/git/archive/refs/tags/v2.53.0.windows.3.tar.gz',
        ],
        [
          'mingw-w64-x86_64-git-extra',
          '1.1.687.f502a63dc-1',
          'https://github.com/git-for-windows/build-extra/archive/f502a63dc.tar.gz',
        ],
        ['sed', '4.9-1', 'https://repo.msys2.org/msys/sources/sed-4.9-1.src.tar.zst'],
      ]
    );
    assert.throws(
      () => mingitPackages({ repoRoot: root, known: { sed: MINGIT_FIXTURE.sed } }),
      /mingitPackages has no license or source for mingw-w64-x86_64-git, mingw-w64-x86_64-git-extra/
    );
    rmSync(file);
    assert.equal(mingitPackages({ repoRoot: root, known: MINGIT_FIXTURE }), null);
  }));

test('notices list the Windows Git bundle, and its copyleft sources, only when it ships', () => {
  const build = (mingit) =>
    buildNotices({
      appVersion: '1.2.3',
      manifest: { distributor: 'Example Co', sourceRequestContact: 'source@example.com' },
      components: [],
      npm: [],
      python: null,
      rust: [],
      mingit,
      data: { sampleData: [], tracks: [] },
    });
  const windows = build([
    {
      name: 'mingw-w64-x86_64-zlib',
      version: '1.3.1-1',
      license: 'Zlib',
      source: 'https://repo.msys2.org/mingw/sources/mingw-w64-zlib-1.3.1-1.src.tar.zst',
      licenses: [],
    },
    {
      name: 'sed',
      version: '4.9-1',
      license: 'GPL-3.0-or-later',
      source: 'https://repo.msys2.org/msys/sources/sed-4.9-1.src.tar.zst',
      licenses: [],
    },
  ]);
  const sourceSection = windows.slice(0, windows.indexOf('## Programs, code and data'));
  assert.match(
    sourceSection,
    /- sed 4\.9-1 \(GPL-3\.0-or-later\), package in the Windows Git bundle: https:\/\/repo\.msys2\.org\/msys\/sources\/sed-4\.9-1\.src\.tar\.zst/
  );
  assert.doesNotMatch(sourceSection, /mingw-w64-x86_64-zlib/);
  assert.match(
    windows,
    /## Packages in the Windows Git bundle \(2\)\n\nOn Windows, DNAForge runs Git/
  );
  assert.match(windows, /\| sed \| 4\.9-1 \| GPL-3\.0-or-later \|/);
  assert.match(
    build(null),
    /## Packages in the Windows Git bundle \(not part of this build\)\n\nNot part of this build\./
  );
});

test('packaged notices are checked for version, sections and the Chromium licenses file', () =>
  withTemporaryDirectory((resourcesDir) => {
    writeFileSync(
      path.join(resourcesDir, coverage.NOTICES_FILE),
      `${coverage.NOTICES_HEADING}1.2.3\n\n## Source code for copyleft components\n## npm packages (1)\n## Python packages in the DNAForge sidecar (1)\n## Rust crates in DNAForge helpers (1)\n${coverage.WINDOWS_GIT_BUNDLE_HEADING}not part of this build)\n## License texts\n`
    );
    assert.deepEqual(coverage.noticesProblems({ resourcesDir, appVersion: '1.2.3' }), [
      'LICENSES.chromium.html is missing from Resources',
    ]);
    writeFileSync(path.join(resourcesDir, coverage.CHROMIUM_LICENSES_FILE), '<html></html>');
    assert.deepEqual(coverage.noticesProblems({ resourcesDir, appVersion: '1.2.3' }), []);
    assert.deepEqual(coverage.noticesProblems({ resourcesDir, appVersion: '9.9.9' }), [
      'THIRD_PARTY_NOTICES.md does not start with "# Third-party notices for DNAForge 9.9.9"',
    ]);
    assert.deepEqual(
      coverage.noticesProblems({ resourcesDir, appVersion: '1.2.3', windowsGitBundle: true }),
      ['THIRD_PARTY_NOTICES.md does not list the packages of the bundled Windows Git']
    );
  }));
