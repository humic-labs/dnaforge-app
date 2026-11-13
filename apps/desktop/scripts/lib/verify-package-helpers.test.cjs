'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { finished } = require('node:stream/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { createPackage } = require('@electron/asar');
const { RELEASE_POLICY, releaseBundleReport } = require('./release-bundle-boundary.mjs');

const {
  asarPackageInventoryPolicy,
  codexAppServerIntegrityProblem,
  helperExecutableName,
  helperPlatformSuffix,
  installedAppIdentityProblems,
  requiredAsarPackageProblems,
  verifyHostedGatewayAuthority,
  verifyHostedGatewayGraphAuthority,
  verifyMainJavaScriptGraph,
  verifyPackagedAuthAuthority,
  verifyQualificationEphemeralAuth,
  verifySourceCommitStamp,
  verifyUpdateFeedAuthority,
} = require('./verify-package-helpers.cjs');

const temporaryRoots = [];

describe('qualification ephemeral auth package authority', () => {
  const source = 'a'.repeat(40);
  const marker =
    `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${source}::` + 'QUALIFICATION_EPHEMERAL_AUTH_V1::END';

  it('requires one marker bound to the packaged source for live canaries', () => {
    assert.deepEqual(verifyQualificationEphemeralAuth(marker, source, 'required'), {
      ok: true,
      enabled: true,
      sourceCommit: source,
      message: 'qualification ephemeral auth matches packaged source commit',
    });
    assert.equal(verifyQualificationEphemeralAuth('', source, 'required').ok, false);
    assert.equal(verifyQualificationEphemeralAuth(marker, 'b'.repeat(40), 'required').ok, false);
    assert.equal(
      verifyQualificationEphemeralAuth(`${marker}${marker}`, source, 'required').ok,
      false
    );
  });

  it('requires ordinary packages to omit the qualification-only marker', () => {
    assert.deepEqual(verifyQualificationEphemeralAuth('', source, 'forbidden'), {
      ok: true,
      enabled: false,
      sourceCommit: null,
      message: 'package contains no qualification ephemeral auth authority',
    });
    assert.equal(verifyQualificationEphemeralAuth(marker, source, 'forbidden').ok, false);
    assert.equal(
      verifyQualificationEphemeralAuth(
        [
          "const prefix = 'DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=';",
          "const suffix = '::QUALIFICATION_EPHEMERAL_AUTH_V1::END';",
        ].join('\n'),
        source,
        'forbidden'
      ).ok,
      true
    );
  });
});

describe('split main-process authority stamps', () => {
  const source = 'a'.repeat(40);
  const sourceMarker = `DNAFORGE_SOURCE_COMMIT=${source}::SOURCE_COMMIT_PROVENANCE_V1::END`;
  const gateway = 'https://hosted-ai-gateway-staging.up.railway.app';
  const gatewayPrefix = 'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=';
  const gatewayMarker = `${gatewayPrefix}${gateway}::` + 'HOSTED_GATEWAY_AUTHORITY_V1::END';
  const authMarker =
    `DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=${gateway}::` + 'DESKTOP_AUTH_AUTHORITY_V1::END';

  it('rejects repeated Hosted authority while tolerating legacy repeated non-Hosted stamps', () => {
    const graph = [
      sourceMarker,
      gatewayMarker,
      authMarker,
      sourceMarker,
      gatewayMarker,
      authMarker,
    ].join('\n');

    assert.equal(verifySourceCommitStamp(graph, source).ok, true);
    assert.equal(verifyHostedGatewayAuthority(graph, gateway).ok, false);
    assert.equal(verifyPackagedAuthAuthority(graph, gateway).ok, true);
  });

  it('rejects conflicting authority values across main-process chunks', () => {
    const otherSource = 'b'.repeat(40);
    const otherGateway = 'https://other.invalid';
    const graph = [
      sourceMarker,
      `DNAFORGE_SOURCE_COMMIT=${otherSource}::SOURCE_COMMIT_PROVENANCE_V1::END`,
      gatewayMarker,
      `DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=${otherGateway}::HOSTED_GATEWAY_AUTHORITY_V1::END`,
      authMarker,
      `DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=${otherGateway}::DESKTOP_AUTH_AUTHORITY_V1::END`,
    ].join('\n');

    assert.equal(verifySourceCommitStamp(graph, source).ok, false);
    assert.equal(verifyHostedGatewayAuthority(graph, gateway).ok, false);
    assert.equal(verifyPackagedAuthAuthority(graph, gateway).ok, false);
  });

  it('allows repeated exact graph authority but rejects malformed or conflicting chunks', () => {
    assert.equal(
      verifyHostedGatewayGraphAuthority(`${gatewayMarker}\n${gatewayMarker}`, gateway).ok,
      true
    );
    assert.equal(
      verifyHostedGatewayGraphAuthority(
        `${gatewayMarker}\nDNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https://other.invalid::HOSTED_GATEWAY_AUTHORITY_V1::END`,
        gateway
      ).ok,
      false
    );
    assert.equal(
      verifyHostedGatewayGraphAuthority(
        `${gatewayMarker}\nDNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=http://other.invalid::HOSTED_GATEWAY_AUTHORITY_V1::END`,
        gateway
      ).ok,
      false
    );
    assert.equal(
      verifyHostedGatewayGraphAuthority(`${gatewayMarker}\n${gatewayPrefix}`, gateway).ok,
      false
    );
  });

  it('ignores only the executable validator regex and rejects marker-shaped data', () => {
    const parserSource = String.raw`const validator = /^DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https:\/\/[^/\s]+::HOSTED_GATEWAY_AUTHORITY_V1::END$/u;`;
    const parserAsData = String.raw`const validator = 'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https:\/\/[^/\s]+::HOSTED_GATEWAY_AUTHORITY_V1::END';`;
    const malformed =
      'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=http://other.invalid::' +
      'HOSTED_GATEWAY_AUTHORITY_V1::END';

    assert.equal(
      verifyHostedGatewayAuthority(`${gatewayMarker}\n${parserSource}`, gateway).ok,
      true
    );
    assert.equal(
      verifyHostedGatewayAuthority(`${gatewayMarker}\n${parserAsData}`, gateway).ok,
      false
    );
    assert.equal(verifyHostedGatewayAuthority(`${gatewayMarker}\n${malformed}`, gateway).ok, false);
  });
});

describe('reachable packaged main-process graph', () => {
  const file = (filePath, content) => ({ path: filePath, content });
  const verify = (files, packageMain = 'out/main/index.js') =>
    verifyMainJavaScriptGraph({ packageMain, files });

  it('follows static imports, re-exports, dynamic imports, and worker URL references', () => {
    const graph = verify([
      file('out/main/index.js', 'import "./chunks/static.js";'),
      file('out/main/chunks/static.js', 'export { value } from "./reexport.js";'),
      file('out/main/chunks/reexport.js', 'import("./dynamic.js"); export const value = 1;'),
      file('out/main/chunks/dynamic.js', 'new Worker$1(new URL("./worker.js", import.meta.url));'),
      file('out/main/chunks/worker.js', 'export const worker = true;'),
    ]);

    assert.deepEqual(graph.paths, [
      'out/main/chunks/dynamic.js',
      'out/main/chunks/reexport.js',
      'out/main/chunks/static.js',
      'out/main/chunks/worker.js',
      'out/main/index.js',
    ]);
    assert.match(graph.buffer.toString('utf8'), /worker = true/);
    assert.equal(graph.entryBuffer.toString('utf8'), 'import "./chunks/static.js";');
  });

  it('checks a fresh build directory, and fails on an orphan entry ', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-graph-'));
    try {
      fs.mkdirSync(path.join(root, 'out', 'main', 'chunks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'out/main/index.js'), 'import "./chunks/a.js";');
      fs.writeFileSync(path.join(root, 'out/main/chunks/a.js'), 'export const a = 1;');
      assert.equal(
        require('./verify-package-helpers.cjs').verifyBuiltMainGraph(root).paths.length,
        2
      );
      fs.writeFileSync(path.join(root, 'out/main/worker-entry-zz.js'), 'export const w = 1;');
      assert.throws(
        () => require('./verify-package-helpers.cjs').verifyBuiltMainGraph(root),
        /unreferenced main-process JavaScript: out\/main\/worker-entry-zz\.js/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows worker entries located with join(import.meta.dirname, ...) ', () => {
    const graph = verify([
      file('out/main/index.js', 'import "./chunks/factory.js";'),
      file(
        'out/main/chunks/factory.js',
        [
          'import { join } from "node:path";',
          'const workerPath = join(import.meta.dirname, "../worker-entry-ab12.js");',
          'const gitWorker = join(import.meta.dirname, "../../resources/git-read-worker.cjs");',
        ].join('\n')
      ),
      file('out/main/worker-entry-ab12.js', 'export const worker = true;'),
    ]);
    assert.ok(graph.paths.includes('out/main/worker-entry-ab12.js'));
  });

  it('still rejects a worker entry that nothing locates', () => {
    assert.throws(
      () =>
        verify([
          file('out/main/index.js', 'const unrelated = join(import.meta.dirname, "data.json");'),
          file('out/main/worker-entry-ab12.js', 'export const worker = true;'),
        ]),
      /unreferenced main-process JavaScript: out\/main\/worker-entry-ab12\.js/
    );
  });

  it('rejects authority stamps that exist only in an orphan chunk', () => {
    assert.throws(
      () =>
        verify([
          file('out/main/index.js', 'export const boot = true;'),
          file('out/main/orphan.js', 'DNAFORGE_SOURCE_COMMIT=' + 'a'.repeat(40)),
        ]),
      /unreferenced main-process JavaScript: out\/main\/orphan\.js/
    );
  });

  it('rejects conflicting authority hidden in an orphan chunk', () => {
    assert.throws(
      () =>
        verify([
          file('out/main/index.js', `const stamp = ${JSON.stringify('a'.repeat(40))};`),
          file('out/main/conflict.js', `const stamp = ${JSON.stringify('b'.repeat(40))};`),
        ]),
      /unreferenced main-process JavaScript: out\/main\/conflict\.js/
    );
  });

  it('rejects missing referenced chunks and references outside out/main', () => {
    assert.throws(
      () => verify([file('out/main/index.js', 'import("./missing.js");')]),
      /references missing main-process JavaScript: \.\/missing\.js/
    );
    assert.throws(
      () => verify([file('out/main/index.js', 'import("../../escape.js");')]),
      /references JavaScript outside out\/main/
    );
  });

  it('rejects missing, invalid, and nonexistent package main values', () => {
    const index = file('out/main/index.js', 'export {};');
    assert.throws(() => verify([index], null), /package\.json main must be exactly/);
    assert.throws(
      () => verify([index], 'out/main/product.js'),
      /package\.json main must be exactly/
    );
    assert.throws(
      () => verify([], 'out/main/index.js'),
      /package\.json main does not exist in the package/
    );
  });

  it('rejects non-literal dynamic imports and duplicate canonical paths', () => {
    assert.throws(
      () => verify([file('out/main/index.js', 'import(nextChunk);')]),
      /non-literal dynamic import/
    );
    assert.throws(
      () =>
        verify([
          file('out/main/index.js', 'export {};'),
          file('out/main/index.js', 'export const duplicate = true;'),
        ]),
      /duplicate main-process JavaScript path/
    );
  });

  it('rejects ambiguous inventory paths and noncanonical JavaScript references', () => {
    for (const invalidPath of [
      'out/main/chunks\\worker.js',
      'out/main/chunks/worker.js?query',
      'out/main/chunks/%77orker.js',
      'out/main/chunks/worker.js\0suffix',
    ]) {
      assert.throws(
        () => verify([file('out/main/index.js', 'export {};'), file(invalidPath, 'export {};')]),
        /invalid main-process JavaScript path/
      );
    }
    for (const invalidReference of [
      './chunk',
      './chunk.js?query',
      './%63hunk.js',
      '/absolute/chunk.js',
      'file:///tmp/chunk.js',
      'data:text/javascript,chunk.js',
      'https://example.invalid/chunk.js',
      'file:///tmp/chunk',
      'data:text/javascript,export{}',
      'https://example.invalid/chunk',
      'ftp://example.invalid/chunk',
      'blob:opaque-identifier',
      'C:/payload.js',
      'bare\\chunk',
      '.hidden.js',
      '.../payload.js',
    ]) {
      assert.throws(
        () => verify([file('out/main/index.js', `import(${JSON.stringify(invalidReference)});`)]),
        /invalid local JavaScript reference|forbidden non-relative JavaScript reference/
      );
    }
  });

  it('rejects malformed worker URL edges instead of treating them as external', () => {
    for (const expression of [
      'new URL("./missing.js", base);',
      'new URL("./missing.js", import.meta.url, extra);',
      'new globalThis.URL("./missing.js", import.meta.url);',
      'new URL("./missing", import.meta.url);',
      'new URL("./missing%2ejs", import.meta.url);',
      'new URL("./missing.mjs", import.meta.url);',
      'new URL("https://example.invalid/worker.js", import.meta.url);',
    ]) {
      assert.throws(
        () => verify([file('out/main/index.js', expression)]),
        /unsupported JavaScript URL reference|invalid local JavaScript reference|forbidden non-relative JavaScript reference/
      );
    }
  });

  it('rejects alternate JavaScript extensions in the shipped main inventory', () => {
    for (const alternate of ['out/main/orphan.mjs', 'out/main/orphan.cjs']) {
      assert.throws(
        () => verify([file('out/main/index.js', 'export {};'), file(alternate, 'export {};')]),
        /invalid main-process JavaScript path/
      );
    }
  });

  it('rejects symbolic links in the local main-process output tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-main-graph-link-'));
    temporaryRoots.push(root);
    const indexPath = path.join(root, 'index.js');
    fs.writeFileSync(indexPath, 'export {};');
    fs.symlinkSync(indexPath, path.join(root, 'orphan.js'));

    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '..', 'verify-package.cjs'), '--bundle-stamp-only', indexPath],
      { encoding: 'utf8' }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /main-process graph contains a symbolic link/);
  });

  it('accepts repeated reachable stamps and rejects conflicting reachable stamps', () => {
    const source = 'a'.repeat(40);
    const otherSource = 'b'.repeat(40);
    const marker = `DNAFORGE_SOURCE_COMMIT=${source}::SOURCE_COMMIT_PROVENANCE_V1::END`;
    const repeated = verify([
      file('out/main/index.js', `${JSON.stringify(marker)}; import("./product.js");`),
      file('out/main/product.js', JSON.stringify(marker)),
    ]);
    assert.equal(verifySourceCommitStamp(repeated.buffer, source).ok, true);

    const conflicting = verify([
      file('out/main/index.js', `${JSON.stringify(marker)}; import("./product.js");`),
      file(
        'out/main/product.js',
        JSON.stringify(`DNAFORGE_SOURCE_COMMIT=${otherSource}::SOURCE_COMMIT_PROVENANCE_V1::END`)
      ),
    ]);
    assert.equal(verifySourceCommitStamp(conflicting.buffer, source).ok, false);
  });
});

describe('packaged runtime JavaScript dependency closure', () => {
  it('declares the exact boot-critical runtime dependency in the desktop package', () => {
    const desktopPackage = require('../../package.json');
    assert.equal(desktopPackage.dependencies.entities, '7.0.1');
  });

  it('rejects the exact missing transitive dependency that broke v0.8.4 startup', () => {
    assert.deepEqual(requiredAsarPackageProblems(new Set(['htmlparser2'])), [
      'required runtime package is missing from app.asar: entities',
    ]);
  });

  it('accepts the packaged runtime dependency when it is present', () => {
    assert.deepEqual(requiredAsarPackageProblems(new Set(['entities', 'htmlparser2'])), []);
  });

  it('blocks missing runtime contracts without blocking historical inventory removals', () => {
    assert.deepEqual(
      asarPackageInventoryPolicy(
        new Set(['htmlparser2']),
        new Set(['entities', 'signal-exit', 'unused-package'])
      ),
      {
        blockingProblems: ['required runtime package is missing from app.asar: entities'],
        informationalRemovals: ['signal-exit', 'unused-package'],
      }
    );
  });

  it('accepts a current runtime contract while reporting stale inventory deterministically', () => {
    assert.deepEqual(
      asarPackageInventoryPolicy(
        new Set(['entities', 'htmlparser2']),
        new Set(['unused-z', 'entities', 'unused-a'])
      ),
      {
        blockingProblems: [],
        informationalRemovals: ['unused-a', 'unused-z'],
      }
    );
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

describe('pre-install helper boundary', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preinstall-helper-'));
    temporaryRoots.push(root);
    const scripts = path.join(root, 'apps', 'desktop', 'scripts');
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, 'verify-package-helpers.cjs'),
      path.join(scripts, 'lib', 'verify-package-helpers.cjs')
    );
    fs.copyFileSync(
      path.join(__dirname, '..', 'build-helpers.cjs'),
      path.join(scripts, 'build-helpers.cjs')
    );
    return {
      root,
      scripts,
      env: {
        ...process.env,
        NODE_PATH: '',
        NODE_OPTIONS: '',
        CARGO_TARGET_DIR: path.join(root, 'cargo-target'),
      },
    };
  }

  it('runs the real helper CLI before node_modules exists', () => {
    const { root, scripts, env } = fixture();
    const cargoFixture = path.join(root, 'cargo-fixture.cjs');
    fs.writeFileSync(
      cargoFixture,
      `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { helperPlatformSuffix } = require('./apps/desktop/scripts/lib/verify-package-helpers.cjs');
const target = helperPlatformSuffix(process.platform, process.arch);
const provenanceCalls = [];
assert.throws(() => require.resolve('typescript'), { code: 'MODULE_NOT_FOUND' });
require('node:child_process').execFileSync = (command, args, options) => {
  if (command === process.execPath) {
    assert.equal(args.length, 5);
    assert.equal(args[0], path.join(process.cwd(), 'scripts', 'coverage-helper-artifact.mjs'));
    const [, operation, actualTarget, binary, receiptPath] = args;
    assert.equal(actualTarget, target);
    assert.equal(fs.readFileSync(binary, 'utf8'), 'cargo-fixture:dna-coverage');
    const receipt = {
      target,
      binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    };
    if (operation === 'create') fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    else {
      assert.equal(operation, 'verify');
      assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receipt);
    }
    provenanceCalls.push(operation);
    fs.writeFileSync(path.join(process.env.CARGO_TARGET_DIR, 'provenance-calls.json'), JSON.stringify(provenanceCalls));
    return;
  }
  assert.equal(command, 'cargo');
  const helper = args.at(-1);
  const coverage = helper === 'dna-coverage';
  assert.deepEqual(args, ['build', ...(coverage ? ['--locked', '--target', target] : []), '--release', '--bin', helper]);
  const output = path.join(options.env.CARGO_TARGET_DIR, ...(coverage ? [target] : []), 'release',
    helper + (process.platform === 'win32' ? '.exe' : ''));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'cargo-fixture:' + helper);
};
`
    );
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        cargoFixture,
        path.join(scripts, 'build-helpers.cjs'),
        'dna-indexer',
        'dna-coverage',
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 5_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const helpers = ['dna-indexer', 'dna-coverage'];
    if (process.platform === 'win32') helpers.push('dna-process-guardian');
    for (const helper of helpers) {
      const installed = path.join(
        root,
        'apps',
        'desktop',
        'resources',
        'helpers',
        helperExecutableName(helper, process.platform, process.arch)
      );
      assert.equal(fs.readFileSync(installed, 'utf8'), `cargo-fixture:${helper}`);
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(env.CARGO_TARGET_DIR, 'provenance-calls.json'), 'utf8')),
      ['create', 'verify']
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            'apps',
            'desktop',
            'resources',
            'helpers',
            'coverage-build-provenance.json'
          ),
          'utf8'
        )
      ).target,
      helperPlatformSuffix(process.platform, process.arch)
    );
  });

  it('still refuses JavaScript verification when the parser dependency is absent', () => {
    const { root, scripts, env } = fixture();
    const helperPath = path.join(scripts, 'lib', 'verify-package-helpers.cjs');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
const helpers = require(${JSON.stringify(helperPath)});
process.stdout.write('helper-loaded\\n');
helpers.verifyMainJavaScriptGraph({
  packageMain: 'out/main/index.js',
  files: [{ path: 'out/main/index.js', content: 'export const value = 1;' }]
});
`,
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 5_000 }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'helper-loaded\n');
    assert.match(result.stderr, /Cannot find module 'typescript'/u);
  });
});

describe('reachable compiled main-process graph', () => {
  const file = (filePath, content) => ({ path: filePath, content });

  it('follows the frozen bootstrap dynamic import to product runtime contracts', () => {
    const graph = verifyMainJavaScriptGraph({
      packageMain: 'out/main/index.js',
      files: [
        file(
          'out/main/index.js',
          'import "./chunks/helper.js"; async function start() { await import("./product.js"); }'
        ),
        file('out/main/chunks/helper.js', 'export const helper = true;'),
        file(
          'out/main/product.js',
          'export const marker = "DNAFORGE_STRUCTURED_PDF_PROVIDER_V1::END";'
        ),
      ],
    });

    assert.deepEqual(graph.paths, [
      'out/main/chunks/helper.js',
      'out/main/index.js',
      'out/main/product.js',
    ]);
    assert.doesNotMatch(graph.entryBuffer.toString('utf8'), /STRUCTURED_PDF_PROVIDER/u);
    assert.match(graph.buffer.toString('utf8'), /STRUCTURED_PDF_PROVIDER/u);
  });

  it('rejects orphan markers, missing chunks, and non-literal dynamic imports', () => {
    assert.throws(
      () =>
        verifyMainJavaScriptGraph({
          packageMain: 'out/main/index.js',
          files: [
            file('out/main/index.js', 'export const boot = true;'),
            file('out/main/orphan.js', 'DNAFORGE_STRUCTURED_PDF_PROVIDER_V1::END'),
          ],
        }),
      /unreferenced main-process JavaScript: out\/main\/orphan\.js/u
    );
    assert.throws(
      () =>
        verifyMainJavaScriptGraph({
          packageMain: 'out/main/index.js',
          files: [file('out/main/index.js', 'import("./missing.js");')],
        }),
      /references missing main-process JavaScript/u
    );
    assert.throws(
      () =>
        verifyMainJavaScriptGraph({
          packageMain: 'out/main/index.js',
          files: [file('out/main/index.js', 'import(nextChunk);')],
        }),
      /non-literal dynamic import/u
    );
  });
});

function windowsFixture({ mutateExecutable = false, mutateMetadata = false } = {}) {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-package-proof-'));
  temporaryRoots.push(resourcesDir);
  const triple = 'x86_64-pc-windows-msvc';
  const codexRoot = path.join(resourcesDir, 'binaries', 'codex-app-server');
  const executablePath = path.join(codexRoot, triple, 'bin', 'codex.exe');
  const metadataPath = path.join(codexRoot, triple, 'codex-package.json');
  const licensePath = path.join(codexRoot, 'LICENSE');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });

  const originalExecutable = Buffer.alloc(2048, 0x41);
  originalExecutable.write('MZ', 0, 'ascii');
  const packagedExecutable = Buffer.from(originalExecutable);
  if (mutateExecutable) packagedExecutable[1024] ^= 0xff;
  fs.writeFileSync(executablePath, packagedExecutable);

  const originalMetadata = Buffer.from('{"version":"pinned"}\n');
  const packagedMetadata = mutateMetadata
    ? Buffer.from('{"version":"changed"}\n')
    : originalMetadata;
  fs.writeFileSync(metadataPath, packagedMetadata);

  const license = Buffer.from('Pinned license\n');
  fs.writeFileSync(licensePath, license);

  return {
    resourcesDir,
    executablePath,
    manifest: {
      supportedTargets: {
        'win32-x64': {
          verified: true,
          triple,
          resources: [
            {
              pathInPackage: `vendor/${triple}/bin/codex.exe`,
              sha256: sha256(originalExecutable),
              executable: true,
            },
            {
              pathInPackage: `vendor/${triple}/codex-package.json`,
              sha256: sha256(originalMetadata),
              executable: false,
            },
          ],
        },
      },
      license: {
        files: [{ path: 'LICENSE', sha256: sha256(license) }],
      },
    },
  };
}

describe('Codex App Server signed Windows package integrity', () => {
  it('accepts exact unsigned upstream bytes without consulting Authenticode', () => {
    const fixture = windowsFixture();
    let signatureChecks = 0;
    const problem = codexAppServerIntegrityProblem({
      platform: 'win32',
      arch: 'x64',
      resourcesDir: fixture.resourcesDir,
      manifest: fixture.manifest,
      windowsExecutableSignatureProblem() {
        signatureChecks += 1;
        return 'must not run';
      },
    });

    assert.equal(problem, null);
    assert.equal(signatureChecks, 0);
  });

  it('accepts an executable-only post-sign transform when exact Authenticode passes', () => {
    const fixture = windowsFixture({ mutateExecutable: true });
    const checked = [];
    const problem = codexAppServerIntegrityProblem({
      platform: 'win32',
      arch: 'x64',
      resourcesDir: fixture.resourcesDir,
      manifest: fixture.manifest,
      windowsExecutableSignatureProblem(filePath) {
        checked.push(filePath);
        return null;
      },
    });

    assert.equal(problem, null);
    assert.deepEqual(checked, [fixture.executablePath]);
  });

  it('fails closed when transformed executable bytes lack valid Authenticode', () => {
    const fixture = windowsFixture({ mutateExecutable: true });
    const problem = codexAppServerIntegrityProblem({
      platform: 'win32',
      arch: 'x64',
      resourcesDir: fixture.resourcesDir,
      manifest: fixture.manifest,
      windowsExecutableSignatureProblem() {
        return 'status NotSigned';
      },
    });

    assert.match(problem, /digest mismatch/);
    assert.match(problem, /Authenticode proof failed: status NotSigned/);
  });

  it('never excuses changed non-executable metadata with a signature callback', () => {
    const fixture = windowsFixture({ mutateMetadata: true });
    let signatureChecks = 0;
    const problem = codexAppServerIntegrityProblem({
      platform: 'win32',
      arch: 'x64',
      resourcesDir: fixture.resourcesDir,
      manifest: fixture.manifest,
      windowsExecutableSignatureProblem() {
        signatureChecks += 1;
        return null;
      },
    });

    assert.match(problem, /codex-package\.json/);
    assert.match(problem, /digest mismatch/);
    assert.equal(signatureChecks, 0);
  });
});

const STABLE_UPDATE_CONFIG = Object.freeze({
  owner: 'humic-labs',
  repo: 'dnaforge',
  provider: 'github',
  releaseType: 'draft',
  private: true,
  updaterCacheDirName: '@waypointdesktop-updater',
});

function stableMacIdentity(overrides = {}) {
  return {
    identity: 'stable',
    platform: 'darwin',
    appRoot: '/Volumes/DNAForge/DNAForge.app',
    expectedVersion: '0.8.2',
    packageMetadata: {
      name: '@waypoint/desktop',
      productName: 'DNAForge',
      version: '0.8.2',
    },
    plist: {
      CFBundleIdentifier: 'com.dnaforge.desktop',
      CFBundleName: 'DNAForge',
      CFBundleDisplayName: 'DNAForge',
      CFBundleExecutable: 'DNAForge',
      CFBundlePackageType: 'APPL',
      CFBundleIconFile: 'icon.icns',
      CFBundleShortVersionString: '0.8.2',
      CFBundleVersion: '0.8.2',
      CFBundleURLTypes: [
        {
          CFBundleTypeRole: 'Editor',
          CFBundleURLName: 'DNAForge Sign-in',
          CFBundleURLSchemes: ['dnaforge', 'dnaforge-beta'],
        },
      ],
    },
    updateConfig: STABLE_UPDATE_CONFIG,
    packagedIconSha256: 'a'.repeat(64),
    expectedIconSha256: 'a'.repeat(64),
    packagedIconSize: 566_275,
    ...overrides,
  };
}

describe('installed application identity', () => {
  it('accepts the complete stable macOS identity and exact canonical icon bytes', () => {
    assert.deepEqual(installedAppIdentityProblems(stableMacIdentity()), []);
  });

  it('fails closed when a stable macOS artifact carries the package/default icon', () => {
    const problems = installedAppIdentityProblems(
      stableMacIdentity({ packagedIconSha256: 'b'.repeat(64) })
    );

    assert.ok(problems.some((problem) => /icon\.icns SHA-256/.test(problem)));
  });

  it('fails closed when a stable macOS artifact changes its bundle or update identity', () => {
    const fixture = stableMacIdentity();
    const problems = installedAppIdentityProblems({
      ...fixture,
      plist: { ...fixture.plist, CFBundleIdentifier: 'com.dnaforge.desktop.validation' },
      updateConfig: { ...fixture.updateConfig, updaterCacheDirName: 'dnaforge-validation-updater' },
    });

    assert.ok(problems.some((problem) => /CFBundleIdentifier/.test(problem)));
    assert.ok(problems.some((problem) => /updaterCacheDirName/.test(problem)));
  });

  it('requires the exact stable Windows publisher and updater-cache identity', () => {
    const base = {
      identity: 'stable',
      platform: 'win32',
      appRoot: 'C:\\Program Files\\DNAForge',
      expectedVersion: '0.8.2',
      executableName: 'DNAForge.exe',
      packageMetadata: {
        name: '@waypoint/desktop',
        productName: 'DNAForge',
        version: '0.8.2',
      },
      updateConfig: {
        ...STABLE_UPDATE_CONFIG,
        publisherName: [
          'C=US, S=California, L=San Francisco, O=Humic Labs Inc., CN=Humic Labs Inc.',
        ],
      },
    };

    assert.deepEqual(installedAppIdentityProblems(base), []);
    assert.ok(
      installedAppIdentityProblems({
        ...base,
        updateConfig: { ...base.updateConfig, publisherName: ['Different Publisher'] },
      }).some((problem) => /publisherName/.test(problem))
    );
    assert.ok(
      installedAppIdentityProblems({
        ...base,
        updateConfig: { ...base.updateConfig, updaterCacheDirName: 'dnaforge-updater' },
      }).some((problem) => /updaterCacheDirName/.test(problem))
    );
  });

  it('accepts only the isolated validation identity and rejects production identity', () => {
    const validation = stableMacIdentity({
      identity: 'validation',
      appRoot: '/tmp/DNAForge Validation.app',
      plist: {
        CFBundleIdentifier: 'com.dnaforge.desktop.validation',
        CFBundleName: 'DNAForge Validation',
        CFBundleDisplayName: 'DNAForge Validation',
        CFBundleExecutable: 'DNAForge Validation',
        CFBundlePackageType: 'APPL',
        CFBundleIconFile: 'icon.icns',
        CFBundleShortVersionString: '0.8.2',
        CFBundleVersion: '0.8.2',
      },
      updateConfig: {
        ...STABLE_UPDATE_CONFIG,
        updaterCacheDirName: 'dnaforge-validation-updater',
      },
      packageMetadata: {
        name: 'dnaforge-validation',
        productName: 'DNAForge Validation',
        version: '0.8.2',
      },
      packagedIconSha256: 'b'.repeat(64),
    });

    assert.deepEqual(installedAppIdentityProblems(validation), []);
    const productionProblems = installedAppIdentityProblems({
      ...stableMacIdentity(),
      identity: 'validation',
    });
    assert.ok(productionProblems.some((problem) => /CFBundleIdentifier/.test(problem)));
    assert.ok(productionProblems.some((problem) => /validation bundle name/.test(problem)));
    assert.ok(productionProblems.some((problem) => /updaterCacheDirName/.test(problem)));
    assert.ok(
      productionProblems.some((problem) => /must not register stable URL protocols/.test(problem))
    );
  });

  it('fails closed on an unsupported identity or platform', () => {
    assert.throws(
      () => installedAppIdentityProblems({ identity: 'unknown', platform: 'darwin' }),
      /Unsupported packaged identity/
    );
    assert.throws(
      () => installedAppIdentityProblems({ identity: 'stable', platform: 'linux' }),
      /Unsupported packaged platform/
    );
  });
});

const SOURCE_COMMIT = '1'.repeat(40);
const RELEASE_STAMP = 'DNAFORGE_RELEASE_BUILD=1::SCHEMA_MIGRATION_AUTHORITY_V1::END';
const SOURCE_STAMP = `DNAFORGE_SOURCE_COMMIT=${SOURCE_COMMIT}::SOURCE_COMMIT_PROVENANCE_V1::END`;
const STABLE_FEEDS = require('../../update-authority.json').stableFeedBases;
const STABLE_FEED = STABLE_FEEDS[0];

function compiledAuthority(feedBases = STABLE_FEEDS) {
  const encodedAuthorities = Buffer.from(JSON.stringify(feedBases), 'utf8').toString('base64url');
  return [
    `const UPDATE_FEED_BASE = "${feedBases[0]}";`,
    `const UPDATE_AUTHORITY_STAMP = "DNAFORGE_UPDATE_AUTHORITIES=${encodedAuthorities}::UPDATE_AUTHORITY_V2::END";`,
  ].join('\n');
}

describe('compiled updater authority list', () => {
  for (const authority of ['valid', 'duplicate', 'missing', 'wrong']) {
    it(`checks ${authority} updater authority through the compiled split-graph CLI`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-updater-graph-'));
      temporaryRoots.push(root);
      const indexPath = path.join(root, 'index.js');
      const parserMarker = require('../../resources/opendataloader-runtime.json').parser
        .contractMarker;
      fs.writeFileSync(
        indexPath,
        [
          ...[
            RELEASE_STAMP,
            SOURCE_STAMP,
            'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END',
            'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled',
            'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty',
            parserMarker,
          ].map((marker) => `${JSON.stringify(marker)};`),
          authority === 'duplicate' ? compiledAuthority() : '',
          'import("./product.js");',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(root, 'product.js'),
        authority === 'missing'
          ? 'export {};'
          : compiledAuthority(
              authority === 'wrong'
                ? ['https://wrong.example', ...STABLE_FEEDS.slice(1)]
                : STABLE_FEEDS
            )
      );
      const env = { ...process.env };
      delete env.WAYPOINT_UPDATE_FEED_BASE;
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '..', 'verify-package.cjs'),
          '--bundle-stamp-only',
          indexPath,
          '--require-release-stamp',
          '--expected-source-commit',
          SOURCE_COMMIT,
          '--forbid-hosted-gateway',
        ],
        { encoding: 'utf8', env }
      );
      if (authority === 'valid') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /updater feed authorities are pinned in order/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /updater feed authority/);
      }
    });
  }

  it('requires the exact ordered authority list and compatibility primary', () => {
    assert.deepEqual(verifyUpdateFeedAuthority(compiledAuthority(), STABLE_FEEDS), {
      ok: true,
      feedBase: STABLE_FEED,
      feedBases: STABLE_FEEDS,
      message: `updater feed authorities are pinned in order to ${STABLE_FEEDS.join(', ')}`,
    });
  });

  it('ignores the runtime parser prefix and suffix constants around the sealed marker', () => {
    const runtimeShapedBundle = [
      compiledAuthority().split('\n')[0],
      'const UPDATE_AUTHORITY_STAMP_PREFIX = "DNAFORGE_UPDATE_AUTHORITIES=";',
      'const UPDATE_AUTHORITY_STAMP_SUFFIX = "::UPDATE_AUTHORITY_V2::END";',
      compiledAuthority().split('\n')[1],
    ].join('\n');

    assert.equal(verifyUpdateFeedAuthority(runtimeShapedBundle, STABLE_FEEDS).ok, true);
  });

  it('rejects missing, reordered, duplicate, and mismatched primary authorities', () => {
    const cases = [
      compiledAuthority(STABLE_FEEDS.slice(0, 1)),
      compiledAuthority([...STABLE_FEEDS].reverse()),
      compiledAuthority([STABLE_FEED, STABLE_FEED]),
      [`const UPDATE_FEED_BASE = "${STABLE_FEEDS[1]}";`, compiledAuthority().split('\n')[1]].join(
        '\n'
      ),
    ];
    for (const mainBundle of cases) {
      assert.equal(verifyUpdateFeedAuthority(mainBundle, STABLE_FEEDS).ok, false);
    }
  });

  it('rejects unsealed JSON, malformed base64url, and non-JSON marker payloads', () => {
    const primary = `const UPDATE_FEED_BASE = "${STABLE_FEED}";`;
    const cases = [
      `${primary}\nDNAFORGE_UPDATE_AUTHORITIES=${JSON.stringify(STABLE_FEEDS)}::UPDATE_AUTHORITY_V2::END`,
      `${primary}\nDNAFORGE_UPDATE_AUTHORITIES=not+padded=::UPDATE_AUTHORITY_V2::END`,
      `${primary}\nDNAFORGE_UPDATE_AUTHORITIES=${Buffer.from('not JSON').toString('base64url')}::UPDATE_AUTHORITY_V2::END`,
    ];
    for (const mainBundle of cases) {
      assert.equal(verifyUpdateFeedAuthority(mainBundle, STABLE_FEEDS).ok, false);
    }
  });
});

function writeInstalledFixtureReleaseReceipts(
  asarSource,
  { policy = RELEASE_POLICY, missingTarget } = {}
) {
  const repoRoot = path.join(path.dirname(asarSource), 'release-source-root');
  for (const target of ['main', 'preload', 'renderer']) {
    const outputDir = path.join(asarSource, 'out', target);
    fs.mkdirSync(outputDir, { recursive: true });
    const entry = path.join(outputDir, 'index.js');
    if (!fs.existsSync(entry)) fs.writeFileSync(entry, 'export {};\n');
    const modules = {};
    for (const name of fs.readdirSync(outputDir).filter((name) => name.endsWith('.js'))) {
      const source = path.join(repoRoot, 'apps', 'desktop', 'src', target, name);
      const contents = fs.readFileSync(path.join(outputDir, name));
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      modules[source] = { renderedLength: contents.length };
    }
    const report = releaseBundleReport({
      target,
      loadedIds: Object.keys(modules),
      chunks: [{ type: 'chunk', modules }],
      repoRoot,
      policy,
    });
    assert.deepEqual(report.violations, []);
    if (target !== missingTarget) {
      fs.writeFileSync(
        path.join(outputDir, `release-sources.${target}.json`),
        JSON.stringify(report)
      );
    }
  }
}

async function writeWindowsInstalledFixture({
  identity = 'stable',
  releaseStamped = identity === 'stable',
  qualificationEphemeralAuth = false,
  splitMain = false,
  qualificationInSplitMain = false,
  releaseReceiptPolicy = RELEASE_POLICY,
  missingReleaseReceipt,
} = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-installed-proof-'));
  temporaryRoots.push(fixtureRoot);
  const appRoot = path.join(
    fixtureRoot,
    identity === 'stable' ? 'DNAForge' : 'DNAForge Validation'
  );
  const resourcesDir = path.join(appRoot, 'resources');
  const asarSource = path.join(fixtureRoot, 'asar-source');
  fs.mkdirSync(path.join(asarSource, 'out', 'main'), { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  const productName = identity === 'stable' ? 'DNAForge' : 'DNAForge Validation';
  const packageName = identity === 'stable' ? '@waypoint/desktop' : 'dnaforge-validation';
  const cacheName =
    identity === 'stable' ? '@waypointdesktop-updater' : 'dnaforge-validation-updater';
  const executable = Buffer.alloc(128);
  executable.write('MZ', 0, 'ascii');
  executable.writeUInt32LE(0x40, 0x3c);
  executable.write('PE\0\0', 0x40, 'ascii');
  executable.writeUInt16LE(0x8664, 0x44);
  fs.writeFileSync(path.join(appRoot, `${productName}.exe`), executable);
  fs.writeFileSync(
    path.join(asarSource, 'package.json'),
    JSON.stringify({ name: packageName, productName, version: '0.8.2', main: 'out/main/index.js' })
  );
  fs.writeFileSync(
    path.join(asarSource, 'out', 'main', 'index.js'),
    [
      releaseStamped ? JSON.stringify(RELEASE_STAMP) : '',
      splitMain ? '' : JSON.stringify(SOURCE_STAMP),
      qualificationEphemeralAuth && !qualificationInSplitMain
        ? JSON.stringify(
            `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${SOURCE_COMMIT}::QUALIFICATION_EPHEMERAL_AUTH_V1::END`
          )
        : '',
      compiledAuthority(),
      splitMain ? 'import("./product-split.js");' : '',
    ].join('\n')
  );
  if (splitMain) {
    fs.writeFileSync(
      path.join(asarSource, 'out', 'main', 'product-split.js'),
      [
        JSON.stringify(SOURCE_STAMP),
        JSON.stringify(SOURCE_STAMP),
        qualificationEphemeralAuth && qualificationInSplitMain
          ? JSON.stringify(
              `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${SOURCE_COMMIT}::QUALIFICATION_EPHEMERAL_AUTH_V1::END`
            )
          : '',
      ].join('\n')
    );
  }
  writeInstalledFixtureReleaseReceipts(asarSource, {
    policy: releaseReceiptPolicy,
    missingTarget: missingReleaseReceipt,
  });
  const asarPath = path.join(resourcesDir, 'app.asar');
  await finished(await createPackage(asarSource, asarPath));
  fs.writeFileSync(
    path.join(resourcesDir, 'app-update.yml'),
    [
      'owner: humic-labs',
      'repo: dnaforge',
      'provider: github',
      'releaseType: draft',
      'private: true',
      `updaterCacheDirName: '${cacheName}'`,
      'publisherName:',
      '  - C=US, S=California, L=San Francisco, O=Humic Labs Inc., CN=Humic Labs Inc.',
      '',
    ].join('\n')
  );
  return { appRoot, asarPath };
}

async function writeMacInstalledFixture({
  qualificationInSplitMain = false,
  releaseInSplitMain = false,
} = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-mounted-proof-'));
  temporaryRoots.push(fixtureRoot);
  const appRoot = path.join(fixtureRoot, 'DNAForge.app');
  const executableDir = path.join(appRoot, 'Contents', 'MacOS');
  const resourcesDir = path.join(appRoot, 'Contents', 'Resources');
  const asarSource = path.join(fixtureRoot, 'asar-source');
  fs.mkdirSync(path.join(asarSource, 'out', 'main'), { recursive: true });
  fs.mkdirSync(executableDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(0x01000007, 4);
  executable.writeUInt32LE(3, 8);
  executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(executableDir, 'DNAForge'), executable);
  fs.writeFileSync(
    path.join(asarSource, 'package.json'),
    JSON.stringify({
      name: '@waypoint/desktop',
      productName: 'DNAForge',
      version: '0.8.2',
      main: 'out/main/index.js',
    })
  );
  fs.writeFileSync(
    path.join(asarSource, 'out', 'main', 'index.js'),
    [
      releaseInSplitMain ? '' : JSON.stringify(RELEASE_STAMP),
      qualificationInSplitMain ? '' : JSON.stringify(SOURCE_STAMP),
      releaseInSplitMain
        ? JSON.stringify(
            `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${SOURCE_COMMIT}::QUALIFICATION_EPHEMERAL_AUTH_V1::END`
          )
        : '',
      compiledAuthority(),
      qualificationInSplitMain || releaseInSplitMain ? 'import("./product-split.js");' : '',
    ].join('\n')
  );
  if (qualificationInSplitMain || releaseInSplitMain) {
    fs.writeFileSync(
      path.join(asarSource, 'out', 'main', 'product-split.js'),
      [
        qualificationInSplitMain ? JSON.stringify(SOURCE_STAMP) : '',
        qualificationInSplitMain
          ? JSON.stringify(
              `DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=${SOURCE_COMMIT}::QUALIFICATION_EPHEMERAL_AUTH_V1::END`
            )
          : '',
        releaseInSplitMain ? JSON.stringify(RELEASE_STAMP) : '',
      ].join('\n')
    );
  }
  writeInstalledFixtureReleaseReceipts(asarSource);
  await finished(await createPackage(asarSource, path.join(resourcesDir, 'app.asar')));
  fs.writeFileSync(
    path.join(resourcesDir, 'app-update.yml'),
    [
      'owner: humic-labs',
      'repo: dnaforge',
      'provider: github',
      'releaseType: draft',
      'private: true',
      "updaterCacheDirName: '@waypointdesktop-updater'",
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(appRoot, 'Contents', 'Info.plist'),
    JSON.stringify(stableMacIdentity({ appRoot }).plist)
  );
  fs.copyFileSync(
    path.resolve(__dirname, '..', '..', 'resources', 'icon.icns'),
    path.join(resourcesDir, 'icon.icns')
  );
  return { appRoot };
}

function runInstalledVerifier(
  appRoot,
  identity,
  extraArgs = [],
  { platform = 'win32', arch = 'x64' } = {}
) {
  return spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '..', 'verify-package.cjs'),
      '--platform',
      platform,
      '--arch',
      arch,
      '--app-root',
      appRoot,
      '--identity',
      identity,
      '--expected-source-commit',
      SOURCE_COMMIT,
      '--expected-version',
      '0.8.2',
      ...extraArgs,
    ],
    { encoding: 'utf8' }
  );
}

describe('installed application verifier CLI', () => {
  for (const target of ['main', 'preload', 'renderer']) {
    it(`rejects an installed fixture without its ${target} release-source receipt`, async () => {
      const fixture = await writeWindowsInstalledFixture({ missingReleaseReceipt: target });
      const result = runInstalledVerifier(fixture.appRoot, 'stable');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`release-sources\\.${target}\\.json is missing`));
    });
  }

  it('rejects an installed fixture built under the internal source policy', async () => {
    const fixture = await writeWindowsInstalledFixture({ releaseReceiptPolicy: 'internal' });
    const result = runInstalledVerifier(fixture.appRoot, 'stable');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /built under the internal policy, not the release policy/);
  });

  it('verifies the exact stable installed tree without consulting dist-electron', async () => {
    const fixture = await writeWindowsInstalledFixture();
    const result = runInstalledVerifier(fixture.appRoot, 'stable');

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /installed app identity is stable/);
    assert.match(result.stdout, /executable architecture is x64/);
    assert.match(result.stdout, /release-only database migration stamp is present/);
    assert.match(result.stdout, /appAsarSha256=[0-9a-f]{64}/);
  });

  it('verifies immutable authority across the bootstrap and dynamically loaded product chunk', async () => {
    const fixture = await writeWindowsInstalledFixture({ splitMain: true });
    const result = runInstalledVerifier(fixture.appRoot, 'stable');

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`source commit ${SOURCE_COMMIT} is embedded`, 'u'));
  });

  it('rejects qualification authority that exists only after the product import', async () => {
    const fixture = await writeMacInstalledFixture({ qualificationInSplitMain: true });
    const result = runInstalledVerifier(
      fixture.appRoot,
      'stable',
      [
        '--require-release-stamp',
        '--expected-hosted-gateway',
        'https://hosted-ai-gateway-staging.up.railway.app',
        '--require-qualification-ephemeral-auth',
      ],
      { platform: 'darwin', arch: 'x64' }
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /main entry authority: packaged main bundle must carry one unique source commit stamp/
    );
  });

  it('rejects release migration authority that exists only after the product import', async () => {
    const fixture = await writeMacInstalledFixture({ releaseInSplitMain: true });
    const result = runInstalledVerifier(
      fixture.appRoot,
      'stable',
      [
        '--require-release-stamp',
        '--expected-hosted-gateway',
        'https://hosted-ai-gateway-staging.up.railway.app',
        '--require-qualification-ephemeral-auth',
      ],
      { platform: 'darwin', arch: 'x64' }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /main entry authority: release artifact is missing/);
  });

  it(
    'verifies the exact stable mounted macOS app including plist and icon bytes',
    { skip: process.platform !== 'darwin' },
    async () => {
      const fixture = await writeMacInstalledFixture();
      const result = runInstalledVerifier(fixture.appRoot, 'stable', [], {
        platform: 'darwin',
        arch: 'x64',
      });

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Info\.plist decoded from the installed app/);
      assert.match(result.stdout, /icon\.icns bytes were hashed/);
      assert.match(result.stdout, /installed app identity is stable/);
    }
  );

  it('requires a release stamp for stable and forbids one for validation', async () => {
    const unstampedStable = await writeWindowsInstalledFixture({ releaseStamped: false });
    const stableResult = runInstalledVerifier(unstampedStable.appRoot, 'stable');
    assert.notEqual(stableResult.status, 0);
    assert.match(stableResult.stderr, /missing DNAFORGE_RELEASE_BUILD/);

    const stampedValidation = await writeWindowsInstalledFixture({
      identity: 'validation',
      releaseStamped: true,
    });
    const validationResult = runInstalledVerifier(stampedValidation.appRoot, 'validation');
    assert.notEqual(validationResult.status, 0);
    assert.match(validationResult.stderr, /unexpectedly contains DNAFORGE_RELEASE_BUILD/);
  });

  it('binds a post-update install to the expected app.asar bytes', async () => {
    const fixture = await writeWindowsInstalledFixture();
    const result = runInstalledVerifier(fixture.appRoot, 'stable', [
      '--expected-app-asar-sha256',
      'f'.repeat(64),
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /app\.asar SHA-256 .* does not match expected/);
  });

  it('forbids ephemeral qualification auth unless the complete macOS authority tuple is explicit', async () => {
    const fixture = await writeWindowsInstalledFixture({ qualificationEphemeralAuth: true });

    const forbidden = runInstalledVerifier(fixture.appRoot, 'stable');
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /must not contain qualification ephemeral auth authority/u);

    const required = runInstalledVerifier(fixture.appRoot, 'stable', [
      '--require-qualification-ephemeral-auth',
    ]);
    assert.notEqual(required.status, 0);
    assert.match(
      required.stderr,
      /requires darwin, an explicit source commit, the release stamp, and an exact Hosted gateway/u
    );
  });
});
