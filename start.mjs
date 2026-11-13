#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const envExample = path.join(root, 'apps', 'desktop', '.env.local.example');
const envFile = path.join(root, 'apps', 'desktop', '.env.local');

export const USAGE = `Usage: node start.mjs [options]

Sets up everything DNAForge needs to run from source, then starts the app.
Run it again any time; finished steps are quick.

  --yes         install missing tools (uv, Rust) without asking
  --setup-only  stop after setup instead of starting the app
  --check       start the app, wait until it is up, then stop it (used by CI)
  --help        show this text
`;

export function parseOptions(argv) {
  const known = new Set(['--yes', '--setup-only', '--check', '--help']);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}\n\n${USAGE}`);
  return {
    yes: argv.includes('--yes'),
    setupOnly: argv.includes('--setup-only'),
    check: argv.includes('--check'),
    help: argv.includes('--help'),
  };
}

export function nodeProblem(current, pinned) {
  const major = (version) => Number(String(version).trim().replace(/^v/u, '').split('.')[0]);
  if (major(current) === major(pinned)) return null;
  return `DNAForge needs Node.js ${major(pinned)} (this repository pins ${String(pinned).trim()}), but this is ${current}. Install Node.js ${major(pinned)} from https://nodejs.org and run this again.`;
}

export function installPlan(platform) {
  if (platform === 'win32') {
    return {
      uv: {
        display: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
        command: 'powershell',
        args: ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex'],
      },
      cargo: null,
    };
  }
  return {
    uv: {
      display: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      command: 'sh',
      args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
    },
    cargo: {
      display: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
      command: 'sh',
      args: ['-c', "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"],
    },
  };
}

export function envFileText(example, ports) {
  return example
    .replace(/^DESKTOP_DEV_PORT=.*$/mu, `DESKTOP_DEV_PORT=${ports.dev}`)
    .replace(/^DESKTOP_HMR_PORT=.*$/mu, `DESKTOP_HMR_PORT=${ports.hmr}`)
    .replace(/^API_PORT=.*$/mu, `API_PORT=${ports.api}`)
    .replace(/^VITE_API_URL=.*$/mu, `VITE_API_URL=http://127.0.0.1:${ports.api}`);
}

export async function choosePorts(isFree, attempts = 50) {
  for (let step = 0; step < attempts; step += 1) {
    const ports = { dev: 1420 + step, hmr: 1500 + step, api: 8000 + step };
    const free = await Promise.all(Object.values(ports).map((port) => isFree(port)));
    if (free.every(Boolean)) return ports;
  }
  throw new Error('No free ports found near 1420, 1500 and 8000. Close other development servers and run this again.');
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function has(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: windows });
  return !result.error && result.status === 0;
}

function run(title, command, args, options = {}) {
  console.log(`\n==> ${title}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: windows, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`"${title}" failed. Fix the error above and run node start.mjs again.`);
  }
}

async function confirm(question, options) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
  prompt.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

async function ensureTool(name, label, plan, manual, options) {
  if (has(name)) return;
  if (!plan) throw new Error(`${label} is not installed. ${manual}`);
  console.log(`\n${label} is not installed. It can be installed for your user with:\n  ${plan.display}`);
  if (!(await confirm(`Install ${label} now?`, options))) {
    throw new Error(`${label} is required. Install it with the command above (or run node start.mjs --yes), then run this again.`);
  }
  run(`Install ${label}`, plan.command, plan.args, { shell: false });
  if (!has(name)) {
    throw new Error(`${label} was installed but is not on your PATH yet. Open a new terminal and run node start.mjs again.`);
  }
}

function pnpmCommand() {
  if (has('corepack')) return { command: 'corepack', prefix: ['pnpm'] };
  if (has('pnpm')) return { command: 'pnpm', prefix: [] };
  throw new Error('Neither corepack nor pnpm was found. Node.js 22 includes corepack; reinstall Node.js from https://nodejs.org and run this again.');
}

function ensureLinuxMuslTarget() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const installed = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  if (!installed.error && !installed.stdout.includes('x86_64-unknown-linux-musl')) {
    run('Add the Rust target the desktop helpers build for', 'rustup', ['target', 'add', 'x86_64-unknown-linux-musl']);
  }
  if (!has('musl-gcc', ['--version'])) {
    throw new Error("The desktop helpers need your distribution's musl tools. On Debian or Ubuntu run: sudo apt-get install musl-tools. Then run node start.mjs again.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const home = os.homedir();
  process.env.PATH = [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), process.env.PATH].join(path.delimiter);
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';

  const wrongNode = nodeProblem(process.version, readFileSync(path.join(root, '.nvmrc'), 'utf8'));
  if (wrongNode) throw new Error(wrongNode);
  if (!existsSync(path.join(root, '.git')) || !has('git')) {
    throw new Error('DNAForge builds only from a Git clone with git installed. Clone the repository with git instead of downloading a ZIP, then run this again.');
  }

  const plan = installPlan(process.platform);
  await ensureTool('uv', 'uv (installs the Python the sidecar needs)', plan.uv, '', options);
  await ensureTool(
    'cargo',
    'Rust (compiles three small helper programs)',
    plan.cargo,
    'Install it from https://rustup.rs, which also asks for the Visual Studio C++ build tools, then run this again.',
    options
  );
  ensureLinuxMuslTarget();

  const pnpm = pnpmCommand();
  run('Install JavaScript dependencies', pnpm.command, [...pnpm.prefix, 'install', '--frozen-lockfile']);
  run('Set up the Python sidecar', 'uv', ['sync', '--frozen', '--extra', 'dev'], { cwd: path.join(root, 'apps', 'api') });
  run('Build the Rust helpers', pnpm.command, [...pnpm.prefix, '--dir', 'apps/desktop', 'helpers:build']);

  if (existsSync(envFile)) {
    console.log('\n==> Keeping your existing apps/desktop/.env.local');
  } else {
    const ports = await choosePorts(portIsFree);
    writeFileSync(envFile, envFileText(readFileSync(envExample, 'utf8'), ports));
    console.log(`\n==> Wrote apps/desktop/.env.local (ports ${ports.dev}, ${ports.hmr}, ${ports.api})`);
  }

  if (options.setupOnly) {
    console.log('\nSetup is complete. Start the app with: node start.mjs');
    return 0;
  }
  if (options.check) {
    run('Start the app and wait until it is up', pnpm.command, [...pnpm.prefix, '--dir', 'apps/desktop', 'run', 'check:run-from-source']);
    return 0;
  }

  console.log('\n==> Starting DNAForge. The first start compiles the app, so the window takes a minute or two. Press Ctrl+C to stop.');
  const child = spawn(pnpm.command, [...pnpm.prefix, '--dir', 'apps/desktop', 'dev'], { cwd: root, stdio: 'inherit', shell: windows });
  return await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`\n${error.message}`);
      process.exitCode = 1;
    }
  );
}
