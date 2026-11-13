// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  resolveTmModel,
  DEFAULT_TM_MODEL,
  OWCZARZY_TM_MODEL,
  NEB_TM_OPTIONS,
  tmModelSelectValue,
  tmModelFromSelectValue,
  type TmModel,
} from './tm-model';

describe('resolveTmModel — the single Tm-algorithm configurator', () => {
  it('defaults to the local model when nothing is specified (NEB is not the default)', () => {
    expect(resolveTmModel({})).toEqual(DEFAULT_TM_MODEL);
    expect(DEFAULT_TM_MODEL.kind).toBe('local');
  });

  it('uses an explicit user choice over everything else', () => {
    const nebQ5: TmModel = { kind: 'neb', polymerase: 'q5', prodcode: 'q5-0' };
    expect(resolveTmModel({ userChoice: nebQ5 })).toEqual(nebQ5);
  });

  it('derives NEB Q5 from the reaction when Q5 polymerase is defined and no explicit choice', () => {
    const model = resolveTmModel({ reaction: { polymerase: 'Q5' } });
    expect(model.kind).toBe('neb');
    expect(model).toMatchObject({ polymerase: 'q5', prodcode: 'q5-0' });
  });

  it('lets an explicit user choice override a reaction-implied model (even back to local)', () => {
    const model = resolveTmModel({
      userChoice: DEFAULT_TM_MODEL,
      reaction: { polymerase: 'Q5' },
    });
    expect(model).toEqual(DEFAULT_TM_MODEL);
  });

  it('falls back to the default when the reaction enzyme is unrecognized', () => {
    expect(resolveTmModel({ reaction: { polymerase: 'some-unknown-pol' } })).toEqual(
      DEFAULT_TM_MODEL
    );
  });

  it('derives other polymerase families from the reaction (Phusion -> phusion-0)', () => {
    const model = resolveTmModel({ reaction: { polymerase: 'Phusion' } });
    expect(model).toMatchObject({ kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' });
  });
});

describe('NEB polymerase catalog + picker helpers', () => {
  it('offers a flat, self-labeled catalog across polymerase families', () => {
    const prodcodes = NEB_TM_OPTIONS.map((o) => o.prodcode);
    expect(prodcodes).toEqual(
      expect.arrayContaining(['q5-0', 'q5hs-0', 'phusion-0', 'onetaq-0', 'taq-0', 'lataq-0'])
    );
    expect(new Set(NEB_TM_OPTIONS.map((o) => o.family))).toEqual(
      new Set(['q5', 'phusion', 'onetaq', 'taq', 'longamp'])
    );
    expect(NEB_TM_OPTIONS.every((o) => o.label.startsWith('NEB '))).toBe(true);
  });

  it('maps a model to/from its picker value', () => {
    expect(tmModelSelectValue(DEFAULT_TM_MODEL)).toBe('local');
    const phusion: TmModel = { kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' };
    expect(tmModelSelectValue(phusion)).toBe('phusion-0');

    expect(tmModelFromSelectValue('local')).toEqual(DEFAULT_TM_MODEL);
    expect(tmModelFromSelectValue('phusion-0')).toEqual(phusion);
    expect(tmModelSelectValue(OWCZARZY_TM_MODEL)).toBe('owczarzy');
    expect(tmModelFromSelectValue('owczarzy')).toEqual(OWCZARZY_TM_MODEL);
    expect(tmModelFromSelectValue('not-a-code')).toEqual(DEFAULT_TM_MODEL);
  });
});
