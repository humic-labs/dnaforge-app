import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as colors from './colors';

const here = dirname(fileURLToPath(import.meta.url));

describe('retired primer and fragment visuals', () => {
  it('does not keep the unused primer SVG helper or fragment color export', () => {
    expect(existsSync(join(here, 'components/primer-svg-utils.ts'))).toBe(false);
    expect(colors).not.toHaveProperty('FRAGMENT_COLORS');
    expect(typeof colors.getFragmentColor).toBe('function');
    const validation = readFileSync(join(here, 'validation/golden-gate-overhangs.ts'), 'utf8');
    const reexport = readFileSync(
      join(here, '../assembly-panel/hooks/useOverhangValidation.ts'),
      'utf8'
    );
    expect(validation).not.toMatch(/function validateFragment\b/);
    expect(validation).toMatch(/function validateAssembly\b/);
    expect(reexport).not.toMatch(/\bvalidateFragment\b/);
    expect(reexport).toMatch(/\bvalidateAssembly\b/);
  });
});
