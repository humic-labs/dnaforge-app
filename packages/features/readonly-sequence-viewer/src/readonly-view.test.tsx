// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadReadonlyGenBank,
  ReadonlyPlasmidViewer,
  type ReadonlyGenBankLoadResult,
  type ReadonlyPlasmidView,
} from './index';

const PUC19_PATH = resolve(process.cwd(), '../../../test-fixtures/sequences/circular/pUC19.gb');
const LINEAR_REFERENCE_PATH = resolve(
  process.cwd(),
  '../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function loadFixture(path: string): Extract<ReadonlyGenBankLoadResult, { ok: true }>['plasmid'] {
  const result = loadReadonlyGenBank({ kind: 'bytes', bytes: readFileSync(path) });
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.plasmid;
}

function renderViewer(
  plasmid: Extract<ReadonlyGenBankLoadResult, { ok: true }>['plasmid'],
  view: ReadonlyPlasmidView
): void {
  act(() => root.render(<ReadonlyPlasmidViewer plasmid={plasmid} view={view} />));
}

function readonlyViewer(): HTMLElement {
  const viewer = container.querySelector<HTMLElement>('[data-testid="readonly-plasmid-viewer"]');
  if (!viewer) throw new Error('readonly viewer did not render');
  return viewer;
}

function renderedFeatures(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="readonly-plasmid-feature"]')
  );
}

describe('ReadonlyPlasmidViewer', () => {
  it.each(['stadium', 'linear'] as const)(
    'keeps primer-binding annotations visible in the %s map without changing parsed identity',
    (view) => {
      const plasmid = loadFixture(PUC19_PATH);
      const features = plasmid.features;
      const primers = plasmid.primers;
      expect(features).toHaveLength(6);
      expect(primers).toHaveLength(2);
      Object.freeze(features);
      Object.freeze(primers);

      renderViewer(plasmid, view);

      expect(readonlyViewer().getAttribute('aria-label')).toBe(
        'SYNPUC19CV, 2,686 base pairs, 8 annotations'
      );
      const annotations = renderedFeatures();
      expect(new Set(annotations.map((feature) => feature.dataset.featureIndex)).size).toBe(8);
      expect(annotations).toHaveLength(8);
      const primerFeatures = annotations.filter(
        (feature) => feature.dataset.featureType === 'primer_bind'
      );
      expect(new Set(primerFeatures.map((feature) => feature.dataset.featureIndex)).size).toBe(2);
      for (const primer of primers) {
        const segments = primerFeatures.filter((node) => node.dataset.featureName === primer.name);
        expect(segments).toHaveLength(view === 'linear' && primer.start > primer.end ? 2 : 1);
        for (const feature of segments) {
          expect(feature.dataset.featureStart).toBe(String(primer.start + 1));
          expect(feature.dataset.featureEnd).toBe(String(primer.end));
          expect(feature.dataset.featureDirection).toBe(primer.direction);
        }
      }
      expect(plasmid.features).toBe(features);
      expect(plasmid.primers).toBe(primers);
    }
  );

  it('renders pUC19 as an annotated circular stadium map', () => {
    const plasmid = loadFixture(PUC19_PATH);
    renderViewer(plasmid, 'stadium');

    expect(plasmid.circular).toBe(true);
    expect(readonlyViewer().getAttribute('data-view')).toBe('stadium');
    expect(
      container.querySelector('svg[role="img"][aria-label="Stadium annotation map for SYNPUC19CV"]')
    ).toBeTruthy();
    expect(container.textContent).toContain('2,686 bp · circular');

    const features = renderedFeatures();
    expect(features).toHaveLength(plasmid.features.length + plasmid.primers.length);
    expect(features.length).toBeGreaterThan(0);
    const firstFeature = container.querySelector('[data-feature-index="0"]');
    expect(firstFeature?.getAttribute('data-feature-name')).toBe(plasmid.features[0].displayName);
    expect(firstFeature?.getAttribute('data-feature-type')).toBe(plasmid.features[0].type);
    expect(firstFeature?.getAttribute('data-feature-start')).toBe(
      String(plasmid.features[0].start)
    );
    expect(firstFeature?.getAttribute('data-feature-end')).toBe(String(plasmid.features[0].end));
    expect(firstFeature?.getAttribute('data-feature-direction')).toBe(
      plasmid.features[0].direction
    );
    const backbone = container.querySelector('path.readonly-plasmid-backbone');
    expect(backbone?.getAttribute('d')).toBeTruthy();
    expect(backbone?.getAttribute('stroke')).toBe('var(--dnaforge-readonly-backbone, #4f6657)');
  });

  it('renders the registered MG1655 region as an annotated linear map', () => {
    const plasmid = loadFixture(LINEAR_REFERENCE_PATH);
    renderViewer(plasmid, 'linear');

    expect(plasmid).toMatchObject({
      name: 'ecoli_region',
      length: 78345,
      circular: false,
    });
    expect(readonlyViewer().getAttribute('data-view')).toBe('linear');
    expect(
      container.querySelector(
        'svg[role="img"][aria-label="Linear annotation map for ecoli_region"]'
      )
    ).toBeTruthy();
    expect(container.textContent).toContain('78,345 bp · 182 annotations');

    const features = renderedFeatures();
    expect(features).toHaveLength(plasmid.features.length);
    expect(features.some((node) => node.dataset.featureName === 'yagG gene')).toBe(true);
    expect(container.textContent).toContain('0 bp');
    expect(container.textContent).toContain('78.3 kb');
  });

  it('renders parsed linear input as a stadium and switches the mounted viewer to linear', () => {
    const parsedResult = loadReadonlyGenBank({
      kind: 'parsed',
      plasmid: loadFixture(LINEAR_REFERENCE_PATH),
    });
    if (!parsedResult.ok) {
      throw new Error(`${parsedResult.error.code}: ${parsedResult.error.message}`);
    }

    renderViewer(parsedResult.plasmid, 'stadium');

    expect(readonlyViewer().getAttribute('data-view')).toBe('stadium');
    expect(container.textContent).toContain('78,345 bp · linear');
    const stadiumFeature = container.querySelector<SVGPathElement>('path.readonly-plasmid-feature');
    expect(stadiumFeature?.getAttribute('d')).toBeTruthy();

    renderViewer(parsedResult.plasmid, 'linear');

    expect(readonlyViewer().getAttribute('data-view')).toBe('linear');
    expect(
      container.querySelector(
        'svg[role="img"][aria-label="Stadium annotation map for ecoli_region"]'
      )
    ).toBeNull();
    const linearFeature = container.querySelector<SVGRectElement>('rect.readonly-plasmid-feature');
    expect(Number(linearFeature?.getAttribute('x'))).toBeGreaterThanOrEqual(0);
    expect(Number(linearFeature?.getAttribute('width'))).toBeGreaterThan(2);
  });
});
