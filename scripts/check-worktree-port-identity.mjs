#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const ESCAPE_HATCH = 'ALLOW_FOREIGN_DESKTOP_DEV_PORT';
export const IDENTITY_MISMATCH_TOKEN = 'ELECTRON_DEV_IDENTITY_MISMATCH';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function identityValuesEquivalent(variable, declared, inherited) {
  if (declared === inherited) return true;
  if (variable !== 'VITE_API_URL' && variable !== 'WAYPOINT_WEB_BASE_URL') return false;
  try {
    const a = new URL(declared);
    const b = new URL(inherited);
    const hostA = LOOPBACK_HOSTS.has(a.hostname) ? 'loopback' : a.hostname;
    const hostB = LOOPBACK_HOSTS.has(b.hostname) ? 'loopback' : b.hostname;
    const pathA = a.pathname.replace(/\/$/, '') || '/';
    const pathB = b.pathname.replace(/\/$/, '') || '/';
    return a.protocol === b.protocol && hostA === hostB && a.port === b.port && pathA === pathB;
  } catch {
    return false;
  }
}

export function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return undefined;
  const line = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'))
    .reverse()
    .find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

export function assessPortIdentity({
  declared,
  inherited,
  escape,
  variable = 'DESKTOP_DEV_PORT',
} = {}) {
  if (declared === undefined) {
    return { ok: true, reason: 'no declared port in this checkout' };
  }
  if (inherited === undefined || inherited === '') {
    return { ok: true, reason: `no inherited ${variable}` };
  }
  if (identityValuesEquivalent(variable, declared, inherited)) {
    return { ok: true, reason: 'inherited port matches this worktree' };
  }
  if (escape === '1') {
    return {
      ok: true,
      reason: `mismatch allowed by ${ESCAPE_HATCH} (${variable}: declared ${declared}, inherited ${inherited})`,
    };
  }
  return {
    ok: false,
    reason: 'inherited port belongs to a different worktree',
    message:
      `${variable}=${inherited} is exported in this shell, but this worktree's ` +
      `.env.local declares ${declared}.\n\n` +
      'The guard refuses to start so you cannot silently serve or tear down the other worktree. ' +
      `If you proceed with ${ESCAPE_HATCH}=1, this worktree's .env.local value is the one used ` +
      'inside the guard — other tools that read process.env will still see the inherited value.\n\n' +
      `Playwright's PLAYWRIGHT_DESKTOP_URL, verify-task --port, and this worktree's own docs ` +
      `look at the file (${declared}) and find nothing if the app ever served ${inherited}.\n\n` +
      'That disagreement is the bug, not the number. Playwright reacts to it by trying to ' +
      'start its own server and failing with "Process from config.webServer exited early", ' +
      'which mentions no port and sends you debugging the wrong thing.\n\n' +
      `Fix: run \`unset ${variable}\` in this shell, or open a shell rooted in this ` +
      `worktree. To proceed anyway: ${ESCAPE_HATCH}=1`,
  };
}

export const IDENTITY_VARS = Object.freeze([
  'DESKTOP_DEV_PORT',
  'DESKTOP_HMR_PORT',
  'API_PORT',
  'VITE_API_URL',
  'DESKTOP_DEBUG_PORT',
  'DEV_PORT',
  'WEB_DEV_PORT',
  'WAYPOINT_WEB_BASE_URL',
  'VITE_CLIENT_LOG_PATH',
]);

export function checkWorktreePortIdentity({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const appEnv = path.join(repoRoot, 'apps', 'desktop', '.env.local');
  const rootEnv = path.join(repoRoot, '.env.local');

  const conflicts = [];
  for (const name of IDENTITY_VARS) {
    const declared = readEnvValue(appEnv, name) ?? readEnvValue(rootEnv, name);
    const verdict = assessPortIdentity({
      declared,
      inherited: env[name],
      escape: env[ESCAPE_HATCH],
      variable: name,
    });
    if (!verdict.ok) conflicts.push({ name, declared, inherited: env[name] });
  }

  if (conflicts.length === 0) {
    return { ok: true, reason: 'no inherited worktree identity variables conflict' };
  }

  const lines = conflicts
    .map((c) => `  ${c.name}: this shell has ${c.inherited}, this worktree declares ${c.declared}`)
    .join('\n');

  return {
    ok: false,
    reason: `${conflicts.length} inherited worktree identity variable(s) conflict`,
    message:
      `These variables are exported in this shell but belong to a DIFFERENT worktree:\n\n${lines}\n\n` +
      "Each one disagrees with this worktree's .env.local, and that disagreement is the bug. " +
      'The dev guard refuses to start so you cannot silently serve or tear down the other worktree. ' +
      `If you proceed with ${ESCAPE_HATCH}=1, this worktree's .env.local values are the ones used ` +
      'inside the guard — other tools that read process.env will still see the inherited values. ' +
      'Each variable breaks something different:\n\n' +
      "  DESKTOP_DEV_PORT  the app serves the other worktree's port, while Playwright and\n" +
      '                    verify-task read the file and look somewhere empty. Playwright then\n' +
      '                    tries to start its own server and dies with "Process from\n' +
      '                    config.webServer exited early" — a message naming no port at all.\n' +
      '  VITE_API_URL      Vite bakes it into the served bundle, so every sidecar call goes to a\n' +
      '                    dead port. Clearing node_modules/.vite does NOT fix it; the value is\n' +
      "                    in the running server's environment.\n" +
      '  API_PORT          `dev:stop` resolves what to kill from this. Stale, it stops ANOTHER\n' +
      '                    worktree\'s app and leaves yours running — so a "clean restart"\n' +
      '                    silently reattaches to the contaminated server.\n\n' +
      `Fix: \`unset ${conflicts.map((c) => c.name).join(' ')}\`, or open a shell rooted in this ` +
      `worktree. To proceed anyway: ${ESCAPE_HATCH}=1`,
  };
}

if (process.argv[2] === 'check' || process.argv[2] === undefined) {
  const isEntry =
    process.argv[1] !== undefined &&
    path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));
  if (isEntry) {
    const verdict = checkWorktreePortIdentity();
    if (!verdict.ok) {
      console.error(IDENTITY_MISMATCH_TOKEN);
      console.error(`[worktree-port-identity] ${verdict.message}`);
      process.exitCode = 1;
    } else {
      console.log(`[worktree-port-identity] OK — ${verdict.reason}`);
    }
  }
}
