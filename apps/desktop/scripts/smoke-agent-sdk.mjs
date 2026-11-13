#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const repoRoot = resolve(scriptDir, '..', '..', '..');

const promptText = process.argv[2] ?? 'Reply with the literal three-character string: ok.';

const viteNode = join(repoRoot, 'node_modules/.bin/vite-node');
const helper = join(repoRoot, 'apps/desktop/scripts/smoke-agent-sdk-helper.mts');

const result = spawnSync(viteNode, [helper, '--', promptText], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
