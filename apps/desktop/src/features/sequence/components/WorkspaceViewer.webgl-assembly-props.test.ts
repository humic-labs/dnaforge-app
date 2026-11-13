// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workspaceViewerSource = readFileSync(
  'src/features/sequence/components/WorkspaceViewer.tsx',
  'utf8'
);
const scrollNavigationSource = readFileSync(
  'src/features/sequence/components/useSequenceScrollNavigation.ts',
  'utf8'
);

describe('WorkspaceViewer WebGL assembly visual props', () => {
  it('passes actual surface visibility and scroll sync to the viewport marker policy', () => {
    expect(workspaceViewerSource).toMatch(
      /viewportIndicatorVisible=\{workspaceViewerViewportIndicatorVisible\(\s*sequenceSurfaceVisible,\s*actualWebGLMapVisible\s*\)/
    );
  });
  it('threads merged assembly backbone segments into the production map renderer', () => {
    expect(workspaceViewerSource).toMatch(/rulerSegments=\{mergedBackboneSegments\}/);
    expect(workspaceViewerSource).toMatch(
      /<WebGLMap[\s\S]*backboneSegments=\{mergedBackboneSegments\}[\s\S]*cutSites=\{webglCutSites\}/
    );
    expect(workspaceViewerSource).toMatch(
      /<SequenceViewer[\s\S]*rulerSegments=\{mergedBackboneSegments\}/
    );
    expect(workspaceViewerSource).toMatch(
      /selectedBackbonePartRegionId=\{mapSelectedPartRegionId\}/
    );
    expect(workspaceViewerSource).toMatch(/onBackbonePartReorderCommit=\{onMapPartReorderCommit\}/);
    expect(workspaceViewerSource).toMatch(
      /onReverseComplementAssemblyPart=\{[\s\S]*onMapPartReverseComplement/
    );
    expect(workspaceViewerSource).not.toMatch(/<WebGLMap[\s\S]*onBackbonePartReverseComplement=/);
    expect(workspaceViewerSource).not.toContain('StadiumMap');
    expect(workspaceViewerSource).not.toContain('data-minimap-type="stadium"');
    const deletedSvgFallbackName = ['Linear', 'Mini', 'map'].join('');
    expect(workspaceViewerSource).not.toContain(deletedSvgFallbackName);
  });

  it('threads sequence navigation request ids into scroll and highlight effects', () => {
    expect(workspaceViewerSource).toMatch(/sequenceNavigationRequestId\?:/);
    expect(workspaceViewerSource).toMatch(
      /useSequenceScrollNavigation\(\{[\s\S]*sequenceNavigationRequestId/
    );
    expect(scrollNavigationSource).toMatch(
      /scrollToPositionProp == null[\s\S]*scrollToPositionWithTimeout\(scrollToPositionProp, onScrollComplete, \{[\s\S]*completion: sequenceSurfaceVisible \? 'viewer' : 'timer'[\s\S]*sequenceNavigationRequestId/
    );
    expect(scrollNavigationSource).toMatch(
      /highlightRangeProp == null[\s\S]*return;[\s\S]*setHighlightedRange\(\{[\s\S]*sequenceNavigationRequestId/
    );
  });

  it('fits explicit map-only ranges and keeps nucleotide zoom for point jumps before centering', () => {
    expect(workspaceViewerSource).toMatch(
      /resolveMapOnlyRangeFitZoom\(\{[\s\S]*sequenceLength: sequence\.length[\s\S]*\?\?[\s\S]*resolveMapOnlyNucleotideZoom\(\{[\s\S]*setZoom\?\.\(zoom\)[\s\S]*setViewCenter\?\.\(centerBp - 1\)/
    );
  });
});
