#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStylingChecker } from '../packages/ui/components/src/menu/styling-check.mjs';
const {
  checkDesktopUiStyling,
  checkDesktopUiStylingChange,
  RETIRED_UI_STYLE_FINGERPRINTS,
  production,
  sourcePaths: contextPaths,
} = createStylingChecker();
export { checkDesktopUiStyling, checkDesktopUiStylingChange, RETIRED_UI_STYLE_FINGERPRINTS };
const REPOSITORY = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const git = (args) =>
  execFileSync('git', args, {
    cwd: REPOSITORY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
function versions(revisions, paths) {
  const queries = [
    ...new Set(revisions.flatMap((revision) => paths.map((path) => `${revision}:${path}`))),
  ];
  if (queries.some((query) => /[\r\n]/u.test(query)))
    throw new Error('Styling source paths cannot contain line separators.');
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPOSITORY,
    input: `${queries.join('\n')}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const sources = new Map();
  let offset = 0;
  for (const query of queries) {
    const end = output.indexOf(10, offset);
    if (end < 0) throw new Error(`Incomplete Git source response for ${query}.`);
    const header = output.toString('utf8', offset, end);
    offset = end + 1;
    if (header === `${query} missing`) {
      sources.set(query, null);
      continue;
    }
    const match = /^[a-f0-9]+ blob (\d+)$/u.exec(header);
    if (!match) throw new Error(`Unexpected Git source response for ${query}.`);
    const length = Number(match[1]);
    if (output[offset + length] !== 10) throw new Error(`Incomplete Git source body for ${query}.`);
    sources.set(query, output.toString('utf8', offset, offset + length));
    offset += length + 1;
  }
  return sources;
}

export function main(argv = process.argv.slice(2)) {
  let base, candidate, range, incomingRevision;
  if (argv[0] === '--staged') {
    try {
      incomingRevision = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD^{commit}']).trim();
    } catch {}
  }
  if (argv.length === 1 && argv[0] === '--staged') {
    base = 'HEAD';
    candidate = '';
    range = ['--cached', base];
  } else if (argv.length === 2 && argv[0] === '--base' && /^[a-f0-9]{7,40}$/iu.test(argv[1])) {
    base = git(['rev-parse', '--verify', `${argv[1]}^{commit}`]).trim();
    candidate = 'HEAD';
    range = [base, candidate];
  } else throw new Error('usage: guard-ui-styling.mjs --staged | --base <sha>');
  const paths = git(['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z', ...range])
    .split('\0')
    .filter(production);
  const before = new Map(),
    after = new Map();
  const sourcePaths = [...new Set([...paths, ...contextPaths])];
  const sources = versions(
    [base, candidate, ...(incomingRevision ? [incomingRevision] : [])],
    sourcePaths
  );
  for (const path of sourcePaths) {
    const previous = sources.get(`${base}:${path}`),
      source = sources.get(`${candidate}:${path}`);
    if (previous !== null) before.set(path, previous);
    if (source !== null) after.set(path, source);
  }
  const incoming = new Map(
    sourcePaths
      .map((path) => [path, sources.get(`${incomingRevision}:${path}`)])
      .filter(([, source]) => typeof source === 'string')
  );
  const violations = checkDesktopUiStylingChange({ before, after, incoming });
  if (violations.length) {
    for (const finding of violations)
      console.error(
        `${finding.path}:${finding.line}:${finding.column} [${finding.rule}] ${finding.property}: ${finding.value}\n  ${finding.fix}`
      );
    console.error('See the shared menu appearance owners and canonical host controls.');
    return 1;
  }
  console.log(
    `UI styling passed (${paths.length} changed production file${paths.length === 1 ? '' : 's'}; exact prior debt only).`
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`UI styling analysis failed: ${error.message}`);
    process.exitCode = 1;
  }
}
