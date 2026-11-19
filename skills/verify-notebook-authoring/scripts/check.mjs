#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { reportFailures } from './report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const groups = {
  menu: [
    'components/ui/controls.test.tsx',
    'features/page/components/NotebookLayoutControl.test.tsx',
    'features/page/editor/components/EntityMenus.transitions.test.tsx',
    'features/page/editor/components/EntityMenus.named-types.acceptance.test.tsx',
    'features/page/editor/extensions/inline-picker-scroll.test.tsx',
    'features/page/editor/components/MentionMenu.layouts.test.tsx',
    'features/page/editor/components/SlashCommandMenu.formatting.test.tsx',
    'features/page/editor/components/EntityLinkMenu.acceptance.test.tsx',
    'features/page/editor/extensions/mention.inline-authoring.test.tsx',
    'features/page/editor/extensions/mention.back-navigation.acceptance.test.tsx',
  ],
  discovery: [
    'main/entity-type-authority.integration.test.ts',
    'main/entity-discovery.projections.test.ts',
    'main/entity-discovery.named-types.acceptance.test.ts',
    'features/page/editor/lib/search.named-types.test.ts',
    'features/page/editor/lib/entity-link-picker.test.tsx',
  ],
  caret: ['features/page/editor/extensions/mention.terminal-caret.test.tsx'],
  references: [
    'features/page/editor/extensions/mention.occurrence.acceptance.test.ts',
    'shared/notebook-reference-occurrences.test.ts',
    'components/entity-reference/EntityReferenceChip.shared-presentation.test.tsx',
  ],
  tables: [
    'features/page/notebook-authoring.native-tables.test.ts',
    'features/page/embeds/table/components/TableCell.rich-content.test.tsx',
    'shared/notebook-model/table/table-data-model.occurrences.test.ts',
  ],
  retention: [
    'main/saved-entity-row-versions.test.ts',
    'main/saved-file-sources.test.ts',
    'main/notebook-package-retention.test.ts',
  ],
  registry: [
    'features/lims/components/SheetSyncManager.conflict-description.audit.test.tsx',
    'features/lims/components/SheetSyncManager.setup.test.tsx',
    'features/lims/components/registry/RegistryFilters.editing.audit.test.tsx',
    'features/lims/components/registry/RegistryFilters.search-editing.test.tsx',
    'main/__tests__/lims-registry-kind-facets.test.ts',
  ],
};
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const group = value('--group');
if (!args.includes('--group') || !groups[group] || !args.includes('--out') || !value('--out')) {
  console.error(
    'Usage: node skills/verify-notebook-authoring/scripts/check.mjs --group menu|discovery|caret|references|tables|registry --out /absolute/evidence/directory'
  );
  process.exit(1);
}
const out = resolve(value('--out'));
mkdirSync(out, { recursive: true });
const git = (...gitArgs) => {
  const run = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || 'Git source identity unavailable');
  return run.stdout.trim();
};
function fingerprint() {
  const paths = git(
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'apps/desktop/src',
    'apps/desktop/package.json',
    'apps/desktop/vitest.config.ts',
    'packages/core/scientific-artifacts/src',
    'pnpm-lock.yaml',
    'skills/verify-notebook-authoring'
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const source = createHash('sha256');
  for (const path of [...new Set(paths)]) {
    source.update(path).update('\0');
    try {
      source.update(readFileSync(resolve(root, path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source.update('DELETED');
    }
    source.update('\0');
  }
  return source.digest('hex');
}
const sourceFingerprint = fingerprint();
const branch = git('branch', '--show-current');
const head = git('rev-parse', 'HEAD');
const tests = groups[group].map((file) => `src/${file}`);
const requiredFiles = tests.map((file) => resolve(root, 'apps/desktop', file));
for (const file of requiredFiles)
  if (!statSync(file).isFile()) throw new Error(`Missing required test file: ${file}`);
const started = new Date().toISOString();
const reportPath = resolve(out, `${group}.vitest.json`);
writeFileSync(reportPath, '', { flag: 'wx' });
const run = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', ...tests, '--reporter=json', `--outputFile=${reportPath}`],
  {
    cwd: resolve(root, 'apps/desktop'),
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 12 * 1024 * 1024,
  }
);
const log = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`;
writeFileSync(resolve(out, `${group}.log`), log, { flag: 'wx' });
const finalSourceFingerprint = fingerprint();
const sourceUnchanged =
  sourceFingerprint === finalSourceFingerprint &&
  branch === git('branch', '--show-current') &&
  head === git('rev-parse', 'HEAD');
let executionFailures;
try {
  executionFailures = reportFailures(JSON.parse(readFileSync(reportPath, 'utf8')), requiredFiles);
} catch (error) {
  executionFailures = [`Unreadable runner report: ${error.message}`];
}
const componentPassed = run.status === 0 && executionFailures.length === 0;
const receipt = {
  schema: 'dnaforge.notebook-component-check.v1',
  root,
  branch,
  head,
  sourceFingerprint,
  finalSourceFingerprint,
  sourceUnchanged,
  started,
  finished: new Date().toISOString(),
  group,
  tests,
  exitCode: run.status,
  executionFailures,
  componentResult: !componentPassed
    ? 'FAILED'
    : sourceUnchanged
      ? 'PASSED'
      : 'SOURCE_CHANGED_DURING_CHECK',
  nativeAcceptance: 'UNVERIFIED',
  limitation:
    'These checks do not drive the native app. They cannot qualify visual appearance, timing, caret placement, real inventory completeness or end-to-end target navigation.',
};
writeFileSync(resolve(out, `${group}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: 'wx',
});
console.log(JSON.stringify(receipt, null, 2));
process.exit(componentPassed && sourceUnchanged ? 0 : 1);
