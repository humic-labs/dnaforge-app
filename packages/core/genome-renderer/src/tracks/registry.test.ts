import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TRACK_TYPES,
  BUILTIN_TRACK_TYPE_DEFINITIONS,
  CYTOBAND_TYPE,
  CUT_SITE_TYPE,
  GENERIC_INTERVAL_TYPE,
  IMPORTED_TRANSCRIPT_TYPE,
  ORF_TYPE,
  PEAK_TYPE,
  PILEUP_TYPE,
  PRIMER_TYPE,
  QUANTITATIVE_TYPE,
  REPEAT_TYPE,
  SEQUENCE_COMPOSITE_TYPE,
  VARIANT_TYPE,
} from './builtins';
import { createTrackTypeRegistry, defaultBuiltinRegistry } from './registry';
import type { TrackTypeDefinition } from './types';

describe('builtins  /  Phase 2)', () => {
  it('pins the canonical type-string constants — refactor guard for downstream dispatch', () => {
    expect(BUILTIN_TRACK_TYPES).toEqual({
      sequenceComposite: 'sequence-composite',
      primer: 'primer',
      orf: 'orf',
      cutSite: 'cut-site',
      cytoband: 'cytoband',
      importedTranscript: 'imported-transcript',
      genericInterval: 'generic-interval',
      peak: 'peak',
      repeat: 'repeat',
      quantitative: 'quantitative',
      pileup: 'pileup',
      variant: 'variant',
    });
  });

  it('lists every builtin in default render order (cytoband, composite, primer, orf, cut-site)', () => {
    expect(BUILTIN_TRACK_TYPE_DEFINITIONS.map((d) => d.type)).toEqual([
      'cytoband',
      'sequence-composite',
      'primer',
      'orf',
      'cut-site',
      'imported-transcript',
      'generic-interval',
      'peak',
      'repeat',
      'quantitative',
      'pileup',
      'variant',
    ]);
  });

  it('registers semantic scientific types independently from their file formats', () => {
    expect(IMPORTED_TRANSCRIPT_TYPE).toMatchObject({
      family: 'annotation',
      draw: 'transcript-stack',
      dataShape: 'transcripts',
    });
    expect(GENERIC_INTERVAL_TYPE).toMatchObject({
      family: 'annotation',
      draw: 'feature-stack',
      dataShape: 'features',
    });
    expect(PEAK_TYPE).toMatchObject({
      family: 'annotation',
      draw: 'peak-stack',
      dataShape: 'peaks',
    });
    expect(REPEAT_TYPE).toMatchObject({
      family: 'annotation',
      draw: 'repeat-stack',
      dataShape: 'repeats',
    });
    expect(QUANTITATIVE_TYPE).toMatchObject({
      family: 'quantitative',
      draw: 'histogram',
      dataShape: 'quantitative-bins',
    });
    expect(PILEUP_TYPE).toMatchObject({
      family: 'pileup',
      draw: 'read-pileup',
      dataShape: 'reads',
    });
    expect(VARIANT_TYPE).toMatchObject({
      family: 'variant',
      draw: 'variant-marker',
      dataShape: 'variants',
    });
  });

  it('sequence-composite is reference / fitContent / default-visible / never shares scale', () => {
    expect(SEQUENCE_COMPOSITE_TYPE.family).toBe('reference');
    expect(SEQUENCE_COMPOSITE_TYPE.draw).toBe('sequence-band');
    expect(SEQUENCE_COMPOSITE_TYPE.dataShape).toBe('sequence');
    expect(SEQUENCE_COMPOSITE_TYPE.defaultSizing.kind).toBe('fitContent');
    expect(SEQUENCE_COMPOSITE_TYPE.defaultVisible).toBe(true);
    expect(SEQUENCE_COMPOSITE_TYPE.canShareScaleGroup).toBe(false);
  });

  it('primer / orf / cut-site are plasmid-family feature-stack types', () => {
    for (const def of [PRIMER_TYPE, ORF_TYPE]) {
      expect(def.family).toBe('plasmid');
      expect(def.draw).toBe('feature-stack');
      expect(def.dataShape).toBe('features');
    }
    expect(CUT_SITE_TYPE.family).toBe('plasmid');
    expect(CUT_SITE_TYPE.draw).toBe('variant-marker');
    expect(CUT_SITE_TYPE.dataShape).toBe('features');
  });

  it('cytoband is reference-family, fixed-sized strip (NEW for Phase 2; no UnifiedLayout counterpart)', () => {
    expect(CYTOBAND_TYPE.family).toBe('reference');
    expect(CYTOBAND_TYPE.draw).toBe('cytoband-strip');
    expect(CYTOBAND_TYPE.defaultSizing.kind).toBe('fixed');
    expect(CYTOBAND_TYPE.defaultSizing).toEqual({
      kind: 'fixed',
      pixels: 32,
      minHeight: 32,
      maxHeight: 34,
    });
    expect(CYTOBAND_TYPE.defaultVisible).toBe(true);
  });
});

describe('createTrackTypeRegistry — semantics', () => {
  it('empty registry returns undefined for unknown types and an empty list', () => {
    const r = createTrackTypeRegistry();
    expect(r.getTrackTypeDefinition('anything')).toBeUndefined();
    expect(r.listTrackTypeDefinitions()).toEqual([]);
  });

  it('registerTrackType stores the definition; getTrackTypeDefinition retrieves it', () => {
    const r = createTrackTypeRegistry();
    r.registerTrackType(CYTOBAND_TYPE);
    expect(r.getTrackTypeDefinition('cytoband')).toBe(CYTOBAND_TYPE);
  });

  it('listTrackTypeDefinitions returns registrations in INSERTION order', () => {
    const r = createTrackTypeRegistry();
    r.registerTrackType(PRIMER_TYPE);
    r.registerTrackType(ORF_TYPE);
    r.registerTrackType(CYTOBAND_TYPE);
    expect(r.listTrackTypeDefinitions().map((d) => d.type)).toEqual(['primer', 'orf', 'cytoband']);
  });

  it('re-registering the same type REPLACES (idempotent on type; insertion position preserved)', () => {
    const r = createTrackTypeRegistry();
    r.registerTrackType(PRIMER_TYPE);
    r.registerTrackType(ORF_TYPE);
    const replacement: TrackTypeDefinition = { ...PRIMER_TYPE, label: 'Custom primers' };
    r.registerTrackType(replacement);
    expect(r.listTrackTypeDefinitions().map((d) => d.type)).toEqual(['primer', 'orf']);
    expect(r.getTrackTypeDefinition('primer')?.label).toBe('Custom primers');
  });
});

describe('defaultBuiltinRegistry', () => {
  it('returns a registry pre-populated with every builtin in default order', () => {
    const r = defaultBuiltinRegistry();
    expect(r.listTrackTypeDefinitions().map((d) => d.type)).toEqual([
      'cytoband',
      'sequence-composite',
      'primer',
      'orf',
      'cut-site',
      'imported-transcript',
      'generic-interval',
      'peak',
      'repeat',
      'quantitative',
      'pileup',
      'variant',
    ]);
  });

  it('every builtin is lookup-able by its canonical type string', () => {
    const r = defaultBuiltinRegistry();
    for (const key of Object.values(BUILTIN_TRACK_TYPES)) {
      expect(r.getTrackTypeDefinition(key), `missing builtin: ${key}`).toBeDefined();
    }
  });

  it('two calls produce independent registries (no shared mutable state)', () => {
    const a = defaultBuiltinRegistry();
    const b = defaultBuiltinRegistry();
    a.registerTrackType({ ...CYTOBAND_TYPE, label: 'Mutated A' });
    expect(b.getTrackTypeDefinition('cytoband')?.label).toBe(CYTOBAND_TYPE.label);
  });
});
