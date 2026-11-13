// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  documentOpeningViolations,
  needsDocumentOpeningAst,
} from './boundary-analysis.test-harness';

const cases = [
  {
    name: 'aliased runtime import',
    source: "import { openSequenceFile as open } from '../sequence/openSequenceFile';",
    expected: ['features/example/caller.tsx: bypasses coordinator'],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'two imported entrypoints preserve duplicate diagnostics',
    source:
      "import { openSequenceFile as a, openSequenceFileResult as b } from '../sequence/openSequenceFile';",
    expected: [
      'features/example/caller.tsx: bypasses coordinator',
      'features/example/caller.tsx: bypasses coordinator',
    ],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'type-only declaration',
    source: "import type { openSequenceFile } from '../sequence/openSequenceFile';",
    expected: [],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'type-only named binding',
    source: "import { type openSequenceFile } from '../sequence/openSequenceFile';",
    expected: [],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'mixed named bindings',
    source:
      "import { type openSequenceFile, openSequenceDocument as open } from '../sequence/openSequenceFile';",
    expected: ['features/example/caller.tsx: bypasses coordinator'],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'coordinator runtime import',
    source: "import { openSequenceFile } from '../sequence/openSequenceFile';",
    expected: [],
    file: 'features/document-opening/open-document.ts',
  },
  {
    name: 'coordinator dynamic import',
    source: "async function open(){return import('../structure-files/openStructureFile');}",
    expected: [],
    file: 'features/document-opening/open-document.ts',
  },
  {
    name: 'nested dynamic import',
    source: "function outer(){return ()=>Promise.resolve(import('../sequence/openSequenceFile'));}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'unicode escaped dynamic module',
    source: "async function open(){return import('../sequence/openSeque\\u006eceFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'hex escaped dynamic module',
    source: "async function open(){return import('../sequence/openSeque\\x6eceFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'code-point escaped dynamic module',
    source: "async function open(){return import('../sequence/openSeque\\u{6e}ceFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'line continuation escaped dynamic module',
    source: "async function open(){return import('../sequence/openSeque\\\nnceFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'escaped static module and binding alias',
    source: "import { openSequenceDocument as open } from '../sequence/openSeque\\u006eceFile';",
    expected: ['features/example/caller.tsx: bypasses coordinator'],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'escaped structure module',
    source: "async function open(){return import('../structure-files/openStruc\\u0074ureFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'exact main diagnostics exception holdNextStructureOpenBeforeCommitForTest',
    source:
      "async function register(){const { holdNextStructureOpenBeforeCommitForTest } = await import('./features/structure-files/openStructureFile');}",
    expected: [],
    file: 'main.tsx',
  },
  {
    name: 'exact main diagnostics exception getStructureOpenCancellationDiagnosticsForTest',
    source:
      "async function register(){const { getStructureOpenCancellationDiagnosticsForTest } = await import('./features/structure-files/openStructureFile');}",
    expected: [],
    file: 'main.tsx',
  },
  {
    name: 'main opening is not the diagnostics exception',
    source:
      "async function register(){const {openStructureFile} = await import('./features/structure-files/openStructureFile');}",
    expected: ['main.tsx: lazy bypasses coordinator'],
    file: 'main.tsx',
  },
  {
    name: 'near main exception spelling',
    source:
      "async function register(){const {getStructureOpenCancellationDiagnosticForTest} = await import('./features/structure-files/openStructureFile');}",
    expected: ['main.tsx: lazy bypasses coordinator'],
    file: 'main.tsx',
  },
  {
    name: 'main exception is not global',
    source:
      "async function register(){const {holdNextStructureOpenBeforeCommitForTest} = await import('./features/structure-files/openStructureFile');}",
    expected: ['features/example/caller.tsx: lazy bypasses coordinator'],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'unrelated source needs no AST',
    source: 'export const value = 1;',
    expected: [],
    file: 'features/example/caller.tsx',
    parse: false,
  },
  {
    name: 'ambiguous unrelated escape retains AST',
    source: "export const value = '\\n';",
    expected: [],
    file: 'features/example/caller.tsx',
    parse: true,
  },
  {
    name: 'unrelated module suffix',
    source: "import {openSequenceFile} from '../sequence/openSequenceFileExtra';",
    expected: [],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'comments and strings retain original parser interpretation',
    source:
      "// import {openSequenceFile} from '../sequence/openSequenceFile'\nconst text = 'openStructureFile';",
    expected: [],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'template dynamic import retains original StringLiteral rule',
    source: 'async function open(){return import(`../sequence/openSequenceFile`);}',
    expected: [],
    file: 'features/example/caller.tsx',
  },
  {
    name: 'presenter raw check features/sequence/openSequenceFile.ts',
    source: 'manager.openTab(document);',
    expected: ['features/sequence/openSequenceFile.ts: bypasses presenter'],
    file: 'features/sequence/openSequenceFile.ts',
    parse: false,
  },
  {
    name: 'presenter raw check features/structure-files/openStructureFile.ts',
    source: 'manager.openTab(document);',
    expected: ['features/structure-files/openStructureFile.ts: bypasses presenter'],
    file: 'features/structure-files/openStructureFile.ts',
    parse: false,
  },
  {
    name: 'presenter raw check features/page/open-workspace-document.ts',
    source: 'manager.openTab(document);',
    expected: ['features/page/open-workspace-document.ts: bypasses presenter'],
    file: 'features/page/open-workspace-document.ts',
    parse: false,
  },
  {
    name: 'presenter raw check features/design/open-design-document.ts',
    source: 'manager.openTab(document);',
    expected: ['features/design/open-design-document.ts: bypasses presenter'],
    file: 'features/design/open-design-document.ts',
    parse: false,
  },
  {
    name: 'presenter raw check features/primers/open-primer-document.ts',
    source: 'manager.openTab(document);',
    expected: ['features/primers/open-primer-document.ts: bypasses presenter'],
    file: 'features/primers/open-primer-document.ts',
    parse: false,
  },
  {
    name: 'presenter raw check features/lims/open-entity-artifact.ts',
    source: 'manager.openTab(document);',
    expected: ['features/lims/open-entity-artifact.ts: bypasses presenter'],
    file: 'features/lims/open-entity-artifact.ts',
    parse: false,
  },
  {
    name: 'presenter alternative openInFocusedPanel',
    source: 'manager.openInFocusedPanel(document);',
    expected: ['features/page/open-workspace-document.ts: bypasses presenter'],
    file: 'features/page/open-workspace-document.ts',
    parse: false,
  },
  {
    name: 'presenter alternative openWithSmartPlacement',
    source: 'manager.openWithSmartPlacement(document);',
    expected: ['features/page/open-workspace-document.ts: bypasses presenter'],
    file: 'features/page/open-workspace-document.ts',
    parse: false,
  },
  {
    name: 'App raw check parseEntityArtifact',
    source: 'parseEntityArtifact(document);',
    expected: ['App.tsx: document preparation returned to the shell'],
    file: 'App.tsx',
    parse: false,
  },
  {
    name: 'App raw check reconcileEntityFile',
    source: 'reconcileEntityFile(document);',
    expected: ['App.tsx: document preparation returned to the shell'],
    file: 'App.tsx',
    parse: false,
  },
  {
    name: 'App raw check withWorkspaceArtifactOpen',
    source: 'withWorkspaceArtifactOpen(document);',
    expected: ['App.tsx: document preparation returned to the shell'],
    file: 'App.tsx',
    parse: false,
  },
  {
    name: 'App raw check upsertPageFromArtifact',
    source: 'upsertPageFromArtifact(document);',
    expected: ['App.tsx: document preparation returned to the shell'],
    file: 'App.tsx',
    parse: false,
  },
  {
    name: 'App raw check upsertDesignFromArtifact',
    source: 'upsertDesignFromArtifact(document);',
    expected: ['App.tsx: document preparation returned to the shell'],
    file: 'App.tsx',
    parse: false,
  },
];

describe('document-opening AST admission preserves the original rule', () => {
  for (const fixture of cases)
    it(fixture.name, () => {
      const original = documentOpeningViolations(fixture.file, fixture.file, fixture.source, true);
      const optimized = documentOpeningViolations(fixture.file, fixture.file, fixture.source);
      expect(original).toEqual(fixture.expected);
      expect(optimized).toEqual(original);
      if ('parse' in fixture) expect(needsDocumentOpeningAst(fixture.source)).toBe(fixture.parse);
    });
});
