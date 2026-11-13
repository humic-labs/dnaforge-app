import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH,
  ASSEMBLY_COLOR_SCHEME_OPTIONS,
  DEFAULT_ASSEMBLY_COLOR_SCHEME,
  ASSEMBLY_PROVENANCE_STROKE_ALPHA,
  ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
  ASSEMBLY_SEGMENT_RAIL_WIDTH,
  ASSEMBLY_SPACER_COLOR,
  getAssemblyColorScheme,
  getAssemblyBackboneProvenanceStyle,
  getFragmentHex,
  getAssemblyPartRailColor,
  getAssemblyPartSurfaceColor,
  getAssemblySegmentRailColor,
  getAssemblySpacerProvenanceStyle,
  getAssemblyVisualizationHex,
  getAssemblyVisualizationHexForRegion,
  resolveAssemblyColorSchemeId,
} from './colors';
import { useAssemblyColorSchemeStore } from './color-scheme-store';

describe('assembly color tokens', () => {
  it('defaults to the Tailwind assembly palette and removes the pale legacy scheme', () => {
    expect(DEFAULT_ASSEMBLY_COLOR_SCHEME).toBe('tailwind');
    expect(
      getAssemblyColorScheme('tailwind')
        .colors.slice(0, 3)
        .map((color) => color.hex)
    ).toEqual(['#3b82f6', '#10b981', '#f59e0b']);
    expect(ASSEMBLY_COLOR_SCHEME_OPTIONS.map((scheme) => scheme.value)).toEqual([
      'tailwind',
      'radix',
      'carbon',
      'category10',
      'observable',
      'material',
      'okabeIto',
    ]);
    expect(resolveAssemblyColorSchemeId('soft')).toBe('tailwind');
    expect(resolveAssemblyColorSchemeId('vivid')).toBe('tailwind');
  });

  it('includes researched categorical palettes for sleek software surfaces', () => {
    expect(
      getAssemblyColorScheme('radix')
        .colors.slice(0, 4)
        .map((color) => color.hex)
    ).toEqual(['#0090ff', '#30a46c', '#ffc53d', '#e5484d']);
    expect(
      getAssemblyColorScheme('carbon')
        .colors.slice(0, 4)
        .map((color) => color.hex)
    ).toEqual(['#6929c4', '#1192e8', '#005d5d', '#9f1853']);
    expect(
      getAssemblyColorScheme('category10')
        .colors.slice(0, 4)
        .map((color) => color.hex)
    ).toEqual(['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728']);
    expect(
      getAssemblyColorScheme('okabeIto')
        .colors.slice(0, 4)
        .map((color) => color.hex)
    ).toEqual(['#0072b2', '#e69f00', '#009e73', '#d55e00']);
  });

  it('uses the active persisted scheme when no explicit scheme is provided', () => {
    useAssemblyColorSchemeStore.setState({ assemblyColorScheme: 'carbon' });
    expect(getFragmentHex(0)).toBe('#6929c4');

    useAssemblyColorSchemeStore.setState({ assemblyColorScheme: 'tailwind' });
    expect(getFragmentHex(0)).toBe('#3b82f6');
  });

  it('migrates the dull legacy Tableau option to the more saturated Category 10 palette', () => {
    expect(resolveAssemblyColorSchemeId('tableau')).toBe('category10');
  });

  it('tones source colors once for assembly surfaces and ruler provenance', () => {
    expect(getAssemblyVisualizationHex('#3b82f6')).toBe('#3b82f6');
    expect(getAssemblyVisualizationHex('#10b981')).toBe('#10b981');
    expect(getAssemblyVisualizationHex('#f59e0b')).toBe('#f59e0b');
  });

  it('uses the same toned color for part-card rails and sequence ruler segments', () => {
    const region = { colorIndex: 0 };

    expect(getAssemblyPartRailColor('#3b82f6')).toBe(
      getAssemblyVisualizationHexForRegion(region, 0)
    );
    expect(getAssemblyPartSurfaceColor('#3b82f6')).toBe('rgba(59, 130, 246, 0.24)');
  });

  it('defines spacer gray as an assembly color token instead of local one-off grays', () => {
    expect(ASSEMBLY_SPACER_COLOR).toBe('#8b95a1');
  });

  it('uses one segment rail primitive for fragment and spacer cards', () => {
    expect(ASSEMBLY_SEGMENT_RAIL_WIDTH).toBe(3);
    expect(getAssemblySegmentRailColor('fragment', '#3b82f6')).toBe(
      getAssemblyPartRailColor('#3b82f6')
    );
    expect(getAssemblySegmentRailColor('neutral', '#3b82f6')).toBe(ASSEMBLY_SPACER_COLOR);
  });

  it('authors provenance stroke color, width, and alpha before Canvas/WebGL rendering', () => {
    expect(ASSEMBLY_PROVENANCE_STROKE_ALPHA).toBe(1);
    expect(ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH).toBe(5.25);
    expect(getAssemblyBackboneProvenanceStyle('#3b82f6')).toEqual({
      color: getAssemblyVisualizationHex('#3b82f6'),
      strokeWidth: ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH,
      alpha: ASSEMBLY_PROVENANCE_STROKE_ALPHA,
      themeStableColor: true,
    });
    expect(ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH).toBe(2);
    expect(getAssemblySpacerProvenanceStyle()).toEqual({
      color: ASSEMBLY_SPACER_COLOR,
      strokeWidth: ASSEMBLY_BACKBONE_PROVENANCE_STROKE_WIDTH,
      alpha: ASSEMBLY_PROVENANCE_STROKE_ALPHA,
      themeStableColor: true,
    });
  });
});
