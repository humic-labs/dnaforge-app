// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import contractManifest from '../../../../../packages/core/codex-app-server-contract/src/manifest.json';
import { CLAUDE_RUNTIME_TOOL_POLICY } from '../../main/agent-sdk/native-tool-capabilities';
import { detectClaudeCode, detectGrok } from '../../main/agent-sdk/detect';
import { AGENT_INTERACTION_MATRIX } from './agent-interaction-matrix';

const repositoryRoot = resolve(process.cwd(), '../..');
const claudeSdkTypes = readFileSync(
  resolve(repositoryRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'),
  'utf8'
);
const codexSdkTypes = readFileSync(
  resolve(repositoryRoot, 'node_modules/@openai/codex-sdk/dist/index.d.ts'),
  'utf8'
);
const grokAcpSchema = readFileSync(
  resolve(repositoryRoot, 'node_modules/@agentclientprotocol/sdk/schema/schema.json'),
  'utf8'
);
const codexMethods = new Set([
  ...contractManifest.upstreamProtocolMethods.client,
  ...contractManifest.upstreamProtocolMethods.server,
  ...contractManifest.upstreamProtocolMethods.notification,
]);
const dnaforgeCapabilityRuntime = readFileSync(
  resolve(repositoryRoot, 'apps/desktop/src/main/agent-capabilities/runtime-service.ts'),
  'utf8'
);

describe('agent interaction surface drift', () => {
  it('resolves every positive matrix claim against installed runtime/schema evidence', () => {
    for (const row of Object.values(AGENT_INTERACTION_MATRIX)) {
      for (const [provider, cell] of Object.entries(row.providers)) {
        if (cell.agentSupport === 'not-advertised') continue;
        const { source, token } = cell.evidence;
        const message = `${provider}/${row.id}: ${source} must contain ${token}`;
        if (source === 'claude-runtime') {
          expect(Object.keys(CLAUDE_RUNTIME_TOOL_POLICY), message).toContain(token);
        } else if (source === 'claude-sdk-types') {
          expect(claudeSdkTypes, message).toContain(token);
        } else if (source === 'codex-app-server-schema') {
          expect(codexMethods, message).toContain(token);
        } else if (source === 'codex-sdk-types') {
          expect(codexSdkTypes, message).toContain(token);
        } else if (source === 'dnaforge-runtime') {
          expect(dnaforgeCapabilityRuntime, message).toContain(token);
        } else if (source === 'grok-acp-schema') {
          expect(grokAcpSchema, message).toContain(token);
        } else if (source === 'grok-acp-runtime-meta') {
          expect(token, message).toBe('availableCommands');
        }
      }
    }
  });

  it('matches every positive Claude CLI-help claim against the installed official binary when present', async () => {
    const detection = await detectClaudeCode();
    if (detection.cli !== 'installed' || !detection.path) return;

    const help = spawnSync(detection.path, ['--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(help.status).toBe(0);
    const output = `${help.stdout}\n${help.stderr}`;
    for (const row of Object.values(AGENT_INTERACTION_MATRIX)) {
      const cell = row.providers['claude-agent-sdk'];
      if (cell.agentSupport !== 'native' || cell.evidence.source !== 'claude-cli-help') continue;
      for (const part of cell.evidence.token.split(/\s+/u)) {
        expect(output, `claude-agent-sdk/${row.id}: help must contain ${part}`).toContain(part);
      }
    }
  }, 20_000);

  it('matches every positive Grok CLI claim against the installed official binary when present', async () => {
    const detection = await detectGrok();
    if (detection.cli !== 'installed' || !detection.path) return;

    const help = spawnSync(detection.path, ['--no-auto-update', '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(help.status).toBe(0);
    const output = `${help.stdout}\n${help.stderr}`;
    for (const row of Object.values(AGENT_INTERACTION_MATRIX)) {
      const cell = row.providers['grok-acp'];
      if (cell.agentSupport !== 'native' || cell.evidence.source !== 'grok-cli-help') continue;
      for (const part of cell.evidence.token.split(/\s+/u)) {
        expect(output, `grok-acp/${row.id}: help must contain ${part}`).toContain(part);
      }
    }
  }, 20_000);
});
