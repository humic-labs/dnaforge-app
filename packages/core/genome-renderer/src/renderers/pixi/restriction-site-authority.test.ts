// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { findCutSites, type EnzymeDataFile } from '@waypoint/sequence-utils';
import type { CutSite } from '../../biology/restriction-sites';
import type { Genome, RenderState } from '../../types';
import { PixiLinearRenderer } from './linear-renderer';
import { PixiStadiumRenderer } from './stadium-renderer';
import { RestrictionTrack } from './tracks/restriction-track';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

const catalog = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../../apps/desktop/public/data/rebase/merged-enzymes.json'
    ),
    'utf8'
  )
) as EnzymeDataFile;

beforeAll(() => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    vi.stubGlobal('CanvasRenderingContext2D', class CanvasRenderingContext2D {});
  }
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ['linear', PixiLinearRenderer, false],
  ['circular', PixiStadiumRenderer, true],
] as const)('%s restriction site authority', (_name, Renderer, circular) => {
  it('renders only supplied catalog sites and clears them when the genome changes', async () => {
    vi.stubGlobal('__webglSkipInternalCutSites', false);
    const renderSites = vi
      .spyOn(RestrictionTrack.prototype, 'renderSites')
      .mockImplementation(() => {});
    const sequence = `${'A'.repeat(300)}GAATTCGAGCTC${'A'.repeat(688)}`;
    const genome: Genome = {
      name: 'catalog-enzyme-selection',
      length: sequence.length,
      circular,
      sequence,
      features: [],
    };
    const state: RenderState = {
      morph: circular ? 0 : 1,
      viewOffset: 0,
      zoom: 20,
      width: 800,
      height: 400,
      selectedIds: new Set(),
      hoveredId: null,
      viewportRange: null,
      highlightRange: null,
      cursorPosition: null,
      hoveredCutSiteId: null,
      perfPanelVisible: false,
    };
    const renderer = new Renderer();
    try {
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        genome,
        () => state
      );
      renderer.render(state);
      expect(renderSites).not.toHaveBeenCalled();

      const sacI = catalog.enzymes.find((enzyme) => enzyme.name === 'SacI')!;
      const hits = findCutSites(sequence, sacI, { circular });
      expect(hits).toHaveLength(1);
      const sites: CutSite[] = hits.map((site) => ({
        enzyme: {
          name: site.enzyme.name,
          recognition: site.enzyme.recognition_sequence,
          cutTop: site.enzyme.cut_position_top!,
          cutBottom: site.enzyme.cut_position_bottom!,
        },
        position: site.recognitionStart,
        recognitionEnd: site.recognitionEnd,
        cutPositionTop: site.cutPositionTop,
        cutPositionBottom: site.cutPositionBottom,
        overhang: '3prime',
      }));
      renderer.setCutSites(sites);
      renderer.render(state);
      expect(renderSites).toHaveBeenCalledTimes(1);
      expect(renderSites.mock.calls[0][0]).toBe(sites);
      expect(renderSites.mock.calls[0][0].map((site) => site.enzyme.name)).toEqual(['SacI']);

      renderSites.mockClear();
      renderer.setCutSites([]);
      renderer.render(state);
      expect(renderSites).not.toHaveBeenCalled();

      renderer.setCutSites(sites);
      await renderer.loadGenome({ ...genome, name: 'other-sequence' });
      renderer.render(state);
      expect(renderSites).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
    }
  });
});
