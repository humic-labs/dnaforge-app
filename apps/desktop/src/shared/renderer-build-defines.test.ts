// @vitest-environment node

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import type { ConfigEnv } from 'vite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hostedElectronSessionAlias } from '../../vite.renderer.config';

import {
  MAC_TEAM_ID_CUTOVER_RENDERER_DISABLED_MARKER,
  MAC_TEAM_ID_CUTOVER_RENDERER_ENABLED_MARKER,
  MAIN_ONLY_DECLARED_GLOBALS,
  RENDERER_DEFINE_KEYS,
  createRendererDefines,
  macTeamIdCutoverRendererMarker,
  testRendererDefineValues,
} from './renderer-build-defines';
import {
  HOSTED_AI_RENDERER_DISABLED_MARKER,
  HOSTED_AI_RENDERER_ENABLED_MARKER,
} from './hosted-ai-build-policy';

vi.mock('../main/build-source-fingerprint', () => ({
  BUILD_SOURCE_GIT_EXECUTABLE: process.platform === 'win32' ? 'git.exe' : '/usr/bin/git',
  getRuntimeSourceFingerprint: () => 'test-fingerprint',
  computeRuntimeSourceFingerprint: () => 'test-fingerprint',
  RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS: [],
  RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS: [],
}));

const DESKTOP_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..');
const SRC_ROOT = join(DESKTOP_ROOT, 'src');

describe('Hosted workspace-session alias boundary', () => {
  const sessionRoot = join(SRC_ROOT, 'features/workspace-session');
  const hostedSession = join(sessionRoot, 'hosted-session.ts');
  const publicBarrel = join(sessionRoot, 'public/electron-session.ts');
  const runtimeMarker = 'Workspace resource identity conflicts at';

  it.each([
    join(sessionRoot, 'electron-session.ts'),
    join(sessionRoot, 'electron-session'),
    '@/features/workspace-session/electron-session',
    '../workspace-session/electron-session',
    publicBarrel,
    publicBarrel.replace(/\.ts$/u, ''),
    '@/features/workspace-session/public/electron-session',
  ])('redirects the canonical Electron session target %s', (id) => {
    expect(hostedElectronSessionAlias('hosted').resolveId(id)).toBe(hostedSession);
  });

  it('redirects the actual public barrel re-export to the Hosted session', () => {
    const edge = ts
      .preProcessFile(readFileSync(publicBarrel, 'utf8'), true, true)
      .importedFiles.find((entry) => /electron-session(?:\.ts)?$/.test(entry.fileName));
    if (!edge) throw new Error('The public Electron session barrel has no session export.');
    expect(hostedElectronSessionAlias('hosted').resolveId(edge.fileName, publicBarrel)).toBe(
      hostedSession
    );
  });

  it('resolves Windows separators in the public barrel re-export', () => {
    expect(
      hostedElectronSessionAlias('hosted').resolveId(
        '..\\electron-session',
        publicBarrel.replace(/\//g, '\\')
      )
    ).toBe(hostedSession);
  });

  it('keeps neighboring relative modules outside the alias', () => {
    const plugin = hostedElectronSessionAlias('hosted');
    expect(
      plugin.resolveId('./electron-session', join(sessionRoot, 'neighbor/other.ts'))
    ).toBeNull();
    expect(plugin.resolveId('../hosted-session', publicBarrel)).toBeNull();
    expect(plugin.resolveId('electron', publicBarrel)).toBeNull();
  });

  it.each(['development', 'test', 'production'])('keeps the %s Electron target intact', (mode) => {
    const plugin = hostedElectronSessionAlias(mode);
    expect(plugin.resolveId('../electron-session', publicBarrel)).toBeNull();
    expect(() =>
      plugin.generateBundle({}, { native: { type: 'chunk', code: runtimeMarker } })
    ).not.toThrow();
  });

  it('still rejects the Electron runtime marker in a Hosted chunk', () => {
    expect(() =>
      hostedElectronSessionAlias('hosted').generateBundle(
        {},
        { leaked: { type: 'chunk', code: runtimeMarker } }
      )
    ).toThrow(
      'Hosted build included the Electron workspace runtime. electron-session must resolve to hosted-session.ts.'
    );
  });

  it('accepts a Hosted chunk and non-executable assets', () => {
    expect(() =>
      hostedElectronSessionAlias('hosted').generateBundle(
        {},
        {
          hosted: { type: 'chunk', code: 'export const runtime = "hosted";' },
          asset: { type: 'asset', code: runtimeMarker },
        }
      )
    ).not.toThrow();
  });
});

const ALLOWED_KEYS = new Set<string>(RENDERER_DEFINE_KEYS);

const NON_RENDERER_DIRS = new Set(['main', 'preload']);

function collectSourceFiles(dir: string, acc: string[] = [], isDesktopSrc = false): string[] {
  const rootStat = statSync(dir);
  if (rootStat.isFile()) {
    if (/\.tsx?$/.test(dir) && !dir.endsWith('.d.ts') && !/\.(test|spec)\.tsx?$/.test(dir)) {
      acc.push(dir);
    }
    return collectSourceFiles(dirname(dir), acc, isDesktopSrc);
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (isDesktopSrc && dir === SRC_ROOT && NON_RENDERER_DIRS.has(entry)) continue;
      if (entry === 'node_modules' || entry === '__snapshots__' || entry === 'dist') continue;
      collectSourceFiles(full, acc, isDesktopSrc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (entry.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

const DEFINE_NAME = /^__[A-Z][A-Z0-9_]*__$/;

function findUnboundDefineReads(source: string, fileName: string): string[] {
  if (!source.includes('__') && !source.includes('\\u')) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bound = new Set<string>();
  const reads: ts.Identifier[] = [];

  const isAmbient = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      const mods = (n as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
      if (ts.isSourceFile(n)) break;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      DEFINE_NAME.test(node.name.text) &&
      !isAmbient(node)
    ) {
      bound.add(node.name.text);
    }

    if (ts.isIdentifier(node) && DEFINE_NAME.test(node.text)) {
      const p = node.parent;
      const isName =
        ((ts.isPropertyAccessExpression(p) ||
          ts.isPropertySignature(p) ||
          ts.isPropertyAssignment(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isMethodSignature(p) ||
          ts.isEnumMember(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isClassDeclaration(p) ||
          ts.isImportSpecifier(p)) &&
          (p as { name?: ts.Node }).name === node) ||
        ts.isTypeReferenceNode(p) ||
        ts.isQualifiedName(p);
      if (!isName) reads.push(node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return reads.map((r) => r.text).filter((name) => !bound.has(name));
}

describe('renderer define identifier scan', () => {
  it.each([
    {
      name: 'source without protected identifiers',
      source: 'const value = 1;',
      expected: [],
    },
    {
      name: 'unbound expression read',
      source: 'const value = __MISSING__;',
      expected: ['__MISSING__'],
    },
    {
      name: 'ternary consequent',
      source: 'const value = import.meta.env.DEV ? __MISSING__ : "";',
      expected: ['__MISSING__'],
    },
    {
      name: 'Unicode-escaped underscores without a literal double underscore',
      source: 'const value = \\u005f\\u005fMISSING\\u005f\\u005f;',
      expected: ['__MISSING__'],
    },
    {
      name: 'real local binding',
      source: 'const __LOCAL__ = 1; const value = __LOCAL__;',
      expected: [],
    },
    {
      name: 'ambient declaration with an unbound read',
      source: 'declare const __MISSING__: string; const value = __MISSING__;',
      expected: ['__MISSING__'],
    },
    {
      name: 'property names',
      source: 'const value = window.__MISSING__; const object = { __MISSING__: 1 };',
      expected: [],
    },
    {
      name: 'type positions',
      source: 'type Value = __MISSING__; type Object = { __MISSING__: string };',
      expected: [],
    },
  ])('preserves $name', ({ source, expected }) => {
    expect(findUnboundDefineReads(source, 'fixture.tsx')).toEqual(expected);
  });
});
const resolvedConfigs = new Map<string, Promise<Record<string, unknown>>>();

async function resolveConfig(
  importPath: string,
  pick: (config: Record<string, unknown>) => Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  let pending = resolvedConfigs.get(importPath);
  if (!pending) {
    pending = (async () => {
      const mod = (await import(importPath)) as { default: unknown };
      const raw = mod.default;
      return (
        typeof raw === 'function'
          ? await (raw as (env: ConfigEnv) => unknown)({
              command: 'serve',
              mode: 'test',
              isSsrBuild: false,
              isPreview: false,
            })
          : raw
      ) as Record<string, unknown>;
    })();
    resolvedConfigs.set(importPath, pending);
  }
  return (pick(await pending) ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  await resolveConfig('../../electron.vite.config', (config) => config);
});

describe('unbound renderer define reads', () => {
  it.each([
    ['ternary consequent', "const value = ready ? __MISSING__ : '';", ['__MISSING__']],
    [
      'Unicode-escaped identifier',
      'const value = \\u005f\\u005fMISSING\\u005f\\u005f;',
      ['__MISSING__'],
    ],
    [
      'ambient declaration',
      'declare const __MISSING__: string; const value = __MISSING__;',
      ['__MISSING__'],
    ],
    ['runtime binding', "const __LOCAL__ = ''; const value = __LOCAL__;", []],
    ['comments and strings', "const value = '__STRING__'; // __COMMENT__", []],
  ] as const)('preserves the AST rule for %s', (_label, source, expected) => {
    expect(findUnboundDefineReads(source, 'renderer.tsx')).toEqual(expected);
  });
});

function defineKeysOf(section: Record<string, unknown>): string[] {
  return Object.keys((section.define ?? {}) as Record<string, unknown>).sort();
}

const RENDERER_CONFIGS: Array<{
  label: string;
  importPath: string;
  pick: (c: Record<string, unknown>) => Record<string, unknown> | undefined;
}> = [
  {
    label: 'electron.vite.config.ts renderer section (dev + packaged app)',
    importPath: '../../electron.vite.config',
    pick: (c) => c.renderer as Record<string, unknown>,
  },
  {
    label: 'vite.renderer.config.ts (standalone renderer — CI L2 Desktop E2E)',
    importPath: '../../vite.renderer.config',
    pick: (c) => c,
  },
  {
    label: 'vitest.config.ts (L0/L1 unit + component tests)',
    importPath: '../../vitest.config',
    pick: (c) => c,
  },
  {
    label: 'vitest.integration.config.ts (AI integration suites)',
    importPath: '../../vitest.integration.config',
    pick: (c) => c,
  },
];

describe('renderer build-time define contract', () => {
  it('includes the dormant macOS Team ID cutover gate in every renderer build', () => {
    expect(RENDERER_DEFINE_KEYS).toContain('__DNAFORGE_MAC_TEAM_ID_CUTOVER__');
    expect(RENDERER_DEFINE_KEYS).toContain('__DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER_MARKER__');
    expect(
      createRendererDefines(testRendererDefineValues({ macTeamIdCutoverEnabled: true }))
        .__DNAFORGE_MAC_TEAM_ID_CUTOVER__
    ).toBe('true');
    expect(macTeamIdCutoverRendererMarker(true)).toBe(MAC_TEAM_ID_CUTOVER_RENDERER_ENABLED_MARKER);
    expect(macTeamIdCutoverRendererMarker(false)).toBe(
      MAC_TEAM_ID_CUTOVER_RENDERER_DISABLED_MARKER
    );
  });

  it('createRendererDefines produces exactly RENDERER_DEFINE_KEYS', () => {
    const produced = Object.keys(createRendererDefines(testRendererDefineValues())).sort();
    expect(produced).toEqual([...RENDERER_DEFINE_KEYS].sort());
  });

  it('carries an explicit Hosted availability value and artifact marker', () => {
    expect(RENDERER_DEFINE_KEYS).toContain('__DNAFORGE_HOSTED_AI_ENABLED__');
    expect(RENDERER_DEFINE_KEYS).toContain('__DNAFORGE_HOSTED_AI_RENDERER_MARKER__');
    expect(
      createRendererDefines(
        testRendererDefineValues({
          hostedAiEnabled: false,
          hostedAiMarker: HOSTED_AI_RENDERER_DISABLED_MARKER,
        })
      )
    ).toMatchObject({
      __DNAFORGE_HOSTED_AI_ENABLED__: 'false',
      __DNAFORGE_HOSTED_AI_RENDERER_MARKER__: JSON.stringify(HOSTED_AI_RENDERER_DISABLED_MARKER),
    });
    expect(testRendererDefineValues()).toMatchObject({
      hostedAiEnabled: true,
      hostedAiMarker: HOSTED_AI_RENDERER_ENABLED_MARKER,
    });
  });

  it('the real Electron config keeps main and renderer package identity aligned', async () => {
    const main = await resolveConfig(
      '../../electron.vite.config',
      (config) => config.main as Record<string, unknown>
    );
    const renderer = await resolveConfig(
      '../../electron.vite.config',
      (config) => config.renderer as Record<string, unknown>
    );
    const mainDefines = main.define as Record<string, string>;
    const rendererDefines = renderer.define as Record<string, string>;
    const build = JSON.parse(rendererDefines.__DNAFORGE_APP_BUILD__);
    expect(build.kind).toBe('test');
    expect(build.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof build.sourceModified).toBe('boolean');
    expect(JSON.parse(mainDefines.__DNAFORGE_APP_BUILD__)).toEqual(build);
    expect(JSON.parse(mainDefines.__APP_VERSION__)).toBe(build.version ?? 'unknown');
    expect(JSON.parse(rendererDefines.__APP_VERSION__)).toBe(build.version ?? 'unknown');
  });

  it('vite-env.d.ts declares every renderer define and nothing undeclared', () => {
    const declared = [
      ...readFileSync(join(SRC_ROOT, 'vite-env.d.ts'), 'utf-8').matchAll(
        /declare\s+(?:const|let|var)\s+(__[A-Z0-9_]+__)\s*:/g
      ),
    ].map((m) => m[1]);

    const expected = [...RENDERER_DEFINE_KEYS, ...MAIN_ONLY_DECLARED_GLOBALS].sort();
    expect([...declared].sort()).toEqual(expected);
  });

  it('every build-time global referenced by renderer-bundled source is defined', async () => {
    const roots = new Set<string>([SRC_ROOT]);
    for (const cfg of RENDERER_CONFIGS) {
      const section = await resolveConfig(cfg.importPath, cfg.pick);
      const aliases = ((section.resolve ?? {}) as Record<string, unknown>).alias ?? {};
      for (const target of Object.values(aliases as Record<string, string>)) {
        if (typeof target !== 'string') continue;
        const abs = isAbsolute(target) ? target : resolve(DESKTOP_ROOT, target);

        if (!abs.startsWith(join(REPO_ROOT, 'packages'))) continue;
        if (existsSync(abs)) roots.add(abs);
      }
    }

    expect(
      roots.size,
      'Expected renderer-aliased workspace packages to be discovered from the configs'
    ).toBeGreaterThan(1);

    const offenders: string[] = [];
    const files = new Set(
      [...roots].flatMap((root) => collectSourceFiles(root, [], root === SRC_ROOT))
    );
    for (const file of files) {
      for (const name of findUnboundDefineReads(readFileSync(file, 'utf-8'), file)) {
        if (ALLOWED_KEYS.has(name)) continue;
        offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${name}`);
      }
    }

    expect(
      offenders,
      'Renderer-bundled source references a build-time global that no renderer ' +
        'Vite config defines. Add it to RendererDefineValues + DEFINE_KEY_BY_FIELD ' +
        'in src/shared/renderer-build-defines.ts (see ).'
    ).toEqual([]);
  }, 60_000);
});

describe('every renderer Vite config supplies the full define set', () => {
  for (const cfg of RENDERER_CONFIGS) {
    it(cfg.label, async () => {
      const section = await resolveConfig(cfg.importPath, cfg.pick);
      expect(defineKeysOf(section)).toEqual([...RENDERER_DEFINE_KEYS].sort());
    });
  }

  it('the test configs inject inert values, not just inert defaults', async () => {
    const testConfigs = RENDERER_CONFIGS.filter((c) => c.importPath.includes('vitest'));
    expect(testConfigs.length).toBeGreaterThan(0);

    for (const cfg of testConfigs) {
      const section = await resolveConfig(cfg.importPath, cfg.pick);
      const define = (section.define ?? {}) as Record<string, string>;
      expect(JSON.parse(define.__DNAFORGE_APP_BUILD__)).toBeNull();
      const nonInert = Object.entries(define)

        .filter(
          ([key]) =>
            key !== '__APP_VERSION__' &&
            key !== '__DNAFORGE_APP_BUILD__' &&
            key !== '__DNAFORGE_HOSTED_AI_ENABLED__' &&
            key !== '__DNAFORGE_HOSTED_AI_RENDERER_MARKER__'
        )
        .filter(([, raw]) => {
          const value = JSON.parse(raw) as unknown;
          return value !== '' && value !== false;
        });

      expect(
        nonInert,
        `${cfg.label}: a non-empty placeholder silently changes behaviour where ` +
          'the constant used to be undefined (see ).'
      ).toEqual([]);
    }
  });
});
