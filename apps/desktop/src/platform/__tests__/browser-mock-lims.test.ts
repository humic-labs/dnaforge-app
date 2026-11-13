import { afterEach, describe, expect, it } from 'vitest';
import { browserMockBridge, resetBrowserMockLimsState } from '../browser-mock';

describe('browser-mock LIMS fixture (dev/demo, not a correctness oracle)', () => {
  afterEach(() => resetBrowserMockLimsState());

  it('runs the basic register → query → count flow without crashing', async () => {
    const lims = browserMockBridge.lims;
    await lims.ensureSeeded();

    const registered = await lims.registerEntity({
      kind: 'oligo',
      name: 'Smoke Primer',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    expect(registered.id).toBeTruthy();

    const rows = await lims.queryEntities({ kind: 'oligo' });
    expect(rows.some((r) => r.name === 'Smoke Primer')).toBe(true);

    const page = await lims.queryRegistrySummaries({});
    expect(Array.isArray(page.summaries)).toBe(true);

    const counts = await lims.countEntitiesByKind();
    expect(typeof counts.oligo).toBe('number');
  });

  it('resets fixture state between runs', async () => {
    await browserMockBridge.lims.registerEntity({
      kind: 'oligo',
      name: 'Only In Run One',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
    });
    resetBrowserMockLimsState();
    const rows = await browserMockBridge.lims.queryEntities({ kind: 'oligo' });
    expect(rows.some((r) => r.name === 'Only In Run One')).toBe(false);
  });

  it('includes custom record kinds in the count fixture contract', async () => {
    const lims = browserMockBridge.lims;
    await lims.registerEntity({
      id: 'browser-custom',
      kind: 'custom_specimen',
      name: 'Custom specimen',
      fields: {},
    });
    await lims.registerEntity({
      id: 'browser-archived-custom',
      kind: 'custom_specimen',
      name: 'Archived specimen',
      fields: {},
    });
    await lims.archiveEntity({ id: 'browser-archived-custom' });

    expect((await lims.countEntitiesByKind()).custom_specimen).toBe(1);
  });
});
