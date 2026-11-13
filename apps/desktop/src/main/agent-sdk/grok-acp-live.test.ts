import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

import { detectGrok } from './detect';
import { openGrokAcpClient } from './grok-acp';

const live = process.env.DNAFORGE_LIVE_GROK_ACP === '1' ? describe : describe.skip;

live('installed Grok ACP runtime', () => {
  it('accepts DNAForge initialization over the production stdio launch', async () => {
    const detection = await detectGrok();
    expect(detection).toMatchObject({ cli: 'installed' });
    expect(detection.path).toBeTruthy();

    const controller = new AbortController();
    const opened = openGrokAcpClient({
      binaryPath: detection.path!,
      cwd: process.cwd(),
      permissionMode: 'app-supervised',
      systemPrompt: 'This is a provider-free ACP initialization probe. Do not start a model turn.',
      runtimeRoot: join(tmpdir(), 'dnaforge-grok-acp-live-test'),
      conversationId: 'grok-acp-live-handshake',
      signal: controller.signal,
      requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
    });
    expect(
      readFileSync(
        join(tmpdir(), 'dnaforge-grok-acp-live-test/home/.grok/requirements.toml'),
        'utf8'
      )
    ).toContain('[shell_environment_policy.set]');

    try {
      const initialized = await opened.rpc.initialize();
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities).toBeDefined();
      expect(
        (initialized._meta as { availableCommands?: unknown } | undefined)?.availableCommands
      ).toBeDefined();
      expect(opened.stderr()).toBe('');
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${opened.stderr() ? `\n${opened.stderr()}` : ''}`
      );
    } finally {
      opened.rpc.close();
    }
  }, 15_000);
});
