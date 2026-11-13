import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTerminalSavedState,
  writeTerminalSavedState,
  TerminalSessionCheckpoint,
} from './session-storage';
import type { SavedTerminalSession } from './terminal-service';

const key = randomBytes(32);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  },
  decryptString(value: Buffer): string {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-privacy-'));
  const path = join(directory, 'sessions.json');
  const saved: SavedTerminalSession = {
    profile: {
      id: 'bash',
      name: 'Bash',
      path: '/bin/bash',
      args: ['-i'],
      env: { EXPLICIT: 'profile-secret' },
    },
    replay: 'private-scrollback',
    renamed: false,
    session: {
      id: randomUUID(),
      pid: 42,
      profileId: 'bash',
      shellPath: '/bin/bash',
      title: 'Bash',
      cwd: directory,
      cols: 80,
      rows: 24,
      exitCode: null,
      status: 'running',
      integration: false,
      alternateScreen: false,
      shellState: 'prompt',
      commands: [],
    },
  };
  return { path, saved, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe('terminal checkpoint privacy', () => {
  it('never writes credential-named environment values to the checkpoint file', () => {
    const { path, saved, cleanup } = fixture();
    try {
      const legacy = Object.assign({}, saved, {
        environment: {
          PATH: '/usr/bin:/bin',
          OPENAI_API_KEY: 'sk-not-on-disk',
          GITHUB_TOKEN: 'ghp-not-on-disk',
          DNAFORGE_MCP_SESSION_TOKEN: 'session-not-on-disk',
        },
      });
      writeTerminalSavedState(path, [legacy], encryption);
      expect(readFileSync(path, 'utf8')).not.toMatch(/not-on-disk/);
      expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
      expect(readTerminalSavedState(path, encryption)[0]).not.toHaveProperty('environment');
    } finally {
      cleanup();
    }
  });
  it('encrypts replay and explicit profile values without serializing inherited variables', () => {
    const { path, saved, cleanup } = fixture();
    try {
      writeTerminalSavedState(
        path,
        [Object.assign({}, saved, { environment: { INHERITED: 'inherited-secret' } })],
        encryption
      );
      const bytes = readFileSync(path, 'utf8');
      expect(bytes).not.toContain('private-scrollback');
      expect(bytes).not.toContain('profile-secret');
      expect(bytes).not.toContain('inherited-secret');
      expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
    } finally {
      cleanup();
    }
  });
  it('migrates a legacy plaintext checkpoint and discards its inherited environment', () => {
    const { path, saved, cleanup } = fixture();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          sessions: [{ ...saved, environment: { API_KEY: 'old-secret' } }],
        })
      );
      expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
      const bytes = readFileSync(path, 'utf8');
      expect(bytes).not.toContain('private-scrollback');
      expect(bytes).not.toContain('old-secret');
      expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
    } finally {
      cleanup();
    }
  });
  it('omits session contents when secure encryption is unavailable', () => {
    const { path, saved, cleanup } = fixture();
    const unavailable = { ...encryption, isEncryptionAvailable: () => false };
    try {
      writeTerminalSavedState(path, [saved], unavailable);
      expect(readFileSync(path, 'utf8')).not.toContain('private-scrollback');
      expect(readTerminalSavedState(path, unavailable)).toEqual([]);
    } finally {
      cleanup();
    }
  });
  it('retains encrypted session bytes during a temporary secure-store outage', () => {
    const { path, saved, cleanup } = fixture();
    try {
      writeTerminalSavedState(path, [saved], encryption);
      const original = readFileSync(path, 'utf8');
      writeTerminalSavedState(path, [saved], { ...encryption, isEncryptionAvailable: () => false });
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
    } finally {
      cleanup();
    }
  });
  it('rejects tampering and preserves the previous checkpoint after encryption fails', () => {
    const { path, saved, cleanup } = fixture();
    try {
      writeTerminalSavedState(path, [saved], encryption);
      const original = readFileSync(path, 'utf8');
      expect(() =>
        writeTerminalSavedState(path, [saved], {
          ...encryption,
          encryptString: () => {
            throw new Error('locked');
          },
        })
      ).toThrow('locked');
      expect(readFileSync(path, 'utf8')).toBe(original);
      const state = JSON.parse(original);
      state.payload = Buffer.alloc(64, 1).toString('base64');
      writeFileSync(path, JSON.stringify(state));
      expect(() => readTerminalSavedState(path, encryption)).toThrow();
    } finally {
      cleanup();
    }
  });
});

it.each(['secure-store', 'session-restore'])(
  'preserves an unreadable checkpoint after %s failure until restoration succeeds',
  async (failure) => {
    const { path, saved, cleanup } = fixture();
    let available = true;
    const checkpoint = new TerminalSessionCheckpoint(path, {
      ...encryption,
      isEncryptionAvailable: () => available,
    });
    try {
      writeTerminalSavedState(path, [saved], encryption);
      const original = readFileSync(path, 'utf8');
      available = failure !== 'secure-store';
      await expect(
        checkpoint.restore(async () => {
          if (failure === 'session-restore') throw new Error('session restore failed');
        })
      ).rejects.toThrow();
      available = true;
      checkpoint.write([]);
      expect(readFileSync(path, 'utf8')).toBe(original);
      await checkpoint.restore(async (entries) => {
        expect(entries).toEqual([saved]);
      });
      checkpoint.write([]);
      expect(readTerminalSavedState(path, encryption)).toEqual([]);
    } finally {
      cleanup();
    }
  }
);

it('can explicitly discard an unreadable checkpoint and resume fresh protected saves', async () => {
  const { path, saved, cleanup } = fixture();
  let available = false;
  const checkpoint = new TerminalSessionCheckpoint(path, {
    ...encryption,
    isEncryptionAvailable: () => available,
  });
  try {
    writeTerminalSavedState(path, [saved], encryption);
    await expect(checkpoint.restore(async () => undefined)).rejects.toThrow();
    checkpoint.discard();
    expect(readTerminalSavedState(path, encryption)).toEqual([]);
    available = true;
    checkpoint.write([saved]);
    expect(readTerminalSavedState(path, encryption)).toEqual([saved]);
  } finally {
    cleanup();
  }
});
