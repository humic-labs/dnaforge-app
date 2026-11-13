#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CRAWLER = path.join(__dirname, 'structure-corpus-crawl.cjs');

const MODES = {
  'dev-assets-offline': {
    description: 'Inventory every GenBank CDS in committed fixtures plus wp-assets.',
    needsSidecar: false,
    args: ['--include-wp-assets', '--out', 'test-results/structure-corpus-dev-assets-offline'],
  },
  'dev-assets-live': {
    description:
      'Probe dev-assets CDSs through the sidecar until 100 AlphaFold structure-byte loads succeed.',
    needsSidecar: true,
    args: [
      '--include-wp-assets',
      '--probe-sidecar',
      '--probe-structure-bytes',
      '--success-target',
      '100',
      '--out',
      'test-results/structure-corpus-dev-assets-live',
    ],
  },
  'mg1655-controls': {
    description: 'Probe the MG1655 known-positive controls and fail on any miss.',
    needsSidecar: true,
    args: [
      '--probe-sidecar',
      '--probe-structure-bytes',
      '--require-mg1655-controls',
      '--match',
      '^(arsC|hdfR|rbsR|mioC)\\b',
      '--out',
      'test-results/structure-corpus-mg1655-controls',
      'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
    ],
  },
};

function usage() {
  console.log(`Usage: pnpm --filter @waypoint/desktop <script> [-- crawler-options]

Modes:
${Object.entries(MODES)
  .map(([mode, config]) => `  ${mode.padEnd(18)} ${config.description}`)
  .join('\n')}

Package scripts:
  structure:crawl:dev-assets       ${MODES['dev-assets-offline'].description}
  structure:regression:dev-assets  ${MODES['dev-assets-live'].description}
  structure:regression:mg1655      ${MODES['mg1655-controls'].description}

Pass extra crawler flags after the package command to override defaults.
Examples:
  pnpm --filter @waypoint/desktop structure:crawl:dev-assets
  DNAFORGE_MCP_SESSION_TOKEN=<token> \\
    pnpm --filter @waypoint/desktop structure:regression:dev-assets -- --success-target 25
`);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadWorktreeEnv() {
  loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  loadEnvFile(path.join(REPO_ROOT, 'apps/desktop/.env.local'));
  if (!process.env.WP_ASSETS_DIR) {
    process.env.WP_ASSETS_DIR = process.env.WP_ASSETS_PATH || process.env.VITE_WP_ASSETS_PATH || '';
  }
}

async function assertSidecarReady(sidecarUrl) {
  const healthUrl = `${sidecarUrl.replace(/\/$/, '')}/health`;
  let response;
  try {
    response = await fetch(healthUrl);
  } catch (error) {
    throw new Error(
      `Sidecar is not reachable at ${healthUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!response.ok) {
    throw new Error(`Sidecar health check failed at ${healthUrl}: HTTP ${response.status}`);
  }
}

function normalizeArgs(args) {
  return args.filter((arg) => arg !== '--');
}

function optionValue(args, option) {
  let value = null;
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) value = args[index + 1];
  }
  return value;
}

async function main() {
  const [modeArg, ...rawExtraArgs] = process.argv.slice(2);
  if (!modeArg || modeArg === '--help' || modeArg === '-h') {
    usage();
    process.exit(modeArg ? 0 : 1);
  }
  const mode = MODES[modeArg];
  if (!mode) {
    console.error(`Unknown structure corpus regression mode: ${modeArg}`);
    usage();
    process.exit(1);
  }

  loadWorktreeEnv();
  const extraArgs = normalizeArgs(rawExtraArgs);
  const sidecarUrl =
    optionValue(extraArgs, '--sidecar-url') || process.env.VITE_API_URL || 'http://localhost:8001';
  const sessionToken =
    optionValue(extraArgs, '--session-token') || process.env.DNAFORGE_MCP_SESSION_TOKEN;

  if (mode.needsSidecar) {
    if (!sessionToken) {
      console.error(
        `${modeArg} requires DNAFORGE_MCP_SESSION_TOKEN matching the running sidecar. ` +
          'The /health route can confirm a token is configured, but it intentionally does not reveal it.'
      );
      process.exit(1);
    }
    await assertSidecarReady(sidecarUrl);
  }

  const child = spawnSync(process.execPath, [CRAWLER, ...mode.args, ...extraArgs], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
