import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as operations from './operations';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('cycle 43 unused exports', () => {
  it('drops unused exports and keeps the live factories and command registry', () => {
    expect(operations).not.toHaveProperty('getLimsStrainGenomeSummary');
    expect(typeof operations.attachLimsGenomeHypothesis).toBe('function');
    const commands = readFileSync(join(root, 'commands/commandRegistry.ts'), 'utf8');
    expect(commands).not.toMatch(/COMMAND_DEFINITIONS/);
    expect(commands).toMatch(/function resolveCommandHandler/);
  });
});
