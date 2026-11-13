import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as operations from './operations';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('cycle 42 unused surface', () => {
  it('drops unused components and helpers', () => {
    expect(operations).not.toHaveProperty('getAllLimsPrimers');
    expect(typeof operations.registerLimsEntity).toBe('function');
    expect(existsSync(join(root, 'shared/components/Card.tsx'))).toBe(false);
    expect(existsSync(join(root, 'shared/components/LoadingStates.tsx'))).toBe(false);
    expect(existsSync(join(root, 'features/page/embeds/components/EmbedPlaceholder.tsx'))).toBe(
      false
    );
    const barrel = readFileSync(join(root, 'shared/components/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/\bCard\b/);
    expect(barrel).not.toMatch(/SidebarSkeleton/);
    expect(barrel).toMatch(/Button/);
  });
});
