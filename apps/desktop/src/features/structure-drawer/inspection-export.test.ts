import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { platform } from '../../platform';
import { InspectionExport } from './components/InspectionExport';
const exportBridge = vi.hoisted(() => ({
  dialog: { save: vi.fn() },
  fs: { writeTextFileAtomic: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: () => exportBridge }));

import { inspectionFigureSvg, inspectionMeasurementsCsv } from './inspection-export';
import type { MolecularView } from '../page/public/embeds/structure3d/molecularView';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';

async function fixture(): Promise<MolecularView> {
  return {
    kind: 'molecular-view',
    version: 1,
    title: 'Protein <A&B>',
    caption: 'Reference coordinates',
    scene: JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [{ kind: 'download', params: { url: 'structure.pdb' }, children: [] }],
      },
    }),
    createdAt: 1,
    preview: 'data:image/png;base64,aGVsbG8=',
    coordinates: { text: 'ATOM', format: 'pdb', sha256: await coordinateDigest('ATOM') },
    source: {},
    evidence: [],
    activeMeasurementId: 'signal',
    measurements: [
      {
        id: 'signal',
        name: 'Score, "observed"',
        units: 'fraction',
        proteinSequenceSha256: 'a'.repeat(64),
        source: { label: 'Library <1>', analysisId: 'analysis-1', revision: 'revision-1' },
        values: [
          { residue: 1, value: 0 },
          { residue: 2, value: null },
          { residue: 3, value: 1 },
        ],
        scale: {
          transform: 'linear',
          domain: [0, 1],
          colors: ['#440154', '#21918c', '#fde725'],
          missingColor: '#9ca3af',
        },
      },
    ],
  };
}

describe('saved protein figure and measurement export', () => {
  it('embeds the exact saved view and preview, escapes labels, and labels the active color scale', async () => {
    const view = await fixture();
    const svg = await inspectionFigureSvg(view);
    const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(xml.querySelector('parsererror')).toBeNull();
    expect(xml.querySelector('image')?.getAttribute('href')).toBe(view.preview);
    expect(JSON.parse(xml.querySelector('metadata')!.textContent!)).toEqual(view);
    expect(xml.documentElement.textContent).toContain('Score, "observed"');
    expect(xml.documentElement.textContent).toContain('No measurement');
    expect(svg).toContain('Protein &lt;A&amp;B&gt;');
    expect(svg).not.toContain('<script');
    expect(xml.querySelectorAll('linearGradient stop').length).toBe(257);
  });

  it('preserves zero versus missing, exact colors and escaped text in exported rows', async () => {
    const csv = await inspectionMeasurementsCsv(await fixture());
    expect(csv).toContain('"Score, ""observed"""');
    expect(csv).toContain(',1,0,measured,#440154,');
    expect(csv).toContain(',2,,missing,#9ca3af,');
    expect(csv).toContain(',3,1,measured,#fde725,');
    expect(csv).toContain('revision-1');
  });

  it('refuses a figure whose pinned coordinate bytes have changed', async () => {
    const view = await fixture();
    view.coordinates.text = 'DIFFERENT';
    await expect(inspectionFigureSvg(view)).rejects.toThrow('digest');
  });
});

describe('saved molecular view export failures', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['dialog', 'write'] as const)(
    'retains the original %s error for diagnostics',
    async (phase) => {
      const originalError = Object.assign(new Error('PRIVATE_EXPORT_FAILURE'), { code: 'EACCES' });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const picker = vi.spyOn(platform().dialog, 'save');
      const writer = vi.spyOn(platform().fs, 'writeTextFileAtomic');
      if (phase === 'dialog') picker.mockRejectedValueOnce(originalError);
      else {
        picker.mockResolvedValueOnce('/exports/saved-view.json');
        writer.mockRejectedValueOnce(originalError);
      }
      render(createElement(InspectionExport, { view: await fixture() }));
      fireEvent.click(screen.getByText('Export saved view'));
      fireEvent.click(screen.getByRole('button', { name: 'Complete saved scene (.json)' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(errors).toHaveBeenCalledWith(
        '[InspectionExport] Save failed:',
        expect.objectContaining({ format: 'json', phase }),
        originalError
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE_EXPORT_FAILURE');
    }
  );
});
