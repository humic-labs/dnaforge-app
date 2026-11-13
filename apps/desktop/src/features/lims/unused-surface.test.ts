// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('retired LIMS helpers', () => {
  it('does not keep the unused primer bridge or registry summary helpers', () => {
    expect(existsSync(join(here, 'primers-bridge.ts'))).toBe(false);
    const barrel = readFileSync(join(here, 'index.ts'), 'utf8');
    const presenters = readFileSync(join(here, 'components/registry-presenters.tsx'), 'utf8');
    const ingress = readFileSync(join(here, 'ingress.ts'), 'utf8');
    expect(barrel).not.toMatch(/primers-bridge/);
    expect(barrel).toMatch(/operations/);
    expect(presenters).not.toMatch(/function fileNameFromPath\b/);
    expect(presenters).not.toMatch(/function entityFieldSummary\b/);
    expect(presenters).not.toMatch(/function isGenomeHypothesis\b/);
    expect(presenters).toMatch(/function formatRegistryUpdatedAt\b/);
    expect(ingress).not.toMatch(/\b(?:function|const) applyAcceptedLimsImportRecords\b/);
    expect(ingress).toMatch(/export (?:function|const) applyAcceptedLimsImportPlan\b/);
  });
});
