import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { RemoteSshAuthPromptV1 } from '../shared/remote-genomics-ipc';
import { RemoteSshPromptBroker } from './remote-ssh-prompt-broker';

class FakeContents extends EventEmitter {
  readonly id = 42;
  prompts: RemoteSshAuthPromptV1[] = [];
  closedPrompts: string[] = [];
  send(channel: string, prompt: RemoteSshAuthPromptV1 | string): void {
    if (channel === 'remoteGenomics:authPromptClosed' && typeof prompt === 'string') {
      this.closedPrompts.push(prompt);
      return;
    }
    if (typeof prompt === 'string') throw new Error('Unexpected prompt delivery.');
    this.prompts.push(prompt);
    this.emit('prompt', prompt);
  }
  isDestroyed(): boolean {
    return false;
  }
}

describe.runIf(process.platform !== 'win32')('OpenSSH askpass relay', () => {
  it('routes a secret and a host-trust question to the owning renderer without persisting the answer', async () => {
    const broker = new RemoteSshPromptBroker();
    const owner = new FakeContents();
    const requestId = 'auth-test-1234';
    await broker.prepare(requestId, owner as unknown as WebContents);
    const environment = broker.environmentFor(requestId);
    expect(environment?.SSH_ASKPASS).toBeTruthy();
    try {
      for (const [question, answer, kind] of [
        ['Password for test-hpc:', 'test-only-secret', 'secret'],
        [
          'The authenticity of host test-hpc cannot be established. Are you sure you want to continue connecting (yes/no/[fingerprint])?',
          'yes',
          'host-trust',
        ],
      ] as const) {
        const child = spawn(environment!.SSH_ASKPASS!, [question], {
          env: { ...process.env, ...environment },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        const prompt = (await once(owner, 'prompt'))[0] as RemoteSshAuthPromptV1;
        expect(prompt).toMatchObject({ requestId, text: question, kind });
        expect(broker.respond(prompt.promptId, answer, owner.id)).toBe(true);
        const [code] = await once(child, 'exit');
        expect(code).toBe(0);
        expect(stdout).toBe(`${answer}\n`);
        expect(broker.respond(prompt.promptId, answer, owner.id)).toBe(false);
      }
    } finally {
      await broker.finish(requestId);
    }
    expect(broker.environmentFor(requestId)).toBeNull();
  });

  it('rejects a cross-window answer and exits the askpass helper when the owner cancels', async () => {
    const broker = new RemoteSshPromptBroker();
    const owner = new FakeContents();
    const requestId = 'auth-cancel-1234';
    const cancelConnection = vi.fn();
    await broker.prepare(requestId, owner as unknown as WebContents, cancelConnection);
    try {
      const child = spawn(broker.environmentFor(requestId)!.SSH_ASKPASS!, ['Verification code:'], {
        env: { ...process.env, ...broker.environmentFor(requestId) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const prompt = (await once(owner, 'prompt'))[0] as RemoteSshAuthPromptV1;
      expect(broker.respond(prompt.promptId, 'stolen', owner.id + 1)).toBe(false);
      expect(broker.respond(prompt.promptId, null, owner.id)).toBe(true);
      const [code] = await once(child, 'exit');
      expect(code).not.toBe(0);
      expect(owner.closedPrompts).toContain(prompt.promptId);
      expect(cancelConnection).toHaveBeenCalledOnce();
    } finally {
      await broker.finish(requestId);
    }
  });

  it('dismisses a pending prompt when the connection attempt ends', async () => {
    const broker = new RemoteSshPromptBroker();
    const owner = new FakeContents();
    const requestId = 'auth-ended-1234';
    await broker.prepare(requestId, owner as unknown as WebContents);
    const child = spawn(broker.environmentFor(requestId)!.SSH_ASKPASS!, ['Password:'], {
      env: { ...process.env, ...broker.environmentFor(requestId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const prompt = (await once(owner, 'prompt'))[0] as RemoteSshAuthPromptV1;
      expect(broker.respond(prompt.promptId, undefined as unknown as string, owner.id)).toBe(false);
      const exited = once(child, 'exit');
      await broker.finish(requestId);
      await exited;
      expect(owner.closedPrompts).toEqual([prompt.promptId]);
      expect(broker.respond(prompt.promptId, 'late-secret', owner.id)).toBe(false);
    } finally {
      await broker.finish(requestId);
      child.kill();
    }
  });
});
