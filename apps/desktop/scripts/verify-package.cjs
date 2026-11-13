#!/usr/bin/env node

const { execFileSync, spawnSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { isAbiError } = require('./native-abi-patterns.cjs');
const { inspectDnaIndexerContract } = require('./lib/dna-indexer-contract.cjs');
const {
  describeNativeBinary: describeTargetBinary,
  DNA_HELPER_SPECS,
  FASTP_HELPER_SPEC,
} = require('./lib/native-binary.cjs');
const {
  loadFileAssociationRegistry,
  projectMacAssociationMetadata,
} = require('./file-association-packaging.cjs');
const { receiptProblems } = require('../../../scripts/sidecar-build-receipt.cjs');
const { extractFile, getRawHeader, listPackage } = require('@electron/asar');
const { parse: parseYaml } = require('yaml');
const { releaseSourceReceiptProblems } = require('./lib/release-source-receipts.cjs');
const {
  asarPackageInventoryPolicy,
  helperExecutableName,
  resolveAsarEntryPath,
  verifyReleaseBuildStamp,
  verifySourceCommitStamp,
  verifyUpdateFeedAuthority,
  installedAppIdentityProblems,
  verifyHostedGatewayAuthority,
  verifyHostedGatewayGraphAuthority,
  verifyQualificationEphemeralAuth,
  hostedGatewayExpectationFromEnv,
  releaseAAuthBundleProblems,
  releaseBHostedBundleProblems,
  packagedHelperIntegrityProblem,
  parseNativeCoverageContractProbe,
  nativeCoverageContractProblem,
  mcpStdioProbeProblem,
  sidecarBundleProblem,
  codexAppServerIntegrityProblem,
  verifyMainJavaScriptGraph,
  installedPackageCompositionReceipt,
  installedPackageCompositionProblems,
  packageCompositionReceipt,
  packageCompositionProblems,
} = require('./lib/verify-package-helpers.cjs');

const OPEN_DATA_LOADER_MANIFEST_FILE = path.join(
  __dirname,
  '..',
  'resources',
  'opendataloader-runtime.json'
);

function mainJavaScriptPaths(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(`main-process graph contains a symbolic link: ${absolute}`);
      } else if (entry.isFile() && /\.(?:cjs|mjs|js)$/u.test(entry.name)) paths.push(absolute);
    }
  };
  visit(root);
  return paths.sort();
}

function readCompiledMainGraph(entryPath) {
  if (path.basename(entryPath) !== 'index.js') {
    throw new Error(`local main entry must be exactly index.js; found ${path.basename(entryPath)}`);
  }
  const mainRoot = path.dirname(entryPath);
  const paths = mainJavaScriptPaths(mainRoot);
  if (!paths.includes(entryPath)) {
    throw new Error(`main entry was not found in its compiled graph: ${entryPath}`);
  }
  return verifyMainJavaScriptGraph({
    packageMain: 'out/main/index.js',
    files: paths.map((file) => ({
      path: `out/main/${path.relative(mainRoot, file).split(path.sep).join('/')}`,
      content: fs.readFileSync(file),
    })),
  });
}

function extractPackagedMainGraph(archivePath, archiveEntries, packageMain) {
  const entries = archiveEntries
    .map((entry) => ({
      listed: entry,
      canonical: entry.replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    }))
    .filter(
      ({ canonical }) => canonical.startsWith('out/main/') && /\.(?:cjs|mjs|js)$/u.test(canonical)
    )
    .sort((left, right) => left.canonical.localeCompare(right.canonical));
  return verifyMainJavaScriptGraph({
    packageMain,
    files: entries.map(({ listed, canonical }) => ({
      path: canonical,
      content: extractFile(archivePath, listed.replace(/^[\\/]+/, '')),
    })),
  });
}

function requireOpenDataLoaderCompiledContract(mainGraphBuffer) {
  const manifest = JSON.parse(fs.readFileSync(OPEN_DATA_LOADER_MANIFEST_FILE, 'utf8'));
  if (!mainGraphBuffer.includes(manifest.parser.contractMarker)) {
    throw new Error(
      'compiled main-process graph does not contain the pinned OpenDataLoader parser contract'
    );
  }
  return manifest;
}

const args = process.argv.slice(2);
const archIdx = args.indexOf('--arch');
const archArg = archIdx !== -1 ? args[archIdx + 1] : null;
const platformIdx = args.indexOf('--platform');
const platformArg = platformIdx !== -1 ? args[platformIdx + 1] : null;
const skipSidecarCheck = args.includes('--skip-sidecar-check');
const requireReleaseStamp = args.includes('--require-release-stamp');
const stampOnly = args.includes('--stamp-only');
const bundleStampOnlyIdx = args.indexOf('--bundle-stamp-only');
const codexAppServerOnlyIdx = args.indexOf('--codex-app-server-only');
const appRootIdx = args.indexOf('--app-root');
const distDirIdx = args.indexOf('--dist-dir');
const identityIdx = args.indexOf('--identity');
const expectedSourceCommitIdx = args.indexOf('--expected-source-commit');
const expectedVersionIdx = args.indexOf('--expected-version');
const expectedAppAsarSha256Idx = args.indexOf('--expected-app-asar-sha256');
const expectedHostedGatewayIdx = args.indexOf('--expected-hosted-gateway');
const forbidHostedGateway = args.includes('--forbid-hosted-gateway');
const hostedReleaseMode = args.includes('--hosted-release-mode');
const requireQualificationEphemeralAuth = args.includes('--require-qualification-ephemeral-auth');
const forbidQualificationEphemeralAuth = args.includes('--forbid-qualification-ephemeral-auth');
if (requireQualificationEphemeralAuth && forbidQualificationEphemeralAuth) {
  console.error(
    '[verify-package] FATAL: qualification ephemeral auth cannot be both required and forbidden'
  );
  process.exit(1);
}
const qualificationEphemeralAuthMode = requireQualificationEphemeralAuth ? 'required' : 'forbidden';
let expectedHostedGateway =
  expectedHostedGatewayIdx === -1 ? null : args[expectedHostedGatewayIdx + 1];

function requiredOptionValue(index, flag) {
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`[verify-package] FATAL: ${flag} requires a value`);
    process.exit(1);
  }
  return value;
}

const appRootArg = requiredOptionValue(appRootIdx, '--app-root');
const distDirArg = requiredOptionValue(distDirIdx, '--dist-dir');
const packagedIdentity = requiredOptionValue(identityIdx, '--identity');
const expectedSourceCommitArg = requiredOptionValue(
  expectedSourceCommitIdx,
  '--expected-source-commit'
);
const expectedVersionArg = requiredOptionValue(expectedVersionIdx, '--expected-version');
const expectedAppAsarSha256 = requiredOptionValue(
  expectedAppAsarSha256Idx,
  '--expected-app-asar-sha256'
);

if (appRootArg !== null && distDirArg !== null) {
  console.error('[verify-package] FATAL: --dist-dir cannot be combined with --app-root');
  process.exit(1);
}
if (appRootArg !== null) {
  if (packagedIdentity !== 'stable' && packagedIdentity !== 'validation') {
    console.error(
      '[verify-package] FATAL: --app-root requires --identity stable or --identity validation'
    );
    process.exit(1);
  }
  if (archArg === null) {
    console.error('[verify-package] FATAL: --app-root requires an explicit --arch');
    process.exit(1);
  }
  if (bundleStampOnlyIdx !== -1 || codexAppServerOnlyIdx !== -1 || stampOnly) {
    console.error(
      '[verify-package] FATAL: --app-root cannot be combined with another verifier mode'
    );
    process.exit(1);
  }
} else if (identityIdx !== -1 || expectedAppAsarSha256Idx !== -1) {
  console.error(
    '[verify-package] FATAL: --identity and --expected-app-asar-sha256 require --app-root'
  );
  process.exit(1);
}
if (expectedAppAsarSha256 !== null && !/^[0-9a-f]{64}$/.test(expectedAppAsarSha256)) {
  console.error('[verify-package] FATAL: --expected-app-asar-sha256 must be 64 lowercase hex');
  process.exit(1);
}

const UPDATE_AUTHORITY_FILE = path.join(__dirname, '..', 'update-authority.json');
const updateAuthority = JSON.parse(fs.readFileSync(UPDATE_AUTHORITY_FILE, 'utf8'));
const canonicalUpdateFeedBases = updateAuthority.stableFeedBases;
const canonicalUpdateFeedBase = canonicalUpdateFeedBases?.[0];
const requestedUpdateFeedBase = process.env.WAYPOINT_UPDATE_FEED_BASE?.replace(/\/+$/, '');

function isCanonicalAnonymousHttpsBase(base) {
  try {
    const url = new URL(base);
    const canonicalPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      base === `${url.origin}${canonicalPath}`
    );
  } catch {
    return false;
  }
}

if (
  updateAuthority.schemaVersion !== 2 ||
  !Array.isArray(canonicalUpdateFeedBases) ||
  canonicalUpdateFeedBases.length < 2 ||
  new Set(canonicalUpdateFeedBases).size !== canonicalUpdateFeedBases.length ||
  canonicalUpdateFeedBases.some((base) => !isCanonicalAnonymousHttpsBase(base)) ||
  typeof canonicalUpdateFeedBase !== 'string' ||
  canonicalUpdateFeedBase.length === 0
) {
  console.error('[verify-package] FATAL: update-authority.json is invalid');
  process.exit(1);
}
if (
  requireReleaseStamp &&
  requestedUpdateFeedBase !== undefined &&
  requestedUpdateFeedBase !== canonicalUpdateFeedBase
) {
  console.error('[verify-package] FATAL: release verification cannot override update authority');
  process.exit(1);
}
const expectedUpdateFeedAuthority = requestedUpdateFeedBase
  ? [requestedUpdateFeedBase]
  : canonicalUpdateFeedBases;

if (
  expectedHostedGatewayIdx !== -1 &&
  (!expectedHostedGateway || expectedHostedGateway.startsWith('--'))
) {
  console.error('[verify-package] FATAL: --expected-hosted-gateway requires an HTTPS origin');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '../../..');
let expectedSourceCommit = expectedSourceCommitArg ?? process.env.GITHUB_SHA ?? null;
if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit ?? '')) {
  try {
    expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    expectedSourceCommit = null;
  }
}
if (expectedSourceCommitArg !== null && !/^[0-9a-f]{40}$/.test(expectedSourceCommitArg)) {
  console.error('[verify-package] FATAL: --expected-source-commit must be 40 lowercase hex');
  process.exit(1);
}
const sourcePackageMetadata = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);
const expectedVersion = expectedVersionArg ?? sourcePackageMetadata.version;
if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
  console.error('[verify-package] FATAL: expected package version is missing');
  process.exit(1);
}
if (expectedHostedGatewayIdx !== -1 && forbidHostedGateway) {
  console.error(
    '[verify-package] FATAL: --expected-hosted-gateway and --forbid-hosted-gateway are mutually exclusive'
  );
  process.exit(1);
}
if (hostedReleaseMode && (expectedHostedGatewayIdx !== -1 || forbidHostedGateway)) {
  console.error(
    '[verify-package] FATAL: --hosted-release-mode cannot be combined with an explicit Hosted expectation'
  );
  process.exit(1);
}
if (hostedReleaseMode) {
  try {
    expectedHostedGateway = hostedGatewayExpectationFromEnv(process.env);
  } catch (error) {
    console.error(`[verify-package] FATAL: ${error.message}`);
    process.exit(1);
  }
}
if (
  requireQualificationEphemeralAuth &&
  (!requireReleaseStamp ||
    expectedSourceCommitArg === null ||
    expectedHostedGatewayIdx === -1 ||
    forbidHostedGateway ||
    (platformArg ?? process.platform) !== 'darwin')
) {
  console.error(
    '[verify-package] FATAL: qualification ephemeral auth requires darwin, an explicit source commit, the release stamp, and an exact Hosted gateway'
  );
  process.exit(1);
}

function hostedGatewayResult(mainBundle) {
  if (hostedReleaseMode || expectedHostedGatewayIdx !== -1) {
    return verifyHostedGatewayAuthority(mainBundle, expectedHostedGateway);
  }
  if (forbidHostedGateway) return verifyHostedGatewayAuthority(mainBundle, null);
  return null;
}

function hostedBundleProblems(mainBundle, rendererBundles, mainGraphBundle = mainBundle) {
  const authorityBundle = expectedHostedGateway === null ? mainGraphBundle : mainBundle;
  let hostedResult = hostedGatewayResult(authorityBundle);
  if (hostedResult?.ok && expectedHostedGateway !== null) {
    hostedResult = verifyHostedGatewayGraphAuthority(mainGraphBundle, expectedHostedGateway);
  }
  const problems =
    hostedResult && !hostedResult.ok
      ? []
      : hostedResult?.enabled
        ? releaseBHostedBundleProblems({
            mainBundle,
            rendererBundles,
            expectedGatewayOrigin: hostedResult.gatewayOrigin,
          })
        : releaseAAuthBundleProblems({
            mainBundle,
            rendererBundles,
            forbiddenHostedGatewayUrls: [process.env.DNAFORGE_HOSTED_AI_GATEWAY_URL],
          });
  return { hostedResult, problems };
}

function qualificationEntryResults(mainGraph) {
  if (qualificationEphemeralAuthMode !== 'required') return [];
  return [
    verifyReleaseBuildStamp(mainGraph.entryBuffer, true),
    verifySourceCommitStamp(mainGraph.entryBuffer, expectedSourceCommit),
    verifyQualificationEphemeralAuth(
      mainGraph.entryBuffer,
      expectedSourceCommit,
      qualificationEphemeralAuthMode
    ),
  ];
}

if (bundleStampOnlyIdx !== -1) {
  const bundlePathArg = args[bundleStampOnlyIdx + 1];
  if (!bundlePathArg || bundlePathArg.startsWith('--')) {
    console.error('[verify-package] FATAL: --bundle-stamp-only requires a main-bundle path');
    process.exit(1);
  }
  const bundlePath = path.resolve(process.cwd(), bundlePathArg);
  if (!fs.existsSync(bundlePath)) {
    console.error(`[verify-package] FATAL: main bundle not found at ${bundlePath}`);
    process.exit(1);
  }
  let mainGraph;
  try {
    mainGraph = readCompiledMainGraph(bundlePath);
  } catch (error) {
    console.error(`  ❌ could not verify compiled main-process graph: ${error.message}`);
    process.exit(1);
  }
  const mainBundle = mainGraph.entryBuffer;
  const stampResult = verifyReleaseBuildStamp(mainBundle, requireReleaseStamp);
  if (!stampResult.ok) {
    console.error(`  ❌ ${stampResult.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ${stampResult.message}`);
  const sourceResult = verifySourceCommitStamp(mainBundle, expectedSourceCommit);
  if (!sourceResult.ok) {
    console.error(`  ❌ ${sourceResult.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ${sourceResult.message}`);
  for (const entryResult of qualificationEntryResults(mainGraph)) {
    if (!entryResult.ok) {
      console.error(`  ❌ main entry authority: ${entryResult.message}`);
      process.exit(1);
    }
  }
  const qualificationAuthResult = verifyQualificationEphemeralAuth(
    mainGraph.buffer,
    expectedSourceCommit,
    qualificationEphemeralAuthMode
  );
  if (!qualificationAuthResult.ok) {
    console.error(`  ❌ ${qualificationAuthResult.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ${qualificationAuthResult.message}`);
  const updaterResult = verifyUpdateFeedAuthority(mainGraph.buffer, expectedUpdateFeedAuthority);
  if (!updaterResult.ok) {
    console.error(`  ❌ ${updaterResult.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ${updaterResult.message}`);
  const { hostedResult, problems } = hostedBundleProblems(mainBundle, undefined, mainGraph.buffer);
  if (hostedResult && !hostedResult.ok) {
    console.error(`  ❌ ${hostedResult.message}`);
    process.exit(1);
  }
  if (hostedResult) console.log(`  ✅ ${hostedResult.message}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ❌ ${problem}`);
    process.exit(1);
  }
  console.log('  ✅ packaged auth origin and Hosted-main policy are baked');
  try {
    requireOpenDataLoaderCompiledContract(mainGraph.buffer);
  } catch (error) {
    console.error(`  ❌ ${error.message}`);
    process.exit(1);
  }
  console.log('  ✅ OpenDataLoader compiled runtime contract is reachable');
  process.exit(0);
}

function normalizeArch(arch) {
  if (!arch) return null;
  if (arch === 'x64' || arch === 'arm64') return arch;
  if (arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

const hostArch = (() => {
  if (process.platform !== 'darwin') return normalizeArch(process.arch) || 'x64';
  try {
    const result = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
    return result.stdout.trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return normalizeArch(process.arch) || 'x64';
  }
})();

const targetArch = normalizeArch(archArg) || hostArch;
const targetPlatform = platformArg || (process.platform === 'win32' ? 'win32' : 'darwin');

if (!['darwin', 'win32'].includes(targetPlatform)) {
  console.error(
    `[verify-package] FATAL: unsupported --platform ${targetPlatform}. ` +
      'Expected darwin or win32.'
  );
  process.exit(1);
}

function sidecarDirName(platform, arch) {
  if (platform === 'win32') return 'waypoint-api-x86_64-pc-windows-msvc';
  return arch === 'arm64'
    ? 'waypoint-api-aarch64-apple-darwin'
    : 'waypoint-api-x86_64-apple-darwin';
}

function resolvePackageLayout(platform, arch) {
  if (platform === 'win32') {
    const appRoot = path.join(DIST, 'win-unpacked');
    return {
      appRoot,
      resourcesDir: path.join(appRoot, 'resources'),
      executable: path.join(appRoot, 'DNAForge.exe'),
      executableLabel: 'DNAForge.exe',
    };
  }

  const builderDirSuffix = arch === 'arm64' ? '-arm64' : '';
  const appRoot = path.join(DIST, `mac${builderDirSuffix}`, 'DNAForge.app');
  return {
    appRoot,
    resourcesDir: path.join(appRoot, 'Contents', 'Resources'),
    executable: path.join(appRoot, 'Contents', 'MacOS', 'DNAForge'),
    executableLabel: 'DNAForge.app executable',
  };
}

function resolveAppRootLayout(platform, rawAppRoot, identity) {
  const appRoot = path.resolve(process.cwd(), rawAppRoot);
  const executableName = identity === 'validation' ? 'DNAForge Validation' : 'DNAForge';
  if (platform === 'win32') {
    return {
      appRoot,
      resourcesDir: path.join(appRoot, 'resources'),
      executable: path.join(appRoot, `${executableName}.exe`),
      executableLabel: `${executableName}.exe`,
    };
  }
  return {
    appRoot,
    resourcesDir: path.join(appRoot, 'Contents', 'Resources'),
    executable: path.join(appRoot, 'Contents', 'MacOS', executableName),
    executableLabel: `${executableName}.app executable`,
  };
}

const DIST =
  distDirArg === null ? path.join(__dirname, '..', 'dist-electron') : path.resolve(distDirArg);
const LAYOUT =
  appRootArg === null
    ? resolvePackageLayout(targetPlatform, targetArch)
    : resolveAppRootLayout(targetPlatform, appRootArg, packagedIdentity);
const APP_DIR = LAYOUT.resourcesDir;
const ASAR = path.join(APP_DIR, 'app.asar');
const ASAR_UNPACKED = path.join(APP_DIR, 'app.asar.unpacked');
const MONOREPO_ROOT = path.join(__dirname, '..', '..', '..');
const BASELINE_FILE = path.join(__dirname, 'asar-packages-baseline.json');
let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
  passed++;
}

function fail(msg) {
  console.error(`  ❌ ${msg}`);
  failed++;
}

function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
}

const windowsSignatureResults = new Map();
const POWERSHELL_DIAGNOSTIC_LIMIT = 2_000;

function boundedPowerShellDiagnostic(value) {
  const text = String(value || '').trim();
  if (text.length <= POWERSHELL_DIAGNOSTIC_LIMIT) return text;
  return (
    `${text.slice(0, POWERSHELL_DIAGNOSTIC_LIMIT)}\n` +
    `[PowerShell output truncated: ${text.length - POWERSHELL_DIAGNOSTIC_LIMIT} characters omitted]`
  );
}

function windowsExecutableSignatureProblem(filePath) {
  if (process.platform !== 'win32') {
    return 'Authenticode verification requires the native Windows package runner';
  }
  if (windowsSignatureResults.has(filePath)) return windowsSignatureResults.get(filePath);

  const command = [
    '$ErrorActionPreference = "Stop";',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:DNAFORGE_AUTHENTICODE_PATH;',
    'if ($null -eq $signature) { throw "Get-AuthenticodeSignature returned no result" };',
    '$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "" };',
    '[ordered]@{ status = [string]$signature.Status; signerSubject = $subject } | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DNAFORGE_AUTHENTICODE_PATH: filePath },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const outputDetails =
    `PowerShell stdout: ${JSON.stringify(boundedPowerShellDiagnostic(stdout))}; ` +
    `PowerShell stderr: ${JSON.stringify(boundedPowerShellDiagnostic(stderr))}`;
  let problem = null;
  if (result.error || result.status !== 0) {
    problem = `PowerShell signature inspection failed${
      result.error ? `: ${result.error.message}` : ` with exit ${result.status}`
    }; ${outputDetails}`;
  } else {
    try {
      const proof = JSON.parse(stdout);
      if (proof.status !== 'Valid') {
        problem = `status ${JSON.stringify(proof.status)}; ${outputDetails}`;
      } else if (
        typeof proof.signerSubject !== 'string' ||
        !proof.signerSubject.includes('Humic Labs Inc.')
      ) {
        problem = `unexpected signer ${JSON.stringify(proof.signerSubject)}; ${outputDetails}`;
      }
    } catch (error) {
      problem = `unparseable PowerShell result: ${error.message}; ${outputDetails}`;
    }
  }
  windowsSignatureResults.set(filePath, problem);
  return problem;
}

if (codexAppServerOnlyIdx !== -1) {
  const resourcesDirArg = args[codexAppServerOnlyIdx + 1];
  if (!resourcesDirArg || resourcesDirArg.startsWith('--')) {
    console.error('[verify-package] FATAL: --codex-app-server-only requires a Resources directory');
    process.exit(1);
  }
  const manifestPath = path.join(
    MONOREPO_ROOT,
    'packages',
    'core',
    'codex-app-server-contract',
    'src',
    'manifest.json'
  );
  const codexManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problem = codexAppServerIntegrityProblem({
    platform: targetPlatform,
    arch: targetArch,
    resourcesDir: path.resolve(process.cwd(), resourcesDirArg),
    manifest: codexManifest,
    windowsExecutableSignatureProblem,
  });
  if (problem) {
    console.error(`  ❌ ${problem}`);
    process.exit(1);
  }
  console.log('  ✅ Codex App Server resource inventory is complete and digest-verified');
  process.exit(0);
}

function collectOpenDataLoaderHeadings(value, headings = []) {
  if (!value || typeof value !== 'object') return headings;
  if (value.type === 'heading' && typeof value.content === 'string') {
    headings.push(value.content.trim());
  }
  for (const key of ['kids', 'list items', 'rows', 'cells']) {
    if (!Array.isArray(value[key])) continue;
    for (const child of value[key]) collectOpenDataLoaderHeadings(child, headings);
  }
  return headings;
}

function openDataLoaderTreeBytes(root) {
  const metadata = fs.lstatSync(root);
  if (metadata.isSymbolicLink()) return 0;
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) {
    throw new Error(`parser runtime contains an unsupported filesystem entry: ${root}`);
  }
  return fs
    .readdirSync(root)
    .reduce((total, entry) => total + openDataLoaderTreeBytes(path.join(root, entry)), 0);
}

function openDataLoaderReleaseModules(release) {
  const match = /^MODULES="([^"]*)"$/mu.exec(release);
  return match?.[1]?.split(/\s+/u).filter(Boolean) ?? [];
}

function openDataLoaderExecutableModules(output) {
  return output
    .trim()
    .split(/\s+/u)
    .map((entry) => entry.split('@')[0])
    .filter(Boolean);
}

function sameStringSet(left, right) {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

function verifyOpenDataLoaderSemanticParse(javaPath, jarPath) {
  const fixturePath = path.join(
    MONOREPO_ROOT,
    'test-fixtures',
    'documents',
    'paper-protocol-synthetic.pdf'
  );
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`packaged parser fixture is missing: ${fixturePath}`);
  }
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-package-pdf-'));
  try {
    const parsed = spawnSync(
      javaPath,
      [
        '-Xms64m',
        '-Xmx1024m',
        '-XX:+ExitOnOutOfMemoryError',
        '-Djava.awt.headless=true',
        '-Dapple.awt.UIElement=true',
        '-jar',
        jarPath,
        fixturePath,
        '--output-dir',
        outputDirectory,
        '--format',
        'json',
        '--image-output',
        'off',
        '--reading-order',
        'xycut',
        '--table-method',
        'cluster',
        '--threads',
        '1',
        '--pages',
        '1,2',
        '--quiet',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      }
    );
    if (parsed.error || parsed.status !== 0) {
      throw new Error(
        `private parser failed its semantic fixture probe (status ${String(parsed.status)})`
      );
    }
    const jsonFiles = fs.readdirSync(outputDirectory).filter((name) => name.endsWith('.json'));
    if (jsonFiles.length !== 1) {
      throw new Error(`private parser emitted ${jsonFiles.length} JSON files; expected one`);
    }
    const document = JSON.parse(fs.readFileSync(path.join(outputDirectory, jsonFiles[0]), 'utf8'));
    const headings = collectOpenDataLoaderHeadings(document);
    const expectedHeadings = ['Protein Purification', 'Supplementary Table S3'];
    if (
      document['number of pages'] !== 2 ||
      !expectedHeadings.every((heading) => headings.includes(heading))
    ) {
      throw new Error(
        `private parser returned the wrong semantic fixture result: pages=${String(document['number of pages'])}, headings=${headings.join(' | ')}`
      );
    }
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function bundledBinaryExists(resourcesDir, binName) {
  const candidates = [path.join(resourcesDir, binName)];
  if (targetPlatform === 'win32') {
    candidates.push(
      path.join(resourcesDir, `${binName}.exe`),
      path.join(resourcesDir, `${binName}.bat`),
      path.join(resourcesDir, `${binName}.cmd`)
    );
    if (binName === 'mafft') {
      candidates.push(path.join(resourcesDir, 'mafft-win'));
    }
  } else if (binName === 'mafft') {
    candidates.push(path.join(resourcesDir, 'mafft-mac'));
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function resolveNodeBin(name) {
  const basePath = path.join(MONOREPO_ROOT, 'node_modules', '.bin', name);
  const candidates =
    process.platform === 'win32'
      ? [`${basePath}.cmd`, `${basePath}.CMD`, `${basePath}.exe`, `${basePath}.EXE`, basePath]
      : [basePath];
  return candidates.find((candidate) => fs.existsSync(candidate)) || name;
}

function resolveAsarCommand() {
  const asarJs = path.join(MONOREPO_ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  if (fs.existsSync(asarJs)) {
    return { command: process.execPath, args: [asarJs] };
  }
  return { command: resolveNodeBin('asar'), args: [] };
}

function resolveApiProbePython() {
  const apiDir = path.join(MONOREPO_ROOT, 'apps', 'api');
  const environments = [path.join(apiDir, '.venv'), process.env.VIRTUAL_ENV].filter(Boolean);
  const candidates = environments.flatMap((environment) =>
    process.platform === 'win32'
      ? [path.join(environment, 'Scripts', 'python.exe')]
      : [path.join(environment, 'bin', 'python3'), path.join(environment, 'bin', 'python')]
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function describeNativeBinary(binaryPath) {
  return describeTargetBinary(binaryPath, { platform: targetPlatform, arch: targetArch });
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectInstalledPackageEntries(root) {
  const entries = [];
  const visit = (directory, relativeDirectory) => {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!child.isFile() && !child.isSymbolicLink()) {
        throw new Error(`installed package contains an unsupported entry type: ${relative}`);
      }
      entries.push({
        path: relative,
        bytes: fs.lstatSync(absolute).size,
        kind: child.isSymbolicLink() ? 'symlink' : 'file',
      });
    }
  };
  visit(root, '');
  return entries;
}

function verifyPackageComposition({ writeReceipt }) {
  try {
    const installedPackage = installedPackageCompositionReceipt(
      collectInstalledPackageEntries(LAYOUT.appRoot)
    );
    const compositionReceipt = {
      ...packageCompositionReceipt(getRawHeader(ASAR)),
      archiveBytes: fs.statSync(ASAR).size,
      installedPackage,
    };
    const problems = [
      ...packageCompositionProblems(compositionReceipt),
      ...installedPackageCompositionProblems(installedPackage, targetPlatform),
    ];
    const categorySummary = compositionReceipt.categories
      .map((category) => `${category.name}=${(category.bytes / 1024 / 1024).toFixed(1)} MiB`)
      .join(', ');
    console.log(`  → package composition: ${categorySummary}`);
    const installedCategorySummary = installedPackage.categories
      .map((category) => `${category.name}=${(category.bytes / 1024 / 1024).toFixed(1)} MiB`)
      .join(', ');
    console.log(`  → installed application composition: ${installedCategorySummary}`);
    for (const problem of problems) fail(problem);
    if (problems.length === 0) {
      ok(
        `package composition is within reviewed limits ` +
          `(${(compositionReceipt.archiveBytes / 1024 / 1024).toFixed(1)} MiB app.asar, ` +
          `${(installedPackage.totalBytes / 1024 / 1024).toFixed(1)} MiB installed)`
      );
    }
    if (writeReceipt) {
      const receiptPath = path.join(
        DIST,
        `package-composition-${targetPlatform}-${targetArch}.json`
      );
      const boundReceipt = {
        ...compositionReceipt,
        platform: targetPlatform,
        arch: targetArch,
        appAsarSha256: sha256File(ASAR),
      };
      const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(boundReceipt, null, 2)}\n`, {
        flag: 'wx',
      });
      fs.renameSync(temporaryPath, receiptPath);
      ok(`package composition receipt written to ${path.relative(process.cwd(), receiptPath)}`);
    }
  } catch (error) {
    fail(`could not verify package composition: ${error.message}`);
  }
}

function verifyInstalledAppRoot() {
  console.log(
    `\n[verify-package] Checking ${packagedIdentity} installed app ` +
      `(platform: ${targetPlatform}, arch: ${targetArch})\n`
  );

  const requiredPaths = [
    ['application root', LAYOUT.appRoot],
    [LAYOUT.executableLabel, LAYOUT.executable],
    ['Resources directory', APP_DIR],
    ['app.asar', ASAR],
    ['app-update.yml', path.join(APP_DIR, 'app-update.yml')],
  ];
  for (const [label, requiredPath] of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      fail(`${label} is missing: ${requiredPath}`);
    }
  }
  if (failed > 0) {
    console.error('[verify-package] ❌ Installed app verification FAILED\n');
    process.exit(1);
  }

  try {
    ok(
      `${LAYOUT.executableLabel} executable architecture is ${targetArch} ` +
        `(${describeNativeBinary(LAYOUT.executable)})`
    );
  } catch (error) {
    fail(`could not verify installed executable architecture: ${error.message}`);
  }

  const appAsarSha256 = sha256File(ASAR);
  if (expectedAppAsarSha256 !== null && appAsarSha256 !== expectedAppAsarSha256) {
    fail(`app.asar SHA-256 ${appAsarSha256} does not match expected ${expectedAppAsarSha256}`);
  } else {
    ok(
      expectedAppAsarSha256 === null
        ? 'app.asar bytes were hashed for downstream binding'
        : 'app.asar bytes match the expected upstream artifact'
    );
  }

  verifyPackageComposition({ writeReceipt: false });

  let mainBundle = null;
  let mainGraph = null;
  let packageMetadata = null;
  try {
    const archiveEntries = listPackage(ASAR, { isPack: false });
    packageMetadata = JSON.parse(
      extractFile(ASAR, resolveAsarEntryPath(archiveEntries, 'package.json')).toString('utf8')
    );
    mainGraph = extractPackagedMainGraph(ASAR, archiveEntries, packageMetadata.main);
    mainBundle = mainGraph.buffer;
    const receiptProblems = releaseSourceReceiptProblems(archiveEntries, (entry) =>
      extractFile(ASAR, entry.replace(/^[\\/]+/, '')).toString('utf8')
    );
    for (const problem of receiptProblems) fail(problem);
    if (receiptProblems.length === 0) ok('release bundle boundary receipts are present and clean');
    ok('exact installed app.asar reachable main-process graph and package metadata were extracted');
  } catch (error) {
    fail(`could not inspect installed app.asar: ${error.message}`);
  }

  if (mainBundle !== null) {
    const stampResult = verifyReleaseBuildStamp(mainBundle, packagedIdentity === 'stable');
    if (stampResult.ok) ok(stampResult.message);
    else fail(stampResult.message);

    if (expectedSourceCommit === null) {
      fail('expected source commit could not be resolved');
    } else {
      const sourceResult = verifySourceCommitStamp(mainBundle, expectedSourceCommit);
      if (sourceResult.ok) ok(sourceResult.message);
      else fail(sourceResult.message);
    }

    for (const entryResult of qualificationEntryResults(mainGraph)) {
      if (!entryResult.ok) fail(`main entry authority: ${entryResult.message}`);
    }

    const qualificationAuthResult = verifyQualificationEphemeralAuth(
      mainBundle,
      expectedSourceCommit,
      qualificationEphemeralAuthMode
    );
    if (qualificationAuthResult.ok) ok(qualificationAuthResult.message);
    else fail(qualificationAuthResult.message);

    const updaterResult = verifyUpdateFeedAuthority(mainBundle, canonicalUpdateFeedBases);
    if (updaterResult.ok) ok(updaterResult.message);
    else fail(updaterResult.message);
  }

  let updateConfig = null;
  try {
    updateConfig = parseYaml(fs.readFileSync(path.join(APP_DIR, 'app-update.yml'), 'utf8'));
    ok('app-update.yml decoded from the installed app');
  } catch (error) {
    fail(`could not decode installed app-update.yml: ${error.message}`);
  }

  let plist = null;
  let packagedIconSha256 = null;
  let packagedIconSize = null;
  let expectedIconSha256 = null;
  if (targetPlatform === 'darwin') {
    const plistPath = path.join(LAYOUT.appRoot, 'Contents', 'Info.plist');
    const packagedIconPath = path.join(APP_DIR, 'icon.icns');
    const expectedIconPath = path.join(__dirname, '..', 'resources', 'icon.icns');
    try {
      plist = JSON.parse(
        execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
          encoding: 'utf8',
        })
      );
      ok('Info.plist decoded from the installed app');
    } catch (error) {
      fail(`could not decode installed Info.plist: ${error.message}`);
    }
    try {
      packagedIconSize = fs.statSync(packagedIconPath).size;
      packagedIconSha256 = sha256File(packagedIconPath);
      expectedIconSha256 = sha256File(expectedIconPath);
      ok('installed icon.icns bytes were hashed against the production icon authority');
    } catch (error) {
      fail(`could not inspect installed icon.icns: ${error.message}`);
    }
  }

  if (packageMetadata !== null && updateConfig !== null) {
    let identityProblems = [];
    try {
      identityProblems = installedAppIdentityProblems({
        identity: packagedIdentity,
        platform: targetPlatform,
        appRoot: LAYOUT.appRoot,
        expectedVersion,
        executableName: path.basename(LAYOUT.executable),
        packageMetadata,
        plist,
        updateConfig,
        packagedIconSha256,
        expectedIconSha256,
        packagedIconSize,
      });
    } catch (error) {
      identityProblems = [error.message];
    }
    if (identityProblems.length === 0) {
      ok(`installed app identity is ${packagedIdentity}`);
    } else {
      for (const problem of identityProblems) fail(problem);
    }
  }

  console.log(`  appAsarSha256=${appAsarSha256}`);
  console.log(`\n[verify-package] ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error('[verify-package] ❌ Installed app verification FAILED\n');
    process.exit(1);
  }
  console.log('[verify-package] ✅ Installed app identity and updater authority are valid\n');
  process.exit(0);
}

function inspectNativeCoveragePackageContract(helperPath, packagedHelperSchema) {
  if (targetArch !== hostArch) {
    return {
      problem:
        `native coverage contract probe requires a matching host architecture ` +
        `(host ${hostArch}, target ${targetArch})`,
    };
  }

  const sidecarRoot = path.join(APP_DIR, 'binaries', sidecarDirName(targetPlatform, targetArch));
  if (!fs.existsSync(sidecarRoot)) {
    return { problem: `packaged sidecar is missing: ${sidecarRoot}` };
  }
  const sidecarExecutable = fs.statSync(sidecarRoot).isFile()
    ? sidecarRoot
    : path.join(sidecarRoot, targetPlatform === 'win32' ? 'waypoint-api.exe' : 'waypoint-api');
  if (!fs.existsSync(sidecarExecutable)) {
    return { problem: `packaged sidecar executable is missing: ${sidecarExecutable}` };
  }

  const apiDir = path.join(MONOREPO_ROOT, 'apps', 'api');
  const sourceEntry = path.join(apiDir, 'run_server.py');
  const sourcePythonCandidates =
    process.platform === 'win32'
      ? [
          path.join(apiDir, '.venv', 'Scripts', 'python.exe'),
          path.join(apiDir, '.venv', 'Scripts', 'python3.exe'),
        ]
      : [path.join(apiDir, '.venv', 'bin', 'python'), path.join(apiDir, '.venv', 'bin', 'python3')];
  const sourcePython = sourcePythonCandidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePython) {
    return {
      problem:
        `source sidecar Python is missing (${sourcePythonCandidates.join(', ')}); ` +
        `build-sidecar.sh must run before full package verification`,
    };
  }

  const env = {
    ...process.env,
    DNA_COVERAGE_PATH: helperPath,
  };
  const runProbe = (command, probeArgs, cwd, label) => {
    const result = spawnSync(command, probeArgs, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    const stderr = String(result.stderr || '').trim();
    if (result.error || result.status !== 0) {
      throw new Error(
        `${label} failed (status ${String(result.status)}): ` +
          `${result.error ? result.error.message : stderr || 'no diagnostic output'}`
      );
    }
    return parseNativeCoverageContractProbe(String(result.stdout || ''), label);
  };

  try {
    const sourceContract = runProbe(
      sourcePython,
      [sourceEntry, '--print-native-coverage-contract'],
      apiDir,
      'current source native-coverage probe'
    );
    const packagedContract = runProbe(
      sidecarExecutable,
      ['--print-native-coverage-contract'],
      path.dirname(sidecarExecutable),
      'frozen sidecar native-coverage probe'
    );
    const packagedHelperSha256 = sha256File(helperPath);
    const problem = nativeCoverageContractProblem({
      sourceContract,
      packagedContract,
      packagedHelperSha256,
      packagedHelperSchema,
    });
    return {
      problem,
      cacheContract: packagedContract.cacheContract,
      engineIdentity: packagedContract.engineIdentity,
    };
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

if (appRootArg !== null) verifyInstalledAppRoot();

console.log(
  `\n[verify-package] Checking packaged app (platform: ${targetPlatform}, arch: ${targetArch})\n`
);

if (fs.existsSync(LAYOUT.executable)) {
  ok(`${LAYOUT.executableLabel} found at ${path.relative(process.cwd(), LAYOUT.executable)}`);
} else {
  fail(`${LAYOUT.executableLabel} not found at ${path.relative(process.cwd(), LAYOUT.executable)}`);
}

if (targetPlatform === 'darwin') {
  const registry = loadFileAssociationRegistry(path.resolve(__dirname, '..'));
  const projected = projectMacAssociationMetadata(registry);
  const plistPath = path.join(LAYOUT.appRoot, 'Contents', 'Info.plist');

  try {
    const plist = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
      })
    );
    const metadataChecks = [
      ['CFBundleDocumentTypes', projected.documentTypes],
      ['UTExportedTypeDeclarations', projected.exportedTypes],
      ['UTImportedTypeDeclarations', projected.importedTypes],
    ];
    for (const [key, expected] of metadataChecks) {
      if (isDeepStrictEqual(plist[key], expected)) {
        ok(`Info.plist ${key} matches the file-association registry`);
      } else {
        fail(`Info.plist ${key} does not match resources/file-associations.json`);
      }
    }
  } catch (error) {
    fail(`could not inspect packaged file-association metadata: ${error.message}`);
  }

  const associationHelperPath = path.join(
    LAYOUT.appRoot,
    'Contents',
    'Helpers',
    'dnaforge-file-association'
  );
  if (!fs.existsSync(associationHelperPath)) {
    fail(
      `macOS file-association helper missing: ${path.relative(process.cwd(), associationHelperPath)}`
    );
  } else {
    const stat = fs.statSync(associationHelperPath);
    const prefix = stat.isFile()
      ? fs.readFileSync(associationHelperPath).subarray(0, 256)
      : Buffer.alloc(0);
    const integrityProblem = packagedHelperIntegrityProblem(stat, prefix, targetPlatform);
    if (integrityProblem) {
      fail(`macOS file-association helper ${integrityProblem}: ${associationHelperPath}`);
    } else {
      ok('macOS file-association helper is a compiled executable');
      try {
        ok(
          `macOS file-association helper architecture is ${targetArch} ` +
            `(${describeNativeBinary(associationHelperPath)})`
        );
      } catch (error) {
        fail(`could not verify macOS file-association helper architecture: ${error.message}`);
      }
    }
  }
}

if (!fs.existsSync(ASAR)) {
  console.error(`[verify-package] FATAL: app.asar not found at ${ASAR}`);
  console.error('  Did you run `npm run package` first?');
  process.exit(1);
}
ok(`app.asar found at ${path.relative(process.cwd(), ASAR)}`);
verifyPackageComposition({ writeReceipt: true });

let packagedMainBundle = null;
let packagedMainGraph = null;
try {
  const archiveEntries = listPackage(ASAR, { isPack: false });
  const packageMetadata = JSON.parse(
    extractFile(ASAR, resolveAsarEntryPath(archiveEntries, 'package.json')).toString('utf8')
  );
  packagedMainGraph = extractPackagedMainGraph(ASAR, archiveEntries, packageMetadata.main);
  packagedMainBundle = packagedMainGraph.entryBuffer;
  const receiptProblems = releaseSourceReceiptProblems(archiveEntries, (entry) =>
    extractFile(ASAR, entry.replace(/^[\\/]+/, '')).toString('utf8')
  );
  for (const problem of receiptProblems) fail(problem);
  if (receiptProblems.length === 0) ok('release bundle boundary receipts are present and clean');
  const stampResult = verifyReleaseBuildStamp(packagedMainBundle, requireReleaseStamp);
  if (stampResult.ok) {
    ok(stampResult.message);
  } else {
    fail(stampResult.message);
  }
  const sourceResult = verifySourceCommitStamp(packagedMainBundle, expectedSourceCommit);
  if (sourceResult.ok) {
    ok(sourceResult.message);
  } else {
    fail(sourceResult.message);
  }
  for (const entryResult of qualificationEntryResults(packagedMainGraph)) {
    if (!entryResult.ok) fail(`main entry authority: ${entryResult.message}`);
  }
  const qualificationAuthResult = verifyQualificationEphemeralAuth(
    packagedMainGraph.buffer,
    expectedSourceCommit,
    qualificationEphemeralAuthMode
  );
  if (qualificationAuthResult.ok) {
    ok(qualificationAuthResult.message);
  } else {
    fail(qualificationAuthResult.message);
  }
  const updaterResult = verifyUpdateFeedAuthority(
    packagedMainGraph.buffer,
    expectedUpdateFeedAuthority
  );
  if (updaterResult.ok) {
    ok(updaterResult.message);
  } else {
    fail(updaterResult.message);
  }
  const rendererEntries = archiveEntries.filter((entry) => {
    const canonical = entry.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return canonical.startsWith('out/renderer/assets/') && canonical.endsWith('.js');
  });
  const tutorialMediaEntries = archiveEntries
    .map((entry) => entry.replace(/^[\\/]+/, '').replace(/\\/g, '/'))
    .filter(
      (entry) =>
        entry.startsWith('out/renderer/assets/benchling-export-flow-') && entry.endsWith('.mp4')
    );
  if (
    tutorialMediaEntries.length === 1 &&
    fs.existsSync(path.join(ASAR_UNPACKED, tutorialMediaEntries[0]))
  ) {
    ok('Benchling tutorial media is unpacked for Chromium byte-range playback');
  } else {
    fail(
      'Benchling tutorial media must exist exactly once under app.asar.unpacked/out/renderer/assets'
    );
  }
  const rendererBundles = rendererEntries.map((entry) =>
    extractFile(ASAR, entry.replace(/^[\\/]+/, ''))
  );
  const { hostedResult, problems } = hostedBundleProblems(
    packagedMainBundle,
    rendererBundles,
    packagedMainGraph.buffer
  );
  if (hostedResult?.ok) {
    ok(hostedResult.message);
  } else if (hostedResult) {
    fail(hostedResult.message);
  }
  if (problems.length === 0) {
    ok('packaged auth origin and Hosted renderer policy match the selected release mode');
  } else {
    for (const problem of problems) fail(problem);
  }
} catch (error) {
  fail(`could not inspect packaged auth and Hosted policy: ${error.message}`);
}

try {
  if (!packagedMainGraph) throw new Error('compiled main-process graph is unavailable');
  const manifest = requireOpenDataLoaderCompiledContract(packagedMainGraph.buffer);
  const parserTarget = `${targetPlatform}-${targetArch}`;
  const expectedRuntime = manifest.runtime.targets[parserTarget];
  if (!expectedRuntime) {
    throw new Error(`no pinned runtime is declared for ${parserTarget}`);
  }
  const parserRoot = path.join(APP_DIR, 'binaries', 'opendataloader-pdf');
  const targetRoot = path.join(parserRoot, parserTarget);
  const javaPath = path.join(
    targetRoot,
    'runtime',
    'bin',
    targetPlatform === 'win32' ? 'java.exe' : 'java'
  );
  const jarPath = path.join(targetRoot, 'opendataloader-pdf-cli.jar');
  const receiptPath = path.join(targetRoot, 'runtime-receipt.json');
  const releasePath = path.join(targetRoot, 'runtime', 'release');
  for (const requiredPath of [javaPath, jarPath, receiptPath, releasePath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(
        `required parser asset is missing: ${path.relative(process.cwd(), requiredPath)}`
      );
    }
  }
  const bundledTargets = fs
    .readdirSync(parserRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (bundledTargets.length !== 1 || bundledTargets[0] !== parserTarget) {
    throw new Error(
      `parser runtime targets must contain only ${parserTarget}; found ${bundledTargets.join(', ') || 'none'}`
    );
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const image = manifest.runtime.image;
  const runtimeRoot = path.join(targetRoot, 'runtime');
  const runtimeImageBytes = openDataLoaderTreeBytes(runtimeRoot);
  const expectedReceipt = {
    target: parserTarget,
    parserName: manifest.parser.name,
    parserPackage: manifest.parser.package,
    parserVersion: manifest.parser.version,
    parserJarSha256: manifest.parser.jarSha256,
    parserMode: manifest.parser.mode,
    parserConfiguration: manifest.parser.configuration,
    parserContractMarker: manifest.parser.contractMarker,
    runtimeVendor: manifest.runtime.vendor,
    runtimeVersion: manifest.runtime.version,
    runtimeVersionOutput: manifest.runtime.versionOutput,
    runtimeImageMode: image.mode,
    runtimeToolchainSha256: expectedRuntime.sha256,
    runtimeModuleRoots: image.moduleRoots,
    runtimeResolvedModules: image.resolvedModules,
    runtimeJlinkOptions: image.options,
    runtimeImageBytes,
  };
  const receiptDrift = Object.keys(expectedReceipt).filter(
    (key) => key !== 'runtimeImageBytes' && !isDeepStrictEqual(receipt[key], expectedReceipt[key])
  );
  if (receiptDrift.length > 0) {
    throw new Error(
      'packaged parser receipt does not match the pinned runtime manifest: ' +
        receiptDrift
          .map(
            (key) =>
              `${key} (receipt ${JSON.stringify(receipt[key])}, expected ${JSON.stringify(expectedReceipt[key])})`
          )
          .join('; ')
    );
  }
  if (runtimeImageBytes > image.maxBytes) {
    throw new Error(
      `private Java runtime is ${runtimeImageBytes} bytes; budget is ${image.maxBytes}`
    );
  }
  const jarSha256 = sha256File(jarPath);
  if (jarSha256 !== manifest.parser.jarSha256) {
    throw new Error(
      `OpenDataLoader JAR checksum mismatch: expected ${manifest.parser.jarSha256}, got ${jarSha256}`
    );
  }
  const release = fs.readFileSync(releasePath, 'utf8');
  if (!release.includes(`JAVA_RUNTIME_VERSION="${manifest.runtime.version}"`)) {
    throw new Error(`private Java runtime is not Temurin ${manifest.runtime.version}`);
  }
  const releaseModules = openDataLoaderReleaseModules(release);
  if (!sameStringSet(releaseModules, image.resolvedModules)) {
    throw new Error(
      `private Java runtime module drift: expected ${image.resolvedModules.join(', ')}, ` +
        `got ${releaseModules.join(', ')}`
    );
  }
  const parserProbeIsNative = targetPlatform === process.platform && targetArch === hostArch;
  if (parserProbeIsNative) {
    const javaVersion = spawnSync(javaPath, ['-version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    });
    const versionOutput = `${javaVersion.stdout || ''}\n${javaVersion.stderr || ''}`;
    if (
      javaVersion.error ||
      javaVersion.status !== 0 ||
      !versionOutput.includes(manifest.runtime.versionOutput)
    ) {
      throw new Error(
        `private Java runtime failed its executable version probe (status ${String(javaVersion.status)})`
      );
    }
    const javaModules = spawnSync(javaPath, ['--list-modules'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    });
    const executableModules = openDataLoaderExecutableModules(String(javaModules.stdout || ''));
    if (
      javaModules.error ||
      javaModules.status !== 0 ||
      !sameStringSet(executableModules, image.resolvedModules)
    ) {
      throw new Error(
        `private Java runtime executable module probe failed (status ${String(javaModules.status)})`
      );
    }
    verifyOpenDataLoaderSemanticParse(javaPath, jarPath);
  } else {
    warn(
      `skipping executable parser probe for non-native ${parserTarget} on ${process.platform}-${hostArch}`
    );
  }
  ok(
    `OpenDataLoader ${manifest.parser.version} and ${image.resolvedModules.length}-module private Temurin ${manifest.runtime.version} runtime match ${parserTarget}` +
      (parserProbeIsNative ? '; semantic fixture parsed with packaged bytes' : '')
  );
} catch (error) {
  fail(`packaged OpenDataLoader runtime is invalid: ${error.message}`);
}

if (stampOnly) {
  console.log(`\n[verify-package] ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error('[verify-package] ❌ Packaged release-stamp verification FAILED\n');
    process.exit(1);
  }
  console.log('[verify-package] ✅ Packaged release stamp is valid\n');
  process.exit(0);
}

const OBSOLETE_MCP_COMPANION = path.join(APP_DIR, 'agent-mcp-stdio.cjs');
if (fs.existsSync(OBSOLETE_MCP_COMPANION)) {
  fail(
    `obsolete standalone MCP companion is still bundled: ${path.relative(
      process.cwd(),
      OBSOLETE_MCP_COMPANION
    )}.\n` +
      '       Remove it from electron-builder extraResources; waypoint-api --mcp-stdio is canonical.'
  );
} else {
  ok('obsolete agent-mcp-stdio.cjs is absent; waypoint-api owns MCP stdio');
}

const sqlitePackageDirectory = path.join(ASAR_UNPACKED, 'node_modules', 'better-sqlite3');
const sqlitePrebuild = path.join(
  sqlitePackageDirectory,
  'prebuilds',
  `${targetPlatform}-${targetArch}.node`
);
const nodeBinary = fs.existsSync(sqlitePrebuild)
  ? sqlitePrebuild
  : path.join(sqlitePackageDirectory, 'build', 'Release', 'better_sqlite3.node');
const packagedSqliteModule = path.join(APP_DIR, 'app.asar', 'node_modules', 'better-sqlite3');

if (fs.existsSync(nodeBinary)) {
  ok('better_sqlite3.node binary found in asar.unpacked');
} else {
  fail(`better_sqlite3.node not found at ${path.relative(process.cwd(), nodeBinary)}`);
}

if (fs.existsSync(nodeBinary)) {
  try {
    ok(`binary architecture is ${targetArch} (${describeNativeBinary(nodeBinary)})`);
  } catch (e) {
    fail(`could not verify binary architecture: ${e.message}`);
  }
}

if (fs.existsSync(nodeBinary) && targetArch === hostArch) {
  let electronPath = null;
  try {
    const resolved = require(path.join(MONOREPO_ROOT, 'node_modules', 'electron'));
    if (typeof resolved === 'string') electronPath = resolved;
  } catch {}

  if (!electronPath || !fs.existsSync(electronPath)) {
    warn('could not locate the Electron binary — skipping ABI load check');
  } else {
    const probe =
      `try { const Database = require(${JSON.stringify(packagedSqliteModule)}); ` +
      `const db = new Database(':memory:', { nativeBinding: ${JSON.stringify(nodeBinary)} }); ` +
      `db.prepare('SELECT 1').get(); db.close(); } ` +
      `catch (e) { process.stderr.write('ABI_PROBE_FAIL ' + (e && e.message ? e.message : String(e))); process.exit(3); } ` +
      `process.exit(0);`;
    const res = spawnSync(electronPath, ['-e', probe], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!res.error && res.status === 0) {
      ok('better_sqlite3.node loads under the Electron ABI (NODE_MODULE_VERSION match)');
    } else if (isAbiError(out)) {
      const abiLine =
        out.split('\n').find((line) => line.includes('NODE_MODULE_VERSION')) ||
        out.trim().split('\n').pop() ||
        '';
      fail(
        'better_sqlite3.node is the WRONG Node/Electron ABI — it will crash the shipped\n' +
          '       app at launch. The pre-package rebuild produced or copied a binary\n' +
          `       built for the wrong runtime. ${abiLine.trim()}`
      );
    } else {
      warn(
        `could not run the Electron ABI load check (inconclusive, exit ${res.status}); arch check still applied`
      );
    }
  }
} else if (fs.existsSync(nodeBinary)) {
  console.log(
    `  ⓘ skipping Electron ABI load check (cross-arch build: target ${targetArch} != host ${hostArch})`
  );
}

console.log('\n  [check 4] Verifying packaged runtime dependencies...');

let baselinePackages = null;
if (!fs.existsSync(BASELINE_FILE)) {
  warn(
    'No baseline file found at scripts/asar-packages-baseline.json — skipping regression check.'
  );
  warn('Run: node scripts/update-asar-baseline.cjs');
} else {
  try {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    baselinePackages = new Set(baseline.packages);
    console.log(`  → baseline: ${baseline.count} packages`);
  } catch (e) {
    warn(`Could not read baseline file: ${e.message}`);
  }
}

let asarPackages = null;
try {
  const asar = resolveAsarCommand();
  const asarList = execFileSync(asar.command, [...asar.args, 'list', ASAR], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const packageJsonRe = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/;
  asarPackages = new Set();
  for (const line of asarList.split('\n')) {
    const m = line.trim().replace(/\\/g, '/').match(packageJsonRe);
    if (m) asarPackages.add(m[1]);
  }

  console.log(`  → this build: ${asarPackages.size} packages`);
} catch (e) {
  warn(`Could not enumerate asar contents: ${e.message}`);
}

if (asarPackages !== null) {
  const packagePolicy = asarPackageInventoryPolicy(asarPackages, baselinePackages);
  if (packagePolicy.blockingProblems.length === 0) {
    ok('all boot-critical runtime packages are present in app.asar');
  } else {
    for (const problem of packagePolicy.blockingProblems) fail(problem);
  }

  if (baselinePackages !== null) {
    if (packagePolicy.informationalRemovals.length === 0) {
      ok(`all ${baselinePackages.size} baseline packages present in asar`);
    } else {
      warn(
        `${packagePolicy.informationalRemovals.length} historical package(s) are no longer ` +
          `present in app.asar:\n` +
          packagePolicy.informationalRemovals.map((p) => `       - ${p}`).join('\n')
      );
      console.log(
        '  ⓘ Historical inventory removals are informational; explicit boot-critical ' +
          'dependencies and packaged runtime smoke remain blocking.'
      );
    }
  }
}

const RESOURCES_DIR = path.join(APP_DIR, 'binaries');
const EXPECTED_BINARIES =
  targetPlatform === 'win32'
    ? ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'cmpress', 'mafft']
    : ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'mafft'];

if (skipSidecarCheck) {
  console.log('\n  [check 5] Skipped (--skip-sidecar-check): sidecar + bioinformatics binaries');
} else if (fs.existsSync(RESOURCES_DIR)) {
  console.log('\n  [check 5] Verifying sidecar and bioinformatics binaries...');
  const sidecarPattern = sidecarDirName(targetPlatform, targetArch);
  const sidecarPath = path.join(RESOURCES_DIR, sidecarPattern);
  const sidecarExecutableName = targetPlatform === 'win32' ? 'waypoint-api.exe' : 'waypoint-api';
  const sidecarExecutable = path.join(sidecarPath, sidecarExecutableName);
  const packagedBinaryEntries = fs.readdirSync(RESOURCES_DIR, { withFileTypes: true });
  const sidecarLayoutProblem = sidecarBundleProblem(packagedBinaryEntries, sidecarPattern);
  if (sidecarLayoutProblem) {
    fail(sidecarLayoutProblem);
  } else {
    ok(`exactly one target sidecar artifact is bundled: ${sidecarPattern}`);
  }
  const sidecarExists =
    fs.existsSync(sidecarPath) &&
    fs.statSync(sidecarPath).isDirectory() &&
    fs.existsSync(sidecarExecutable) &&
    fs.statSync(sidecarExecutable).isFile();
  if (sidecarExists) {
    ok(`sidecar binary found: ${sidecarPattern}`);

    const sidecarReceiptProblems = receiptProblems({
      repoRoot,
      sidecarDir: sidecarPath,
      target: sidecarPattern.replace(/^waypoint-api-/, ''),
      verifyExecutableHash: false,
    });
    if (sidecarReceiptProblems.length === 0) {
      ok('packaged sidecar receipt matches current source and shipping Python');
    } else {
      for (const problem of sidecarReceiptProblems) fail(problem);
    }

    const packagedSidecar = sidecarExecutable;
    const mcpProbe = spawnSync(packagedSidecar, ['--mcp-stdio'], {
      cwd: path.dirname(packagedSidecar),
      encoding: 'utf8',
      input: '',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    const mcpStdioProblem = mcpStdioProbeProblem({
      status: mcpProbe.status,
      stdout: String(mcpProbe.stdout || ''),
      stderr: String(mcpProbe.stderr || ''),
      error: mcpProbe.error,
    });
    if (mcpStdioProblem) {
      fail(`${mcpStdioProblem}: ${path.relative(process.cwd(), packagedSidecar)}`);
    } else {
      ok('packaged waypoint-api imports and exits its MCP stdio transport cleanly');
    }

    const probePython = resolveApiProbePython();
    const jobsProbeScript = path.join(
      MONOREPO_ROOT,
      'apps',
      'api',
      'scripts',
      'verify_packaged_jobs.py'
    );
    if (!probePython || !fs.existsSync(jobsProbeScript)) {
      fail('packaged Jobs probe is unavailable');
    } else {
      const cliLauncher = path.join(
        APP_DIR,
        'cli',
        targetPlatform === 'win32' ? 'dnaforge.cmd' : 'dnaforge'
      );
      const jobsProbe = spawnSync(
        probePython,
        [jobsProbeScript, packagedSidecar, '--launcher', cliLauncher],
        {
          cwd: path.dirname(packagedSidecar),
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 150_000,
        }
      );
      if (jobsProbe.error || jobsProbe.status !== 0) {
        const details = `${jobsProbe.stdout || ''}\n${jobsProbe.stderr || ''}`.trim();
        fail(`packaged Jobs command probe failed: ${jobsProbe.error?.message || details}`);
      } else {
        ok(
          'bundled and explicitly installed DNAForge commands expose Jobs without an implicit runtime'
        );
      }
    }
    const deepProbeScript = path.join(
      MONOREPO_ROOT,
      'apps',
      'api',
      'scripts',
      'verify_packaged_mcp.py'
    );
    if (!probePython || !fs.existsSync(deepProbeScript)) {
      fail('packaged MCP deep probe is unavailable; run build-sidecar.sh to create apps/api/.venv');
    } else {
      const deepProbe = spawnSync(probePython, [deepProbeScript, packagedSidecar], {
        cwd: path.dirname(packagedSidecar),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 180_000,
      });
      if (deepProbe.error || deepProbe.status !== 0) {
        const details = `${deepProbe.stdout || ''}\n${deepProbe.stderr || ''}`.trim();
        fail(
          `packaged MCP modern/legacy/real-route protocol probe failed` +
            (deepProbe.error ? `: ${deepProbe.error.message}` : '') +
            (details ? `: ${details}` : '')
        );
      } else {
        ok(
          'exact packaged sidecar passed modern, raw 2024 legacy, and real grant/job route MCP calls'
        );
      }
    }
  } else {
    fail(
      `sidecar binary missing: ${path.relative(process.cwd(), sidecarExecutable)} ` +
        `(expected under ${path.relative(process.cwd(), RESOURCES_DIR)})`
    );
  }

  for (const bin of EXPECTED_BINARIES) {
    if (bundledBinaryExists(RESOURCES_DIR, bin)) {
      ok(`bioinformatics binary found: ${bin}`);
    } else {
      fail(`bioinformatics binary missing: ${bin}`);
    }
  }
} else {
  fail(
    `extraResources binaries directory not found at ${path.relative(process.cwd(), RESOURCES_DIR)}`
  );
}

if (packagedMainGraph === null) {
  fail('reachable packaged main-process graph is unavailable for size verification');
} else {
  const sizeKb = (packagedMainGraph.sizeBytes / 1024).toFixed(0);
  if (packagedMainGraph.sizeBytes > 500_000) {
    ok(
      `reachable main-process graph is ${sizeKb} kB across ` +
        `${packagedMainGraph.paths.length} JavaScript files — deps are bundled (not external)`
    );
  } else {
    fail(
      `reachable main-process graph is only ${sizeKb} kB — deps appear to be external ` +
        '(not bundled).\n' +
        '       This means the app will crash when electron-builder drops a dep from the asar.\n' +
        '       Fix: ensure build.externalizeDeps is false in electron.vite.config.ts for main.'
    );
  }
}

const BINARIES_DIR = path.join(APP_DIR, 'binaries');
if (skipSidecarCheck) {
  console.log('\n  [check 6] Skipped (--skip-sidecar-check): bundled binaries presence');
} else if (!fs.existsSync(BINARIES_DIR)) {
  fail(
    `Resources/binaries/ missing — sidecar compute endpoints will fail at runtime.\n` +
      '       Run:\n' +
      '         ./apps/desktop/scripts/download-binaries.sh         # downloads to runtime path\n' +
      '         ./apps/desktop/scripts/prepare-bundle-binaries.sh   # copies runtime → bundle path\n' +
      '       Then rebuild.'
  );
} else {
  const {
    filterBinaryEntries,
    findSidecarEntry,
    findMissingToolPrefixes,
  } = require('./lib/verify-package-helpers.cjs');

  const binEntries = filterBinaryEntries(fs.readdirSync(BINARIES_DIR, { withFileTypes: true }));
  if (binEntries.length === 0) {
    fail(
      `Resources/binaries/ is empty — sidecar compute endpoints will fail at runtime.\n` +
        '       apps/desktop/resources/binaries/ was empty at package time.\n' +
        '       Run:\n' +
        '         ./apps/desktop/scripts/download-binaries.sh         # downloads to runtime path\n' +
        '         ./apps/desktop/scripts/prepare-bundle-binaries.sh   # copies runtime → bundle path\n' +
        '       Then rebuild.'
    );
  } else {
    const sidecarEntry = findSidecarEntry(binEntries);
    if (!sidecarEntry) {
      fail(
        `Resources/binaries/ is missing the waypoint-api-* sidecar binary.\n` +
          '       This is the Nuitka-compiled FastAPI server; without it no\n' +
          '       compute endpoint works.\n' +
          '       To fix locally:\n' +
          '         cd apps/api && ./scripts/build-sidecar.sh\n' +
          '         ./apps/desktop/scripts/prepare-bundle-binaries.sh\n' +
          '       In CI: confirm apps/api/scripts/build-sidecar.sh ran in this job.'
      );
    }

    const expectedPrefixes =
      targetPlatform === 'win32'
        ? ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'cmpress', 'mafft']
        : ['blastn', 'makeblastdb', 'diamond', 'cmscan'];
    const missing = findMissingToolPrefixes(binEntries, expectedPrefixes);
    if (missing.length > 0) {
      fail(
        `Resources/binaries/ is missing expected tool(s): ${missing.join(', ')}.\n` +
          '       To fix locally:\n' +
          '         ./apps/desktop/scripts/download-binaries.sh         # downloads to runtime path\n' +
          '         ./apps/desktop/scripts/prepare-bundle-binaries.sh   # copies runtime → bundle path\n' +
          '       Then rebuild.'
      );
    }

    if (sidecarEntry && missing.length === 0) {
      ok(
        `Resources/binaries/ has ${binEntries.length} file(s) including the sidecar and all expected tools`
      );
    }
  }
}

if (targetPlatform === 'darwin' || targetPlatform === 'win32') {
  const helperSpecs = [
    DNA_HELPER_SPECS[0],
    ...(targetPlatform === 'darwin' ? [DNA_HELPER_SPECS[1], FASTP_HELPER_SPEC] : []),
    ...(targetPlatform === 'win32'
      ? [
          {
            name: 'dna-process-guardian',
            probeArgs: ['--version'],
            supportedSchema: /schema 2$/,
          },
        ]
      : []),
  ];
  const helpersDir =
    targetPlatform === 'darwin'
      ? path.join(LAYOUT.appRoot, 'Contents', 'Helpers')
      : path.join(LAYOUT.appRoot, 'Helpers');

  for (const spec of helperSpecs) {
    const helperPath = path.join(
      helpersDir,
      helperExecutableName(spec.name, targetPlatform, targetArch)
    );

    if (!fs.existsSync(helperPath)) {
      fail(
        `target-specific ${spec.name} helper missing: ${path.relative(process.cwd(), helperPath)}.\n` +
          `       Run \`node scripts/build-helpers.cjs ${helperSpecs.map(({ name }) => name).join(' ')}\` before electron-builder.`
      );
      continue;
    }

    const stat = fs.statSync(helperPath);
    const prefix = stat.isFile() ? fs.readFileSync(helperPath).subarray(0, 256) : Buffer.alloc(0);
    const integrityProblem = packagedHelperIntegrityProblem(stat, prefix, targetPlatform);
    if (integrityProblem) {
      fail(`target-specific ${spec.name} helper ${integrityProblem}: ${helperPath}`);
      continue;
    }

    ok(`${spec.name} helper is a compiled executable: ${path.basename(helperPath)}`);

    try {
      ok(`${spec.name} helper architecture is ${targetArch} (${describeNativeBinary(helperPath)})`);
    } catch (e) {
      fail(`could not verify ${spec.name} helper architecture: ${e.message}`);
    }

    if (targetArch === hostArch) {
      const probe = spawnSync(helperPath, spec.probeArgs, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      });
      const output = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
      if (probe.error || probe.status !== 0 || !spec.supportedSchema.test(output)) {
        fail(
          `${spec.name} helper schema probe failed (status ${probe.status}): ` +
            `${probe.error ? probe.error.message : output || 'no output'}`
        );
      } else {
        ok(`${spec.name} helper reports a supported schema (${output})`);
        if (spec.name === 'dna-indexer') {
          const contract = inspectDnaIndexerContract(helperPath);
          if (contract.problem) {
            fail(`dna-indexer output contract mismatch: ${contract.problem}`);
          } else {
            ok('dna-indexer emits the current BGZF indexed-genome bundle');
          }
        }
        if (spec.name === 'dna-process-guardian' && process.platform === 'win32') {
          const containmentProbe = spawnSync(
            process.execPath,
            [path.join(__dirname, 'verify-windows-process-guardian.cjs'), helperPath],
            {
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
              timeout: 20_000,
            }
          );
          if (containmentProbe.error || containmentProbe.status !== 0) {
            fail(
              `dna-process-guardian containment probe failed (status ${containmentProbe.status}): ` +
                `${containmentProbe.error ? containmentProbe.error.message : containmentProbe.stderr || 'no output'}`
            );
          } else {
            ok('dna-process-guardian drains its complete Windows Job Object tree');
          }
        }
        if (spec.name === 'dna-coverage' && !skipSidecarCheck) {
          const schemaMatch = output.match(/schema ([1-9][0-9]*)$/);
          if (!schemaMatch) {
            fail(`dna-coverage helper schema could not be parsed from: ${output}`);
          } else {
            const contract = inspectNativeCoveragePackageContract(
              helperPath,
              Number(schemaMatch[1])
            );
            if (contract.problem) {
              fail(`native coverage package contract mismatch: ${contract.problem}`);
            } else {
              ok(
                `frozen sidecar native coverage contract matches current source ` +
                  `(${contract.cacheContract}; ${contract.engineIdentity})`
              );
            }
          }
        }
      }
    } else {
      warn(
        `${spec.name} schema probe skipped for cross-architecture package ` +
          `(host ${hostArch}, target ${targetArch})`
      );
    }
  }
}

const AGENT_TOOLS_DIR = path.join(APP_DIR, 'agent-tools');
const expectedAgentToolManifests = [
  'renderer-tool-manifest.json',
  'workflow-manifest.json',
  'native-authoring-contract.json',
  'capability-policy.json',
];
if (!fs.existsSync(AGENT_TOOLS_DIR)) {
  fail(
    `Resources/agent-tools/ missing — packaged MCP sidecar cannot load tool manifests.\n` +
      '       Check electron-builder.yml extraResources includes packages/core/agent-tools.'
  );
} else {
  const missing = expectedAgentToolManifests.filter(
    (name) => !fs.existsSync(path.join(AGENT_TOOLS_DIR, name))
  );
  if (missing.length > 0) {
    fail(
      `Resources/agent-tools/ is missing manifest(s): ${missing.join(', ')}.\n` +
        '       Rebuild after syncing packages/core/agent-tools into packaged resources.'
    );
  } else {
    ok(`Resources/agent-tools/ contains ${expectedAgentToolManifests.length} shared manifests`);
  }
}

const COMPUTE_MANIFESTS_DIR = path.join(APP_DIR, 'compute-endpoints', 'manifests');
const expectedComputeManifests = [
  'boltz.json',
  'nvidia-nim.json',
  'replicate.json',
  'subseq.json',
  'tamarind.json',
];
if (!fs.existsSync(COMPUTE_MANIFESTS_DIR)) {
  fail(
    `Resources/compute-endpoints/manifests/ missing — packaged compute discovery cannot start.\n` +
      '       Check electron-builder.yml extraResources includes compute-endpoints/manifests.'
  );
} else {
  const problems = [];
  for (const name of expectedComputeManifests) {
    const manifestPath = path.join(COMPUTE_MANIFESTS_DIR, name);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      problems.push(`${name}: missing`);
      continue;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== name.replace(/\.json$/u, '')) {
        problems.push(`${name}: provider id does not match its filename`);
      }
      if (![1, 2].includes(manifest.schemaVersion)) {
        problems.push(`${name}: unsupported schemaVersion`);
      }
    } catch (error) {
      problems.push(
        `${name}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  if (problems.length > 0) {
    fail(`Packaged compute provider manifests are invalid: ${problems.join('; ')}`);
  } else {
    ok(
      `Resources/compute-endpoints/manifests/ contains ${expectedComputeManifests.length} providers`
    );
  }
}

const gitReadWorkerPath = path.join(APP_DIR, 'git-read-worker.cjs');
if (!fs.existsSync(gitReadWorkerPath) || !fs.statSync(gitReadWorkerPath).isFile()) {
  fail('Packaged Git-read worker is missing; document baseline reads will fail.');
} else {
  ok('Git-read worker is present outside app.asar');
}

function findFileByName(root, name, pathSegment) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase() === name.toLowerCase() &&
        (!pathSegment || fullPath.replace(/\\/g, '/').includes(pathSegment))
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

{
  const dugiteRoot = path.join(ASAR_UNPACKED, 'node_modules', 'dugite', 'git');
  const gitCandidates =
    targetPlatform === 'win32'
      ? [
          path.join(dugiteRoot, 'cmd', 'git.exe'),
          path.join(dugiteRoot, 'bin', 'git.exe'),
          path.join(dugiteRoot, 'mingw64', 'bin', 'git.exe'),
        ]
      : [path.join(dugiteRoot, 'bin', 'git')];
  let gitBin = gitCandidates.find((candidate) => fs.existsSync(candidate));
  if (!gitBin) {
    gitBin = findFileByName(dugiteRoot, targetPlatform === 'win32' ? 'git.exe' : 'git', '/git/');
  }

  if (!gitBin || !fs.existsSync(gitBin)) {
    fail(
      `Bundled git (dugite) not found under app.asar.unpacked — every workspace git\n` +
        '       operation (status/commit/log/diff) fails at runtime.\n' +
        '       Likely: the Dugite runtime provisioner did not run, or asarUnpack\n' +
        "       '**/node_modules/dugite/**' did not match."
    );
  } else if (targetPlatform === 'win32') {
    try {
      ok(`Bundled git (dugite) present and ${targetArch} (${describeNativeBinary(gitBin)})`);
    } catch (e) {
      fail(`Bundled git is the WRONG arch for a ${targetArch} build: ${e.message}`);
    }
  } else {
    const archStr = targetArch === 'arm64' ? 'arm64' : 'x86_64';
    let fileOut = '';
    try {
      fileOut = execFileSync('file', [gitBin], { encoding: 'utf8' });
    } catch {}
    if (fileOut && !fileOut.includes(archStr)) {
      fail(
        `Bundled git is the WRONG arch for a ${targetArch} build: ${fileOut.trim()}\n` +
          "       dugite downloads a single-arch git keyed on the install host's arch.\n" +
          `       Set npm_config_arch=${targetArch} for the install step, then rebuild.`
      );
    } else {
      ok(`Bundled git (dugite) present${fileOut ? ` and ${targetArch}` : ''}`);
    }
  }

  if (targetPlatform === 'darwin' && gitBin && fs.existsSync(gitBin)) {
    const gitCore = path.join(dugiteRoot, 'libexec', 'git-core');
    if (!fs.existsSync(path.join(gitCore, 'git'))) {
      fail(
        `dugite git-core/git not found at ${gitCore} — the  dedup layout changed\n` +
          '       (likely a dugite version bump). Both the afterPack dedup (scripts/dedup-dugite.cjs)\n' +
          '       and this re-bloat guard key on git-core/git; update both to the new layout.'
      );
    } else {
      const {
        countLargeRegularCopies,
        directorySizeBytes,
      } = require('./lib/dedup-identical-files.cjs');
      const copies = countLargeRegularCopies(gitCore, 'git');
      const sizeMiB = directorySizeBytes(gitCore) / (1024 * 1024);
      const COPY_THRESHOLD = 3;
      const SIZE_CEILING_MIB = 250;
      if (copies > COPY_THRESHOLD || sizeMiB > SIZE_CEILING_MIB) {
        fail(
          `dugite git-core re-bloated: ${copies} full-size \`git\` copies, ` +
            `${sizeMiB.toFixed(0)} MiB total (limits: ≤${COPY_THRESHOLD} copies, ≤${SIZE_CEILING_MIB} MiB).\n` +
            '       The afterPack dedup (scripts/dedup-dugite.cjs) did not run or stopped matching —\n' +
            '       the macOS .app is ~460 MB fatter than it should be. Likely a dugite version\n' +
            '       bump changed the git binary; confirm the hook ran in the build log and rebuild.'
        );
      } else {
        ok(
          `dugite git-core deduped — ${copies} full-size \`git\` copies, ${sizeMiB.toFixed(0)} MiB total`
        );
      }
    }
  }
}

{
  const manifestPath = path.join(
    MONOREPO_ROOT,
    'packages',
    'core',
    'codex-app-server-contract',
    'src',
    'manifest.json'
  );
  let codexManifest = null;
  try {
    codexManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`Could not load Codex App Server manifest: ${e.message}`);
  }

  if (codexManifest) {
    const problem = codexAppServerIntegrityProblem({
      platform: targetPlatform,
      arch: targetArch,
      resourcesDir: APP_DIR,
      manifest: codexManifest,
      windowsExecutableSignatureProblem,
    });
    if (problem) {
      fail(problem);
    } else {
      ok('Codex App Server resource inventory and license files are digest-verified');
    }
  }
}

console.log('\n  [check 11] Verifying third-party notices and license coverage...');
{
  const {
    noticesProblems,
    readThirdPartyManifest,
    shippedEntries,
    uncoveredShippedEntries,
  } = require('./third-party-coverage.cjs');
  const {
    appBuildVersionText,
    readPackagedAppBuildIdentity,
  } = require('./lib/app-build-identity-artifact.cjs');
  const problems = [];
  let packagedIdentity = null;
  try {
    const archiveEntries = listPackage(ASAR, { isPack: false });
    packagedIdentity = readPackagedAppBuildIdentity(ASAR, {
      extractFile,
      resolveEntry: (entry) => resolveAsarEntryPath(archiveEntries, entry),
    });
  } catch (error) {
    problems.push(`the packaged app has no readable build identity: ${error.message}`);
  }
  if (packagedIdentity) {
    problems.push(
      ...noticesProblems({
        resourcesDir: APP_DIR,
        appVersion: appBuildVersionText(packagedIdentity),
        windowsGitBundle: targetPlatform === 'win32',
      })
    );
  }
  const uncovered = uncoveredShippedEntries(
    readThirdPartyManifest(path.resolve(__dirname, '..')),
    shippedEntries({
      resourcesDir: APP_DIR,
      helpersDir:
        targetPlatform === 'darwin'
          ? path.join(LAYOUT.appRoot, 'Contents', 'Helpers')
          : path.join(LAYOUT.appRoot, 'Helpers'),
    })
  );
  if (uncovered.length > 0) {
    problems.push(`third-party/manifest.json has no entry covering: ${uncovered.join(', ')}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) fail(problem);
  } else {
    ok(
      'Third-party notices and Chromium licenses are packaged, and every bundled program is listed'
    );
  }
}

console.log(`\n[verify-package] ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.error('[verify-package] ❌ Package verification FAILED — do not release this build\n');
  process.exit(1);
} else {
  console.log('[verify-package] ✅ Package is safe to release\n');
}
