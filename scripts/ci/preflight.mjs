import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectDesktopReports } from './qualification.mjs';

const controlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = /^[a-f0-9]{40}$/u;
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

export function ciLane(
  eventName,
  event,
  ref,
  branches = { development: 'dev', staging: 'staging', production: 'prod' }
) {
  let target;
  if (eventName === 'pull_request') target = event?.pull_request?.base?.ref;
  else if (eventName === 'merge_group') {
    assert.ok(
      event?.merge_group?.base_ref?.startsWith('refs/heads/'),
      'Merge group requires a branch reference'
    );
    target = event.merge_group.base_ref.slice('refs/heads/'.length);
  } else if (['push', 'workflow_dispatch', 'schedule'].includes(eventName)) {
    assert.ok(ref?.startsWith('refs/heads/'), 'CI requires a branch reference');
    target = ref.slice('refs/heads/'.length);
  } else throw new Error(`Unsupported CI event: ${eventName}`);
  assert.ok(Object.values(branches).includes(target), `Unknown CI target: ${target}`);
  if (['pull_request', 'merge_group'].includes(eventName) && target === branches.development)
    return eventName === 'pull_request' && event.pull_request.draft === true
      ? 'draft'
      : 'development';
  return 'qualification';
}

export function ciBranches(policy) {
  const development = policy.repository.defaultBranch;
  const staging = Object.keys(policy.branches).find(
    (name) => policy.branches[name].upstream === development
  );
  const production = policy.release.sourceBranch;
  assert.equal(policy.branches[development]?.role, 'development');
  assert.equal(policy.branches[production]?.upstream, staging);
  assert.equal(new Set([development, staging, production]).size, 3);
  assert.ok(staging, 'Promotion branch is missing');
  return { development, staging, production };
}

export function selectPreflightWork(changedPaths, projects) {
  assert.ok(Array.isArray(changedPaths) && changedPaths.length > 0, 'Changed paths are missing');
  assert.ok(
    changedPaths.every(
      (file) =>
        typeof file === 'string' &&
        file &&
        !file.startsWith('/') &&
        !file.includes('\0') &&
        !file.split('/').includes('..')
    ),
    'Changed paths must be repository relative'
  );
  assert.ok(Array.isArray(projects), 'Project inventory is missing');
  const relevant = changedPaths.filter(
    (file) =>
      !(
        /^(?:AGENTS|README|CONTRIBUTING|MAINTAINING|CHANGELOG|CODE_OF_CONDUCT|SECURITY|NOTICE|CLA)\.md$/u.test(
          file
        ) ||
        /^(?:docs|skills)\/.+\.md$/u.test(file) ||
        file === 'LICENSE'
      )
  );
  const global = relevant.some(
    (file) =>
      !file.startsWith('apps/') && !file.startsWith('packages/') && !file.startsWith('tools/')
  );
  const unknown = relevant.some(
    (file) =>
      !file.startsWith('apps/api/') &&
      !/^tools\/dna-[^/]+\//u.test(file) &&
      !projects.some((project) => file === project.path || file.startsWith(project.path + '/'))
  );
  const selected = new Set(
    projects
      .filter((project) =>
        relevant.some((file) => file === project.path || file.startsWith(project.path + '/'))
      )
      .map((project) => project.name)
  );
  if (global || unknown) for (const project of projects) selected.add(project.name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (!selected.has(project.name) && project.dependencies?.some((name) => selected.has(name))) {
        selected.add(project.name);
        changed = true;
      }
    }
  }
  const desktopRequired =
    global ||
    unknown ||
    relevant.some(
      (file) =>
        file.startsWith('apps/desktop/') ||
        file.startsWith('packages/') ||
        file.startsWith('test-fixtures/') ||
        file.startsWith('e2e/')
    );
  return {
    desktopRequired,
    typecheckProjects: projects
      .filter((project) => project.typecheck && selected.has(project.name))
      .map((project) => project.name)
      .sort(),
    reason:
      global || unknown
        ? 'global-or-unclassified-input'
        : relevant.length
          ? 'affected-workspace-and-dependents'
          : 'documentation-only',
  };
}

function sameIdentity(manifest, report) {
  for (const key of ['sourceSha', 'sourceTree', 'baseSha', 'controlSha'])
    assert.match(manifest[key], SHA, `Invalid ${key}`);
  assert.match(manifest.runId, /^\d+$/u);
  assert.ok(Number.isInteger(manifest.attempt) && manifest.attempt > 0);
  assert.ok(
    typeof manifest.controlRef === 'string' && manifest.controlRef.length > 0,
    'Control reference is missing'
  );
  for (const key of [
    'sourceSha',
    'sourceTree',
    'baseSha',
    'controlSha',
    'controlRef',
    'runId',
    'attempt',
  ])
    assert.equal(report[key], manifest[key], `Preflight report ${key} differs from candidate`);
}

export function assessPreflight({ manifest, needs, reports, expectedFiles, skipBudget = {} }) {
  const selection = manifest.preflight;
  assert.ok(
    selection &&
      typeof selection.draft === 'boolean' &&
      typeof selection.desktopRequired === 'boolean'
  );
  assert.ok(Array.isArray(selection.typecheckProjects));
  assert.deepEqual(
    Object.keys(needs).sort(),
    ['plan', 'syntax', 'typecheck', 'desktop-discovery', 'desktop-tests', 'controls'].sort(),
    'Unexpected preflight dependency roster'
  );
  for (const name of ['plan', 'syntax', 'controls'])
    assert.equal(needs[name]?.result, 'success', `${name} did not succeed`);
  assert.equal(
    needs.typecheck?.result,
    selection.draft ? 'skipped' : 'success',
    'Typecheck did not conclude as selected'
  );
  const desktopRequired = !selection.draft && selection.desktopRequired;
  for (const name of ['desktop-discovery', 'desktop-tests'])
    assert.equal(
      needs[name]?.result,
      desktopRequired ? 'success' : 'skipped',
      `${name} did not conclude as selected`
    );
  const one = (kind) => {
    const matches = reports.filter((report) => report.kind === kind);
    assert.equal(matches.length, 1, `Missing or duplicate ${kind} report`);
    sameIdentity(manifest, matches[0]);
    return matches[0];
  };
  const syntax = one('syntax');
  assert.equal(syntax.status, 'passed', 'Syntax did not pass');
  let typecheck = { projects: [] };
  if (!selection.draft) {
    typecheck = one('typecheck');
    assert.equal(typecheck.status, 'passed', 'Typecheck did not pass');
    assert.deepEqual(
      typecheck.projects,
      selection.typecheckProjects,
      'Typecheck omitted selected projects'
    );
  } else
    assert.equal(
      reports.filter((report) => report.kind === 'typecheck').length,
      0,
      'Unexpected draft typecheck report'
    );
  let desktop = { required: false };
  if (desktopRequired) {
    const inventory = one('inventory');
    for (const report of reports.filter((item) => item.kind === 'desktop'))
      sameIdentity(manifest, report);
    if (expectedFiles)
      assert.deepEqual(inventory.files, expectedFiles, 'Desktop inventory changed');
    desktop = inspectDesktopReports({
      manifest,
      reports: reports.filter((report) => report.kind === 'desktop'),
      expectedFiles: inventory.files,
      skipBudget,
    });
  } else
    assert.equal(
      reports.filter((report) => ['inventory', 'desktop'].includes(report.kind)).length,
      0,
      'Unexpected desktop reports for omitted selection'
    );
  return {
    ...manifest,
    kind: 'preflight',
    status: 'passed',
    desktop,
    typecheck: { projects: typecheck.projects },
    needs,
  };
}

function projects(root) {
  const output = execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(output)
    .filter((project) => path.resolve(project.path) !== root)
    .map((project) => {
      const relative = path.relative(root, project.path).replaceAll('\\', '/');
      assert.ok(
        /^(apps|packages|tools)\//u.test(relative) && !relative.split('/').includes('..'),
        'Project escaped source root'
      );
      const manifest = JSON.parse(git(root, 'show', `HEAD:${relative}/package.json`));
      assert.equal(manifest.name, project.name, 'Workspace identity differs from committed source');
      return {
        name: manifest.name,
        path: relative,
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        }),
        typecheck: typeof manifest.scripts?.typecheck === 'string',
      };
    });
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(full) : entry.name.endsWith('.json') ? [full] : [];
  });
}

async function main(args) {
  const [command, ...rest] = args;
  const opt = {};
  for (let index = 0; index < rest.length; index += 2) {
    assert.ok(rest[index].startsWith('--') && rest[index + 1], 'Option requires a value');
    opt[rest[index].slice(2)] = rest[index + 1];
  }
  assert.ok(opt.out, '--out is required');
  const root = path.resolve(opt.root ?? process.cwd());
  if (command === 'plan') {
    const policy = read(path.join(controlRoot, '.ci/merge-policy.json'));
    const sourceSha = git(root, 'rev-parse', 'HEAD');
    assert.equal(sourceSha, process.env.GITHUB_SHA, 'Source differs from the event candidate');
    const baseSha = opt.base;
    assert.match(baseSha, SHA);
    const changed = git(root, 'diff', '--name-only', '--no-renames', baseSha, sourceSha)
      .split('\n')
      .filter(Boolean);
    const event = read(process.env.GITHUB_EVENT_PATH);
    const lane = ciLane(
      process.env.GITHUB_EVENT_NAME,
      event,
      process.env.GITHUB_REF,
      ciBranches(policy)
    );
    assert.ok(
      ['draft', 'development'].includes(lane),
      'Preflight is only the development admission lane'
    );
    const manifest = {
      version: 1,
      sourceSha,
      sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
      baseSha,
      controlSha: baseSha,
      controlRef: `${policy.repository.name}/${policy.branches[policy.repository.defaultBranch].workflow}@${policy.authority.ref}`,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      lane,
      desktopShards: Array.from({ length: policy.desktop.shards }, (_, index) => index + 1),
      changed,
      preflight: { draft: lane === 'draft', ...selectPreflightWork(changed, projects(root)) },
    };
    assert.equal(
      git(controlRoot, 'rev-parse', 'HEAD'),
      manifest.controlSha,
      'Control checkout differs from protected base'
    );
    assert.match(manifest.workflowSha, SHA);
    sameIdentity(manifest, manifest);
    write(opt.out, manifest);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `draft=${manifest.preflight.draft}\ndesktop=${manifest.preflight.desktopRequired}\nshards=${JSON.stringify(manifest.desktopShards)}\ncontrol=${manifest.controlSha}\n`
      );
    return;
  }
  const manifest = read(opt.manifest);
  if (['syntax', 'typecheck'].includes(command)) {
    assert.equal(git(root, 'rev-parse', 'HEAD'), manifest.sourceSha, 'Source changed');
    assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), manifest.sourceTree, 'Source tree changed');
  }
  if (command === 'syntax') {
    const require = createRequire(path.join(process.env.CI_PARSER_ROOT, 'package.json'));
    const ts = require('typescript');
    const yaml = require('yaml');
    assert.equal(ts.version, '5.8.3');
    assert.equal(require('yaml/package.json').version, '2.8.4');
    const files = [];
    const deferred = [];
    execFileSync('git', ['diff', '--check', manifest.baseSha, manifest.sourceSha], {
      cwd: root,
      stdio: 'inherit',
    });
    for (const file of manifest.changed) {
      const exists =
        spawnSync('git', ['cat-file', '-e', `${manifest.sourceSha}:${file}`], {
          cwd: root,
          stdio: 'ignore',
        }).status === 0;
      if (!exists) continue;
      if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|py|sh)$/u.test(file)) {
        deferred.push(file);
        continue;
      }
      const text = execFileSync('git', ['show', `${manifest.sourceSha}:${file}`], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024, `Syntax input too large: ${file}`);
      if (/\.[cm]?[jt]sx?$/u.test(file)) {
        const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        assert.equal(
          parsed.parseDiagnostics.length,
          0,
          `Syntax errors in ${file}: ${parsed.parseDiagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('; ')}`
        );
      } else if (/\.json$/u.test(file)) {
        if (path.basename(file).startsWith('tsconfig'))
          assert.equal(
            ts.parseConfigFileTextToJson(file, text).error,
            undefined,
            `Invalid JSON config: ${file}`
          );
        else JSON.parse(text);
      } else if (/\.ya?ml$/u.test(file))
        assert.equal(yaml.parseDocument(text).errors.length, 0, `Invalid YAML: ${file}`);
      else {
        const result = file.endsWith('.py')
          ? spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
              input: text,
              encoding: 'utf8',
            })
          : spawnSync('bash', ['-n'], { input: text, encoding: 'utf8' });
        assert.equal(result.status, 0, `Syntax failed in ${file}: ${result.stderr}`);
      }
      files.push(file);
    }
    return write(opt.out, { ...manifest, kind: 'syntax', status: 'passed', files, deferred });
  }
  if (command === 'typecheck') {
    assert.equal(manifest.preflight.draft, false, 'Draft does not select typechecks');
    const selected = manifest.preflight.typecheckProjects;
    const current = selectPreflightWork(manifest.changed, projects(root));
    assert.deepEqual(current.typecheckProjects, selected, 'Affected project selection changed');
    if (selected.length) {
      const result = spawnSync(
        'pnpm',
        ['-r', ...selected.flatMap((name) => ['--filter', name]), 'run', 'typecheck'],
        {
          cwd: root,
          stdio: 'inherit',
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
        }
      );
      assert.equal(result.status, 0, 'Affected type checks failed');
    }
    return write(opt.out, { ...manifest, kind: 'typecheck', status: 'passed', projects: selected });
  }
  assert.equal(command, 'assess', 'Unknown preflight command');
  write(
    opt.out,
    assessPreflight({
      manifest,
      needs: JSON.parse(process.env.PREFLIGHT_NEEDS),
      reports: jsonFiles(opt.reports).map(read),
      skipBudget: read(path.join(controlRoot, '.ci/desktop-skips.json')).files,
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
