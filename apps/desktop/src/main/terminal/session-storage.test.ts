import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedTerminalSession } from './terminal-service';
import {
  parseTerminalSavedState,
  readTerminalSavedState,
  writeTerminalSavedState,
} from './session-storage';

describe('private terminal saved state', () => {
  it('retains the previous checkpoint after invalid writes and refuses malformed state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'terminal-storage-'));
    const path = join(directory, 'sessions.json');
    try {
      expect(
        readTerminalSavedState(path, {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error('unavailable');
          },
          decryptString: () => {
            throw new Error('unavailable');
          },
        })
      ).toEqual([]);
      const saved: SavedTerminalSession = {
        profile: { id: 'bash', name: 'Bash', path: '/bin/bash', args: ['-i'] },
        renamed: false,
        replay: 'SAVED_OUTPUT',
        windowGroup: randomUUID(),
        session: {
          id: randomUUID(),
          pid: 42,
          profileId: 'bash',
          shellPath: '/bin/bash',
          title: 'Bash',
          cwd: directory,
          cols: 120,
          rows: 40,
          exitCode: null,
          status: 'running',
          integration: false,
          alternateScreen: false,
          shellState: 'starting',
          commands: [],
          fixedDimensions: { cols: 120, rows: 40 },
        },
      };
      const unavailable = {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('unavailable');
        },
        decryptString: () => {
          throw new Error('unavailable');
        },
      };
      writeTerminalSavedState(path, [saved], unavailable);
      const original = readFileSync(path, 'utf8');
      expect(readTerminalSavedState(path, unavailable)).toEqual([]);
      expect(statSync(path).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
      for (const text of ['{', '{"version":2,"sessions":[]}', '{"version":1,"sessions":[{}]}'])
        expect(() => parseTerminalSavedState(text)).toThrow();
      saved.session.cols = 0;
      expect(() => writeTerminalSavedState(path, [saved], unavailable)).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
