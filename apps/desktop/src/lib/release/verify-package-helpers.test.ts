// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const helpers = require('../../../scripts/lib/verify-package-helpers.cjs') as {
  filterBinaryEntries: (entries: readonly BinaryEntry[]) => BinaryEntry[];
  findSidecarEntry: (entries: readonly BinaryEntry[]) => BinaryEntry | undefined;
  sidecarBundleProblem: (entries: readonly BinaryEntry[], expectedName: string) => string | null;
  findMissingToolPrefixes: (entries: readonly BinaryEntry[], expected: string[]) => string[];
  mcpStdioProbeProblem: (probe: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }) => string | null;
  helperPlatformSuffix: (platform: NodeJS.Platform, arch: string) => string;
  helperExecutableName: (helper: string, platform: NodeJS.Platform, arch: string) => string;
  helperInstallNeedsFsync: (platform: NodeJS.Platform) => boolean;
  asarEntryPath: (platform: NodeJS.Platform, ...segments: string[]) => string;
  verifyReleaseBuildStamp: (
    bundle: Buffer | string,
    required: boolean
  ) => { ok: boolean; present: boolean; message: string };
  verifySourceCommitStamp: (
    bundle: Buffer | string,
    expectedCommit?: string | null
  ) => { ok: boolean; sourceCommit: string | null; message: string };
  verifyUpdateFeedAuthority: (
    bundle: Buffer | string,
    expectedBase: string
  ) => { ok: boolean; feedBase: string | null; message: string };
  verifyHostedGatewayAuthority: (
    bundle: Buffer | string,
    expectedGatewayOrigin: string | null
  ) => { ok: boolean; enabled: boolean; gatewayOrigin: string | null; message: string };
  hostedGatewayExpectationFromEnv: (env: NodeJS.ProcessEnv) => string | null;
  releaseAAuthBundleProblems: (input: {
    mainBundle: Buffer | string;
    rendererBundles?: readonly (Buffer | string)[];
    forbiddenHostedGatewayUrls?: readonly (string | undefined)[];
  }) => string[];
  releaseBHostedBundleProblems: (input: {
    mainBundle: Buffer | string;
    rendererBundles?: readonly (Buffer | string)[];
  }) => string[];
  packagedHelperIntegrityProblem: (
    stat: { isFile: () => boolean; size: number; mode: number },
    prefix: Buffer | string,
    platform?: NodeJS.Platform
  ) => string | null;
  parseNativeCoverageContractProbe: (output: string, label: string) => NativeCoverageContract;
  nativeCoverageContractProblem: (input: {
    sourceContract: NativeCoverageContract;
    packagedContract: NativeCoverageContract;
    packagedHelperSha256: string;
    packagedHelperSchema: number;
  }) => string | null;
  codexAppServerIntegrityProblem: (input: {
    platform: string;
    arch: string;
    resourcesDir: string;
    manifest: object;
  }) => string | null;
  codexAppServerBinaryPath: (
    resourcesDir: string,
    target: { triple: string; codexBinaryPathInPackage: string }
  ) => string;
};

describe('packaged updater authority', () => {
  const feedBase = 'https://updates.example.test';
  const assignment = `const UPDATE_FEED_BASE = "${feedBase}";`;

  it('accepts exactly one non-empty expected authority', () => {
    expect(helpers.verifyUpdateFeedAuthority(`before ${assignment} after`, feedBase)).toEqual({
      ok: true,
      feedBase,
      message: `updater feed authority is pinned to ${feedBase}`,
    });
  });

  it('rejects the stranded empty-feed regression', () => {
    expect(
      helpers.verifyUpdateFeedAuthority('const UPDATE_FEED_BASE = "";', feedBase)
    ).toMatchObject({ ok: false, feedBase: '' });
  });

  it('rejects absent, duplicated, and unexpected authorities', () => {
    expect(helpers.verifyUpdateFeedAuthority('ordinary bundle', feedBase)).toMatchObject({
      ok: false,
      feedBase: null,
    });
    expect(
      helpers.verifyUpdateFeedAuthority(`${assignment}\n${assignment}`, feedBase)
    ).toMatchObject({ ok: false, feedBase: null });
    expect(
      helpers.verifyUpdateFeedAuthority(
        'const UPDATE_FEED_BASE = "https://wrong.example";',
        feedBase
      )
    ).toMatchObject({ ok: false, feedBase: 'https://wrong.example' });
  });
});

describe('packaged source commit stamp', () => {
  const commit = 'a'.repeat(40);
  const stamp = `DNAFORGE_SOURCE_COMMIT=${commit}::SOURCE_COMMIT_PROVENANCE_V1::END`;

  it('extracts one sealed commit and rejects a checkout mismatch', () => {
    expect(helpers.verifySourceCommitStamp(`before ${stamp} after`, commit)).toMatchObject({
      ok: true,
      sourceCommit: commit,
    });
    expect(helpers.verifySourceCommitStamp(stamp, 'b'.repeat(40))).toMatchObject({
      ok: false,
      sourceCommit: commit,
    });
  });

  it('rejects absent, malformed, and conflicting source identities', () => {
    expect(helpers.verifySourceCommitStamp('')).toMatchObject({ ok: false });
    expect(helpers.verifySourceCommitStamp(stamp.replace(commit, 'A'.repeat(40)))).toMatchObject({
      ok: false,
    });
    expect(helpers.verifySourceCommitStamp(`${stamp}${stamp}`)).toMatchObject({
      ok: true,
      sourceCommit: commit,
    });
    const conflictingStamp = stamp.replace(commit, 'b'.repeat(40));
    expect(helpers.verifySourceCommitStamp(`${stamp}${conflictingStamp}`)).toMatchObject({
      ok: false,
    });
  });
});

interface BinaryEntry {
  name: string;
  isFile?: () => boolean;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
}

interface NativeCoverageContract {
  schema: string;
  cacheContract: string;
  engineIdentity: string;
}

function makeEntry(name: string, type: 'file' | 'directory' | 'symlink'): BinaryEntry {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  };
}

describe('filterBinaryEntries', () => {
  it('includes file entries', () => {
    const result = helpers.filterBinaryEntries([makeEntry('blastn', 'file')]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('blastn');
  });

  it('includes symlink entries (mafft wrapper pattern)', () => {
    const result = helpers.filterBinaryEntries([makeEntry('mafft', 'symlink')]);
    expect(result).toHaveLength(1);
  });

  it('🟥 includes DIRECTORY entries — Nuitka --standalone sidecar shape', () => {
    const result = helpers.filterBinaryEntries([
      makeEntry('waypoint-api-x86_64-apple-darwin', 'directory'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('waypoint-api-x86_64-apple-darwin');
  });

  it('handles mixed shapes (real .app layout)', () => {
    const result = helpers.filterBinaryEntries([
      makeEntry('blastn', 'file'),
      makeEntry('cmscan', 'file'),
      makeEntry('diamond', 'file'),
      makeEntry('mafft', 'symlink'),
      makeEntry('mafft-mac', 'directory'),
      makeEntry('makeblastdb', 'file'),
      makeEntry('waypoint-api-aarch64-apple-darwin', 'directory'),
    ]);
    expect(result).toHaveLength(7);
  });

  it('handles entries with missing type predicates defensively', () => {
    const result = helpers.filterBinaryEntries([{ name: 'orphan' } as BinaryEntry]);
    expect(result).toHaveLength(0);
  });
});

describe('findSidecarEntry', () => {
  it('finds the directory-shaped x86_64 sidecar', () => {
    const filtered = [
      makeEntry('blastn', 'file'),
      makeEntry('waypoint-api-x86_64-apple-darwin', 'directory'),
    ];
    const entry = helpers.findSidecarEntry(filtered);
    expect(entry?.name).toBe('waypoint-api-x86_64-apple-darwin');
  });

  it('finds the directory-shaped aarch64 sidecar', () => {
    const filtered = [makeEntry('waypoint-api-aarch64-apple-darwin', 'directory')];
    expect(helpers.findSidecarEntry(filtered)?.name).toBe('waypoint-api-aarch64-apple-darwin');
  });

  it('rejects the retired file-shaped sidecar that runtime cannot resolve', () => {
    const filtered = [makeEntry('waypoint-api-x86_64-apple-darwin', 'file')];
    expect(helpers.findSidecarEntry(filtered)).toBeUndefined();
  });

  it('returns undefined when no sidecar is present (the true failure mode)', () => {
    const filtered = [makeEntry('blastn', 'file'), makeEntry('diamond', 'file')];
    expect(helpers.findSidecarEntry(filtered)).toBeUndefined();
  });

  it('does not match sibling-prefixed names', () => {
    const filtered = [makeEntry('waypoint-api', 'file')];
    expect(helpers.findSidecarEntry(filtered)).toBeUndefined();
  });
});

describe('sidecarBundleProblem', () => {
  const expected = 'waypoint-api-aarch64-apple-darwin';

  it('accepts exactly one expected standalone directory', () => {
    expect(helpers.sidecarBundleProblem([makeEntry(expected, 'directory')], expected)).toBeNull();
  });

  it('rejects the retired one-file layout', () => {
    expect(helpers.sidecarBundleProblem([makeEntry(expected, 'file')], expected)).toContain(
      'not a standalone sidecar directory'
    );
  });

  it('rejects extra sidecar implementations', () => {
    expect(
      helpers.sidecarBundleProblem(
        [
          makeEntry(expected, 'directory'),
          makeEntry('waypoint-api-x86_64-apple-darwin', 'directory'),
        ],
        expected
      )
    ).toContain('expected exactly one');
  });
});

describe('findMissingToolPrefixes', () => {
  it('returns empty when all expected prefixes are present', () => {
    const filtered = [
      makeEntry('blastn', 'file'),
      makeEntry('cmscan', 'file'),
      makeEntry('diamond', 'file'),
      makeEntry('makeblastdb', 'file'),
    ];
    expect(
      helpers.findMissingToolPrefixes(filtered, ['blastn', 'makeblastdb', 'diamond', 'cmscan'])
    ).toEqual([]);
  });

  it('returns the missing prefix names when one is absent', () => {
    const filtered = [makeEntry('blastn', 'file'), makeEntry('diamond', 'file')];
    expect(
      helpers.findMissingToolPrefixes(filtered, ['blastn', 'makeblastdb', 'diamond', 'cmscan'])
    ).toEqual(['makeblastdb', 'cmscan']);
  });

  it('matches by prefix, so versioned binaries are accepted', () => {
    const filtered = [makeEntry('blastn-2.16.0', 'file')];
    expect(helpers.findMissingToolPrefixes(filtered, ['blastn'])).toEqual([]);
  });

  it('treats directory-shaped tools as present (e.g. mafft-mac/)', () => {
    const filtered = [makeEntry('mafft-mac', 'directory')];
    expect(helpers.findMissingToolPrefixes(filtered, ['mafft'])).toEqual([]);
  });
});

describe('mcpStdioProbeProblem', () => {
  it('accepts a frozen sidecar that imports and exits MCP stdio cleanly at EOF', () => {
    expect(
      helpers.mcpStdioProbeProblem({
        status: 0,
        stdout: '',
      })
    ).toBeNull();
  });

  it('reports a sidecar whose MCP import or transport exits nonzero', () => {
    expect(
      helpers.mcpStdioProbeProblem({
        status: 1,
        stderr: 'ImportError: MCP runtime missing',
      })
    ).toContain('ImportError: MCP runtime missing');
  });

  it('rejects startup output that would corrupt newline-delimited MCP stdout', () => {
    expect(
      helpers.mcpStdioProbeProblem({
        status: 0,
        stdout: 'sidecar ready\n',
      })
    ).toContain('wrote to stdout before receiving a request');
  });

  it('reports a sidecar that cannot execute', () => {
    expect(
      helpers.mcpStdioProbeProblem({
        status: null,
        error: new Error('spawn EACCES'),
      })
    ).toContain('could not execute packaged sidecar --mcp-stdio');
  });
});

describe('Release A auth artifact policy', () => {
  const validMain = [
    'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END',
    'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled',
    'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty',
  ].join('\n');
  const validRenderer = 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:disabled';

  it('accepts canonical auth and disabled Hosted markers', () => {
    expect(
      helpers.releaseAAuthBundleProblems({
        mainBundle: validMain,
        rendererBundles: [validRenderer],
      })
    ).toEqual([]);
  });

  it('rejects a missing canonical auth marker', () => {
    expect(
      helpers.releaseAAuthBundleProblems({
        mainBundle: 'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled',
        rendererBundles: [validRenderer],
      })
    ).toContain('main bundle must contain one unique packaged auth authority; found 0');
  });

  it('rejects a Hosted-enabled main or renderer bundle', () => {
    expect(
      helpers.releaseAAuthBundleProblems({
        mainBundle: `${validMain}\nDNAFORGE_RELEASE_A_HOSTED_MAIN:enabled`,
        rendererBundles: [
          `${validRenderer}\nDNAFORGE_RELEASE_A_HOSTED_RENDERER:enabled\ndnaforge-hosted-auto`,
        ],
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Hosted main marker is enabled'),
        expect.stringContaining('Hosted renderer marker is enabled'),
        expect.stringContaining('advertises Hosted identifier dnaforge-hosted-auto'),
      ])
    );
  });

  it('rejects an arbitrary configured Hosted gateway without an out-of-band URL hint', () => {
    expect(
      helpers.releaseAAuthBundleProblems({
        mainBundle: `${validMain}\nDNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured\nhttps://unexpected-gateway.invalid`,
        rendererBundles: [`${validRenderer}\ndnaforge-hosted-deep`],
      })
    ).toEqual(
      expect.arrayContaining([
        'Hosted gateway is configured in a Release A artifact',
        expect.stringContaining('advertises Hosted identifier dnaforge-hosted-deep'),
      ])
    );
  });
});

describe('Release B auth and Hosted artifact policy', () => {
  const gateway = 'https://hosted.dnaforge.com';
  const validMain = [
    'DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=https://hosted.dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END',
    'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled',
    'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured',
  ].join('\n');
  const validRenderer = [
    'DNAFORGE_RELEASE_A_HOSTED_RENDERER:enabled',
    'dnaforge-hosted-auto',
    'dnaforge-hosted-deep',
  ].join('\n');

  it('accepts canonical auth plus enabled main and renderer markers', () => {
    expect(
      helpers.releaseBHostedBundleProblems({
        mainBundle: validMain,
        rendererBundles: [validRenderer],
        expectedGatewayOrigin: gateway,
      })
    ).toEqual([]);
  });

  it('rejects a contradictory or incomplete Release B artifact', () => {
    expect(
      helpers.releaseBHostedBundleProblems({
        mainBundle: `${validMain}\nDNAFORGE_RELEASE_A_HOSTED_MAIN:disabled`,
        rendererBundles: ['DNAFORGE_RELEASE_A_HOSTED_RENDERER:disabled'],
        expectedGatewayOrigin: gateway,
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('main marker is disabled'),
        expect.stringContaining('renderer marker is disabled'),
        expect.stringContaining('missing Hosted identifier dnaforge-hosted-auto'),
      ])
    );
  });
});

describe('helperPlatformSuffix', () => {
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
  ] as const)('maps %s/%s to the packaged Rust target suffix', (platform, arch, suffix) => {
    expect(helpers.helperPlatformSuffix(platform, arch)).toBe(suffix);
  });

  it('fails closed for an unsupported Windows architecture', () => {
    expect(() => helpers.helperPlatformSuffix('win32', 'arm64')).toThrow(
      'Unsupported helper platform: win32/arm64'
    );
  });
});

describe('helperExecutableName', () => {
  it('adds the required executable suffix on Windows', () => {
    expect(helpers.helperExecutableName('dna-indexer', 'win32', 'x64')).toBe(
      'dna-indexer-x86_64-pc-windows-msvc.exe'
    );
  });

  it('keeps the extensionless macOS packaging contract', () => {
    expect(helpers.helperExecutableName('dna-indexer', 'darwin', 'arm64')).toBe(
      'dna-indexer-aarch64-apple-darwin'
    );
  });
});

describe('helperInstallNeedsFsync', () => {
  it('keeps the durable file-content flush on POSIX hosts', () => {
    expect(helpers.helperInstallNeedsFsync('darwin')).toBe(true);
    expect(helpers.helperInstallNeedsFsync('linux')).toBe(true);
  });

  it('skips the unsupported file fsync on Windows while retaining atomic rename', () => {
    expect(helpers.helperInstallNeedsFsync('win32')).toBe(false);
  });
});

describe('asarEntryPath', () => {
  it.each([
    ['darwin', 'out/main/index.js'],
    ['linux', 'out/main/index.js'],
    ['win32', 'out\\main\\index.js'],
  ] as const)('uses the @electron/asar host-path spelling on %s', (platform, expected) => {
    expect(helpers.asarEntryPath(platform, 'out', 'main', 'index.js')).toBe(expected);
  });

  it('normalizes mixed separators into Windows archive-entry paths', () => {
    expect(helpers.asarEntryPath('win32', 'out/main', 'index.js')).toBe('out\\main\\index.js');
  });
});

describe('resolveAsarEntryPath', () => {
  it('returns the archive-listed spelling after matching canonical separators', () => {
    expect(
      helpers.resolveAsarEntryPath(
        ['\\out\\main\\index.js', '\\node_modules\\example\\index.js'],
        'out/main/index.js'
      )
    ).toBe('out\\main\\index.js');
  });

  it('accepts a leading slash in an ASAR listing but returns a relative path', () => {
    expect(helpers.resolveAsarEntryPath(['/out/main/index.js'], 'out/main/index.js')).toBe(
      'out/main/index.js'
    );
  });

  it('fails closed when the expected packaged main bundle is absent', () => {
    expect(() => helpers.resolveAsarEntryPath(['out/main/other.js'], 'out/main/index.js')).toThrow(
      '"out/main/index.js" was not listed in this archive'
    );
  });
});

describe('verifyReleaseBuildStamp', () => {
  const stamped = Buffer.from(
    'bundle DNAFORGE_RELEASE_BUILD=1::SCHEMA_MIGRATION_AUTHORITY_V1::END bundle'
  );
  const unstamped = Buffer.from('ordinary local bundle');

  it('requires the exact marker for an official release artifact', () => {
    expect(helpers.verifyReleaseBuildStamp(stamped, true)).toMatchObject({
      ok: true,
      present: true,
    });
    expect(helpers.verifyReleaseBuildStamp(unstamped, true)).toMatchObject({
      ok: false,
      present: false,
    });
  });

  it('fails a local artifact if the release marker leaked into it', () => {
    expect(helpers.verifyReleaseBuildStamp(unstamped, false)).toMatchObject({
      ok: true,
      present: false,
    });
    expect(helpers.verifyReleaseBuildStamp(stamped, false)).toMatchObject({
      ok: false,
      present: true,
    });
  });

  it.each([
    'DNAFORGE_RELEASE_BUILD=10',
    'DNAFORGE_RELEASE_BUILD=1 ',
    'DNAFORGE_RELEASE_BUILD=1evil',
    'DNAFORGE_RELEASE_BUILD=1::SCHEMA_MIGRATION_AUTHORITY_V1',
  ])('rejects malformed prefix marker %s', (malformed) => {
    expect(helpers.verifyReleaseBuildStamp(`bundle ${malformed} bundle`, true)).toMatchObject({
      ok: false,
      present: false,
    });
  });
});

describe('verifyHostedGatewayAuthority', () => {
  const gateway = 'https://hosted.dnaforge.com';
  const stamp =
    'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https://hosted.dnaforge.com::HOSTED_GATEWAY_AUTHORITY_V1::END';

  it('requires the exact expected gateway in a Release B artifact', () => {
    expect(helpers.verifyHostedGatewayAuthority(`bundle ${stamp} bundle`, gateway)).toEqual({
      ok: true,
      enabled: true,
      gatewayOrigin: gateway,
      message: `Release B Hosted gateway authority is pinned to ${gateway}`,
    });
    expect(
      helpers.verifyHostedGatewayAuthority(`bundle ${stamp} bundle`, 'https://other.example')
    ).toMatchObject({ ok: false, enabled: true, gatewayOrigin: gateway });
  });

  it('does not mistake the bootstrap validation regex for another complete authority', () => {
    const validationRegex = String.raw`/^DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https:\/\/[^/\s]+::HOSTED_GATEWAY_AUTHORITY_V1::END$/u`;
    const compiledBootstrap =
      `const injectedAuthority = ${JSON.stringify(stamp)}; ` +
      `const authorityValidator = ${validationRegex};`;
    expect(helpers.verifyHostedGatewayAuthority(compiledBootstrap, gateway)).toMatchObject({
      ok: true,
      enabled: true,
      gatewayOrigin: gateway,
    });
  });

  it('proves Release A contains no active Hosted authority', () => {
    expect(helpers.verifyHostedGatewayAuthority('ordinary bundle', null)).toMatchObject({
      ok: true,
      enabled: false,
      gatewayOrigin: null,
    });
    expect(helpers.verifyHostedGatewayAuthority(`bundle ${stamp}`, null)).toMatchObject({
      ok: false,
      enabled: true,
    });
  });

  it.each([
    'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=http://hosted.dnaforge.com::HOSTED_GATEWAY_AUTHORITY_V1::END',
    'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https://hosted.dnaforge.com/path::HOSTED_GATEWAY_AUTHORITY_V1::END',
  ])('rejects malformed embedded authority %s', (malformed) => {
    expect(helpers.verifyHostedGatewayAuthority(`bundle ${malformed}`, gateway)).toMatchObject({
      ok: false,
    });
  });
});

describe('verifyPackagedAuthAuthority', () => {
  const releaseA =
    'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END';
  const gateway = 'https://hosted.dnaforge.com';
  const releaseB =
    'DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=https://hosted.dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END';

  it('requires exactly the canonical web authority for Release A', () => {
    expect(helpers.verifyPackagedAuthAuthority(`bundle ${releaseA}`, null)).toMatchObject({
      ok: true,
      kind: 'release-a',
      origin: 'https://dnaforge.com',
    });
    expect(helpers.verifyPackagedAuthAuthority('bundle', null)).toMatchObject({ ok: false });
  });

  it('requires Release B auth to use the exact Hosted gateway proxy', () => {
    expect(helpers.verifyPackagedAuthAuthority(`bundle ${releaseB}`, gateway)).toMatchObject({
      ok: true,
      kind: 'release-b',
      origin: gateway,
    });
    expect(
      helpers.verifyPackagedAuthAuthority(`bundle ${releaseB} ${releaseB}`, gateway)
    ).toMatchObject({
      ok: true,
      kind: 'release-b',
      origin: gateway,
    });
    expect(
      helpers.verifyPackagedAuthAuthority(`bundle ${releaseB}`, 'https://other.example')
    ).toMatchObject({ ok: false, kind: 'release-b', origin: gateway });
  });

  it.each([
    `bundle ${releaseA} ${releaseB}`,
    'bundle DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=http://hosted.dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END',
    'bundle DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=https://hosted.dnaforge.com/path::DESKTOP_AUTH_AUTHORITY_V1::END',
  ])('rejects ambiguous or malformed packaged auth authority', (bundle) => {
    expect(helpers.verifyPackagedAuthAuthority(bundle, gateway)).toMatchObject({ ok: false });
  });
});

describe('hostedGatewayExpectationFromEnv', () => {
  it('maps the absent or exact zero flag to Release A', () => {
    expect(helpers.hostedGatewayExpectationFromEnv({})).toBeNull();
    expect(
      helpers.hostedGatewayExpectationFromEnv({
        DNAFORGE_RELEASE_B_HOSTED: '0',
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://ignored.example',
      })
    ).toBeNull();
  });

  it('maps exact one plus an HTTPS origin to Release B', () => {
    expect(
      helpers.hostedGatewayExpectationFromEnv({
        DNAFORGE_RELEASE_B_HOSTED: '1',
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted.dnaforge.com/',
      })
    ).toBe('https://hosted.dnaforge.com');
  });

  it('fails malformed flags and gateway locations before package verification', () => {
    expect(() =>
      helpers.hostedGatewayExpectationFromEnv({ DNAFORGE_RELEASE_B_HOSTED: 'true' })
    ).toThrow(/exactly 1 or 0/);
    expect(() =>
      helpers.hostedGatewayExpectationFromEnv({
        DNAFORGE_RELEASE_B_HOSTED: '1',
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted.dnaforge.com/path',
      })
    ).toThrow(/canonical HTTPS origin/);
  });
});

describe('packagedHelperIntegrityProblem', () => {
  const executableFile = (size: number, mode = 0o100755) => ({
    isFile: () => true,
    size,
    mode,
  });

  it('accepts a compiled executable-shaped helper', () => {
    expect(
      helpers.packagedHelperIntegrityProblem(
        executableFile(1_000_000),
        Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
      )
    ).toBeNull();
  });

  it('rejects a checked-out Git LFS pointer with an explicit diagnosis', () => {
    const pointer =
      'version https://git-lfs.github.com/spec/v1\n' +
      'oid sha256:0123456789abcdef\n' +
      'size 1380528\n';
    expect(
      helpers.packagedHelperIntegrityProblem(executableFile(Buffer.byteLength(pointer)), pointer)
    ).toBe('is a Git LFS pointer, not a compiled executable');
  });

  it('rejects any other pointer-sized placeholder', () => {
    expect(
      helpers.packagedHelperIntegrityProblem(executableFile(128), 'truncated helper checkout')
    ).toBe('is only 128 bytes (Git LFS pointer-sized), not a compiled executable');
  });

  it('rejects a non-executable helper', () => {
    expect(
      helpers.packagedHelperIntegrityProblem(executableFile(1_000_000, 0o100644), 'binary')
    ).toBe('is not executable');
  });

  it('does not apply POSIX execute-bit semantics to a Windows PE executable', () => {
    expect(
      helpers.packagedHelperIntegrityProblem(
        executableFile(1_000_000, 0o100644),
        Buffer.from('MZ'),
        'win32'
      )
    ).toBeNull();
  });

  it('rejects a directory at the helper path', () => {
    expect(
      helpers.packagedHelperIntegrityProblem(
        { isFile: () => false, size: 1_000_000, mode: 0o40755 },
        ''
      )
    ).toBe('is not a regular file');
  });
});

describe('native coverage package contract', () => {
  const packagedHelperSha256 = 'a'.repeat(64);
  const sourceContract: NativeCoverageContract = {
    schema: 'dnaforge.native-coverage-contract.v1',
    cacheContract: 'coverage-pyramid-v6-immutable-engine-source-accessory-contract',
    engineIdentity: `dna-coverage:schema-1:sha256-${packagedHelperSha256}`,
  };

  it('parses only the exact frozen-sidecar contract shape', () => {
    expect(
      helpers.parseNativeCoverageContractProbe(JSON.stringify(sourceContract), 'source probe')
    ).toEqual(sourceContract);
    expect(() =>
      helpers.parseNativeCoverageContractProbe(
        JSON.stringify({ ...sourceContract, ignored: true }),
        'packaged probe'
      )
    ).toThrow('unexpected fields');
  });

  it('accepts source and frozen contracts bound to the signed packaged helper', () => {
    expect(
      helpers.nativeCoverageContractProblem({
        sourceContract,
        packagedContract: sourceContract,
        packagedHelperSha256,
        packagedHelperSchema: 1,
      })
    ).toBeNull();
  });

  it('rejects a stale frozen cache contract', () => {
    expect(
      helpers.nativeCoverageContractProblem({
        sourceContract,
        packagedContract: {
          ...sourceContract,
          cacheContract: 'coverage-pyramid-v5-fine8bp-bam-index-reference-contract',
        },
        packagedHelperSha256,
        packagedHelperSchema: 1,
      })
    ).toContain('differs from source');
  });

  it('rejects a frozen identity that does not hash the actual signed helper', () => {
    expect(
      helpers.nativeCoverageContractProblem({
        sourceContract: {
          ...sourceContract,
          engineIdentity: `dna-coverage:schema-1:sha256-${'b'.repeat(64)}`,
        },
        packagedContract: {
          ...sourceContract,
          engineIdentity: `dna-coverage:schema-1:sha256-${'b'.repeat(64)}`,
        },
        packagedHelperSha256,
        packagedHelperSchema: 1,
      })
    ).toContain('differs from actual signed packaged helper');
  });

  it('rejects a frozen identity with a different helper schema', () => {
    expect(
      helpers.nativeCoverageContractProblem({
        sourceContract: {
          ...sourceContract,
          engineIdentity: `dna-coverage:schema-2:sha256-${packagedHelperSha256}`,
        },
        packagedContract: {
          ...sourceContract,
          engineIdentity: `dna-coverage:schema-2:sha256-${packagedHelperSha256}`,
        },
        packagedHelperSha256,
        packagedHelperSchema: 1,
      })
    ).toContain('differs from packaged helper schema');
  });
});

describe('codexAppServerBinaryPath', () => {
  it('builds the packaged binary path from the manifest target', () => {
    const p = helpers.codexAppServerBinaryPath('/tmp/resources', {
      triple: 'aarch64-apple-darwin',
      codexBinaryPathInPackage: 'vendor/aarch64-apple-darwin/bin/codex',
    });
    expect(p).toBe('/tmp/resources/binaries/codex-app-server/aarch64-apple-darwin/bin/codex');
  });

  it('keeps the .exe extension on Windows targets', () => {
    const p = helpers.codexAppServerBinaryPath('/tmp/resources', {
      triple: 'x86_64-pc-windows-msvc',
      codexBinaryPathInPackage: 'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    });
    expect(p).toBe('/tmp/resources/binaries/codex-app-server/x86_64-pc-windows-msvc/bin/codex.exe');
  });
});

describe('codexAppServerIntegrityProblem', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-verify-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function sha(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  function makePackagedTriple(binaryBody: string, packageJsonBody: string, mode = 0o755) {
    const base = path.join(tmp, 'binaries', 'codex-app-server', 'aarch64-apple-darwin');
    const binDir = path.join(base, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'codex'), binaryBody, { mode });
    writeFileSync(path.join(base, 'codex-package.json'), packageJsonBody);
    return { base, binaryBody, packageJsonBody };
  }

  function manifestFor(input: {
    key?: string;
    triple?: string;
    binaryName?: string;
    verified?: boolean;
    binarySha256: string;
    packageJsonSha256: string;
  }) {
    const key = input.key ?? 'darwin-arm64';
    const triple = input.triple ?? 'aarch64-apple-darwin';
    const binaryName = input.binaryName ?? 'codex';
    const binaryPath = `vendor/${triple}/bin/${binaryName}`;
    const packageJsonPath = `vendor/${triple}/codex-package.json`;
    return {
      supportedTargets: {
        [key]: {
          verified: input.verified ?? true,
          triple,
          codexBinaryPathInPackage: binaryPath,
          codexBinarySha256: input.binarySha256,
          codexPackageJsonPathInPackage: packageJsonPath,
          codexPackageJsonSha256: input.packageJsonSha256,
          resources: [
            {
              pathInPackage: binaryPath,
              sha256: input.binarySha256,
              executable: true,
            },
            {
              pathInPackage: packageJsonPath,
              sha256: input.packageJsonSha256,
              executable: false,
            },
          ],
        },
      },
      license: { files: [] },
    };
  }

  it('returns null for a valid, digest-matching staged binary', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    const { binaryBody: b, packageJsonBody: pj } = makePackagedTriple(binaryBody, packageJsonBody);

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest: manifestFor({
        binarySha256: sha(b),
        packageJsonSha256: sha(pj),
      }),
    });

    expect(result).toBeNull();
  });

  it('fails for a missing binary', () => {
    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest: manifestFor({
        binarySha256: 'a'.repeat(64),
        packageJsonSha256: 'b'.repeat(64),
      }),
    });

    expect(result).toContain('is missing');
  });

  it('fails for an unverified target', () => {
    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'x64',
      resourcesDir: tmp,
      manifest: manifestFor({
        key: 'darwin-x64',
        triple: 'x86_64-apple-darwin',
        verified: false,
        binarySha256: 'a'.repeat(64),
        packageJsonSha256: 'b'.repeat(64),
      }),
    });

    expect(result).toContain('not verified');
  });

  it('fails for a binary with the wrong digest', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    makePackagedTriple(binaryBody, packageJsonBody);

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest: manifestFor({
        binarySha256: '0'.repeat(64),
        packageJsonSha256: '0'.repeat(64),
      }),
    });

    expect(result).toContain('digest mismatch');
  });

  it('fails for a non-executable binary', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    const { binaryBody: b, packageJsonBody: pj } = makePackagedTriple(
      binaryBody,
      packageJsonBody,
      0o644
    );

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest: manifestFor({
        binarySha256: sha(b),
        packageJsonSha256: sha(pj),
      }),
    });

    expect(result).toContain('not executable');
  });

  it('fails when an inventoried auxiliary executable is missing', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    const { binaryBody: b, packageJsonBody: pj } = makePackagedTriple(binaryBody, packageJsonBody);
    const manifest = manifestFor({
      binarySha256: sha(b),
      packageJsonSha256: sha(pj),
    });
    manifest.supportedTargets['darwin-arm64'].resources.push({
      pathInPackage: 'vendor/aarch64-apple-darwin/bin/codex-code-mode-host',
      sha256: 'c'.repeat(64),
      executable: true,
    });

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest,
    });

    expect(result).toContain('resource is missing');
  });

  it('rejects a manifest resource path that escapes the pinned target root', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    const { binaryBody: b, packageJsonBody: pj } = makePackagedTriple(binaryBody, packageJsonBody);
    const manifest = manifestFor({
      binarySha256: sha(b),
      packageJsonSha256: sha(pj),
    });
    manifest.supportedTargets['darwin-arm64'].resources.push({
      pathInPackage: 'vendor/aarch64-apple-darwin/../../../outside-runtime',
      sha256: 'c'.repeat(64),
      executable: false,
    });

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest,
    });

    expect(result).toContain('escapes vendor/aarch64-apple-darwin/');
  });

  it('fails when the staged tree contains an unrecorded file', () => {
    const binaryBody = 'x'.repeat(3000);
    const packageJsonBody = JSON.stringify({ version: '0.148.0' });
    const {
      base,
      binaryBody: b,
      packageJsonBody: pj,
    } = makePackagedTriple(binaryBody, packageJsonBody);
    writeFileSync(path.join(base, 'unexpected'), 'not inventoried');

    const result = helpers.codexAppServerIntegrityProblem({
      platform: 'darwin',
      arch: 'arm64',
      resourcesDir: tmp,
      manifest: manifestFor({
        binarySha256: sha(b),
        packageJsonSha256: sha(pj),
      }),
    });

    expect(result).toContain('staged inventory mismatch');
  });
});
