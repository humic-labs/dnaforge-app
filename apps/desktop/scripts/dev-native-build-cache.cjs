const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'dnaforge.dev-native-build.v2';
const LEGACY_SCHEMA = 'dnaforge.dev-native-build.v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const receiptPath = (appDir) => path.join(appDir, '.cache/dev-native-build.json');

function sourceKey(repoRoot, appDir) {
  const gitEnvironment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND:
      'ssh -oBatchMode=yes -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oIgnoreUnknown=UseKeychain -oUseKeychain=no',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'])
    delete gitEnvironment[key];
  const git = (...args) =>
    execFileSync(
      process.platform === 'win32' ? 'git.exe' : '/usr/bin/git',
      [
        '-c',
        `core.worktree=${repoRoot}`,
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-C',
        repoRoot,
        ...args,
      ],
      {
        env: gitEnvironment,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        timeout: 15000,
      }
    );
  const inputs = [
    git('rev-parse', 'HEAD'),
    git('ls-files', '--stage'),
    git('diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD'),
  ];
  for (const file of git(
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'apps/desktop/src',
    'apps/desktop/scripts',
    'apps/api/src',
    'packages'
  )
    .split('\n')
    .filter(Boolean)
    .sort()) {
    inputs.push(file, hash(fs.readFileSync(path.join(repoRoot, file))));
  }
  for (const root of [repoRoot, appDir]) {
    for (const name of ['.env', '.env.local']) {
      const file = path.join(root, name);
      inputs.push(file, fs.existsSync(file) ? hash(fs.readFileSync(file)) : 'missing');
    }
  }
  for (const name of ['electron', 'electron-vite', 'vite']) {
    const file = [appDir, repoRoot]
      .map((root) => path.join(root, 'node_modules', name, 'package.json'))
      .find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing installed native build tool: ${name}`);
    inputs.push(name, hash(fs.readFileSync(file)));
  }
  return hash(JSON.stringify(inputs));
}

function environmentKey(env) {
  const values = Object.keys(env)
    .filter(
      (key) =>
        /^(DNAFORGE_|VITE_|WAYPOINT_|POSTHOG_|SENTRY_|TELEMETRY_|DESKTOP_|API_PORT$|NODE_ENV$|ARCH$)/.test(
          key
        ) && !/^DNAFORGE_(?:DEV_BUILD_|DEV_STARTUP_TIMEOUT_MS$|BACKGROUND_)/.test(key)
    )
    .sort()
    .map((key) => [key, env[key]]);
  return hash(JSON.stringify([process.platform, process.arch, process.version, values]));
}

function outputs(appDir) {
  for (const file of ['out/main/index.js', 'out/preload/index.js']) {
    if (!fs.existsSync(path.join(appDir, file))) throw new Error(`Missing native output: ${file}`);
  }
  const result = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        result.push([path.relative(appDir, file), hash(fs.readFileSync(file))]);
      else throw new Error(`Unsupported native output: ${file}`);
    }
  };
  visit(path.join(appDir, 'out/main'));
  visit(path.join(appDir, 'out/preload'));
  return result;
}

function nativeInputs(appDir, repoRoot) {
  const graphs = ['main', 'preload'].map((target) => {
    const file = path.join(appDir, 'out/module-graph', `${target}.json`);
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      graph.schemaVersion !== 1 ||
      graph.target !== target ||
      graph.mode !== 'development' ||
      !Array.isArray(graph.modules) ||
      graph.modules.length === 0 ||
      !Array.isArray(graph.inputs) ||
      graph.inputs.length === 0 ||
      !/^[a-f0-9]{40}$/.test(graph.compiledSourceCommit)
    )
      throw new Error(`Incomplete development native module graph: ${target}`);
    for (const [input, digest] of graph.inputs) {
      if (
        !path.isAbsolute(input) ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        hash(fs.readFileSync(input)) !== digest
      )
        throw new Error(`Compiled native dependency changed: ${input}`);
    }
    return graph;
  });
  const [main, preload] = graphs;
  if (
    main.compiledSourceCommit !== preload.compiledSourceCommit ||
    !/^[a-f0-9]{64}$/.test(main.buildSourceFingerprint) ||
    !/^[a-f0-9]{64}$/.test(main.sidecarSourceFingerprint)
  )
    throw new Error('Native compilation provenance is incomplete');
  const files = new Set();
  for (const root of [repoRoot, appDir]) {
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.node.json',
      '.env',
      '.env.local',
    ])
      files.add(path.join(root, file));
  }
  for (const file of [
    'electron.vite.config.ts',
    'vite.renderer.config.ts',
    'distribution.json',
    'update-authority.json',
    'scripts/dev-native-build-cache.cjs',
    'scripts/lib/electron-module-graph.ts',
    'native/sequence-wheel.mm',
  ])
    files.add(path.join(appDir, file));
  for (const graph of graphs) {
    for (const [input] of graph.inputs) {
      let directory = path.dirname(input);
      while (directory === repoRoot || directory.startsWith(repoRoot + path.sep)) {
        if (fs.existsSync(path.join(directory, 'package.json')))
          files.add(path.join(directory, 'package.json'));
        if (directory === repoRoot) break;
        directory = path.dirname(directory);
      }
    }
  }
  for (const name of ['electron', 'electron-vite', 'vite']) {
    const file = [appDir, repoRoot]
      .map((root) => path.join(root, 'node_modules', name, 'package.json'))
      .find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing installed native build tool: ${name}`);
    files.add(file);
  }
  const metadata = [...files]
    .sort()
    .map((file) => [file, fs.existsSync(file) ? hash(fs.readFileSync(file)) : null]);
  const sidecarSourceFingerprint = require(
    path.join(repoRoot, 'scripts/sidecar-build-receipt.cjs')
  ).computeSidecarSourceHash(repoRoot).sourceHash;
  if (sidecarSourceFingerprint !== main.sidecarSourceFingerprint)
    throw new Error('Compiled sidecar source changed');
  return {
    fingerprint: hash(JSON.stringify({ graphs, metadata, sidecarSourceFingerprint })),
    compiledSourceCommit: main.compiledSourceCommit,
    buildSourceFingerprint: main.buildSourceFingerprint,
    sidecarSourceFingerprint,
  };
}

function inspectNativeBuild({ appDir, repoRoot, env = process.env }) {
  appDir = fs.realpathSync(appDir);
  repoRoot = fs.realpathSync(repoRoot);
  let source;
  const environment = environmentKey(env);
  try {
    source = sourceKey(repoRoot, appDir);
    const previous = JSON.parse(fs.readFileSync(receiptPath(appDir), 'utf8'));
    if (![SCHEMA, LEGACY_SCHEMA].includes(previous.schema) || previous.appDir !== appDir)
      throw new Error('Native build identity differs');
    if (previous.environment !== environment) throw new Error('Native build environment changed');
    if (JSON.stringify(previous.outputs) !== JSON.stringify(outputs(appDir)))
      throw new Error('Native output changed');
    if (previous.schema === LEGACY_SCHEMA) {
      if (previous.source !== source)
        throw new Error('Native build source or dependencies changed');
      return {
        reusable: true,
        nativeInputsCompatible: false,
        reason: 'Legacy native build matches the exact source snapshot',
        source,
        environment,
      };
    }
    const current = nativeInputs(appDir, repoRoot);
    if (JSON.stringify(previous.nativeInputs) !== JSON.stringify(current))
      throw new Error('Native build inputs or dependencies changed');
    return {
      reusable: true,
      nativeInputsCompatible: true,
      reason: 'Compiled native inputs and output bytes match',
      source,
      environment,
      ...current,
    };
  } catch (error) {
    return { reusable: false, reason: error.message, source, environment };
  }
}

function recordNativeBuild({ appDir, repoRoot, env = process.env }) {
  appDir = fs.realpathSync(appDir);
  repoRoot = fs.realpathSync(repoRoot);
  const nativeOutputs = outputs(appDir);
  const source = sourceKey(repoRoot, appDir);
  if (env.DNAFORGE_DEV_BUILD_SOURCE_KEY && env.DNAFORGE_DEV_BUILD_SOURCE_KEY !== source) {
    throw new Error('Native build source changed during compilation');
  }
  const graphFiles = ['main', 'preload'].map((target) =>
    path.join(appDir, 'out/module-graph', `${target}.json`)
  );
  const compiledInputs = graphFiles.every(fs.existsSync) ? nativeInputs(appDir, repoRoot) : null;
  const record = {
    schema: compiledInputs ? SCHEMA : LEGACY_SCHEMA,
    appDir: fs.realpathSync(appDir),
    source,
    environment: env.DNAFORGE_DEV_BUILD_ENV_KEY || environmentKey(env),
    outputs: nativeOutputs,
    ...(compiledInputs ? { nativeInputs: compiledInputs } : {}),
  };
  const destination = receiptPath(appDir);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return record;
}

function nativeBuildCachePlugin({ appDir, repoRoot }) {
  return {
    name: 'dnaforge-dev-native-build-cache',
    writeBundle() {
      recordNativeBuild({ appDir, repoRoot });
    },
  };
}

module.exports = { inspectNativeBuild, recordNativeBuild, nativeBuildCachePlugin };
