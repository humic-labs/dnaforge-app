import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  resolveSequenceGeneticCode,
  type AnnotatedSequence,
  type Annotation,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import {
  effectiveGeneticCodeChoice,
  fileDeclaredGeneticCode,
  geneticCodeOptions,
  geneticCodeOverrideFor,
  geneticCodeStatus,
  geneticCodeTriggerLabel,
} from './genetic-code-field-model';
import { buildCustomGeneticCode } from '@waypoint/sequence-utils';

function cds(code?: string, name = 'cds'): Annotation {
  return {
    name,
    type: 'CDS',
    start: 1,
    end: 9,
    direction: 1,
    ...(code ? { qualifiers: { transl_table: [code] } } : {}),
  };
}

function record(annotations: Annotation[], chosenGeneticCode?: GeneticCodeSpec): AnnotatedSequence {
  return {
    id: 'r',
    name: 'r',
    sequence: 'ATGTGAAAA',
    length: 9,
    annotations,
    circular: false,
    ...(chosenGeneticCode ? { chosenGeneticCode } : {}),
  };
}

function model(seq: AnnotatedSequence) {
  const resolution = resolveSequenceGeneticCode(seq);
  return {
    resolution,
    options: geneticCodeOptions(seq, resolution),
    status: geneticCodeStatus(resolution, seq.annotations),
  };
}

const yeastMito = record(Array.from({ length: 19 }, (_, i) => cds('3', `cox${i}`)));

const organellar = record([
  {
    name: 'source',
    type: 'source',
    start: 1,
    end: 9,
    direction: 0,
    qualifiers: { organelle: ['mitochondrion'] },
  },
]);

describe('options', () => {
  it('does not add a status sentence when the file has no declared code', () => {
    expect(model(record([])).status).toBeNull();
  });
  it("leads with the file's own code, highlighted, and never invents a pseudo-option", () => {
    const { options } = model(yeastMito);
    expect(options.map((o) => o.value)).not.toContain('file');
    expect(options[0]).toMatchObject({
      value: '3',
      emphasis: true,
      detail: 'declared by 19 features',
    });
    expect(options).toHaveLength(27);
  });

  it('renders the id and the name as separate columns', () => {
    const { container } = render(<>{model(yeastMito).options[0].labelNode}</>);
    const [id, name] = [...container.querySelectorAll('span > span')].map((e) => e.textContent);
    expect(id).toBe('3');
    expect(name).toBe('Yeast Mitochondrial');
  });

  it('highlights exactly one row', () => {
    expect(model(yeastMito).options.filter((o) => o.emphasis)).toHaveLength(1);
  });

  it('never lists a code twice', () => {
    const values = model(yeastMito).options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('counts each declared code in a mixed file, and leads with the most declared', () => {
    const { options } = model(record([cds('3'), cds('3', 'b'), cds('1', 'c')]));
    expect(options[0]).toMatchObject({
      value: '3',
      emphasis: true,
      detail: 'declared by 2 features',
    });
    const standard = options.find((o) => o.value === '1');
    expect(standard?.detail).toBe('declared by 1 feature');
    expect(standard?.emphasis).toBeUndefined();
  });

  it('does not add explanatory text to the default code option', () => {
    const { options } = model(record([cds()]));
    expect(options[0]).toMatchObject({
      value: '1',
      emphasis: true,
    });
    expect(options[0].detail).toBeUndefined();
  });

  it('warns on the assumed row when the file needs an answer', () => {
    const { options } = model(organellar);
    expect(options[0]).toMatchObject({ value: '1', warn: true });
  });
});

describe('choosing a row', () => {
  it('records nothing when the chosen code is what the file already declares', () => {
    expect(geneticCodeOverrideFor('3', yeastMito)).toBeNull();
  });

  it('records an override when the chosen code differs', () => {
    expect(geneticCodeOverrideFor('4', yeastMito)).toBe(4);
  });

  it('clears by picking Standard when the file declares nothing', () => {
    const plain = record([cds()]);
    expect(geneticCodeOverrideFor('1', plain)).toBeNull();
    expect(geneticCodeOverrideFor('3', plain)).toBe(3);
  });

  it("reads the file's own code past an existing override", () => {
    const overridden = record([cds('3')], 4);
    expect(fileDeclaredGeneticCode(overridden)).toBe(3);
    expect(effectiveGeneticCodeChoice(overridden)).toBe('4');
    expect(geneticCodeOverrideFor('3', overridden)).toBeNull();
  });
});

describe('trigger label', () => {
  it('reads as one code name, with one separator', () => {
    expect(geneticCodeTriggerLabel('3')).toBe('3 — Yeast Mitochondrial');
    expect(geneticCodeTriggerLabel('4')).toMatch(/^4 — Mold Mitochondrial/);
  });
});

describe('status line', () => {
  it('states how many features back a declared code', () => {
    expect(model(yeastMito).status).toEqual({
      text: 'Declared by 19 features in this file.',
      warn: false,
    });
  });

  it('keeps singular grammar for one feature', () => {
    expect(model(record([cds('3')])).status?.text).toBe('Declared by 1 feature in this file.');
  });

  it('only mentions unaffected features once the user has overridden something', () => {
    const chosen = model(record([cds('3'), cds('3', 'b')], 4)).status;
    expect(chosen?.text).toBe('Set by you. 2 features declare their own code and are unaffected.');
    expect(model(yeastMito).status?.text).not.toMatch(/unaffected/);
  });

  it('agrees in number when a single declaring feature is unaffected', () => {
    expect(model(record([cds('3')], 4)).status?.text).toBe(
      'Set by you. 1 feature declares its own code and is unaffected.'
    );
  });

  it('describes an override on a file with nothing declared', () => {
    expect(model(record([cds()], 4)).status?.text).toBe('Set by you, and saved in this file.');
  });

  it('names both codes in a mixed file', () => {
    expect(model(record([cds('3'), cds('1', 'b')])).status?.text).toBe(
      'Mixed file: features declare 1 and 3. Each is read by its own.'
    );
  });

  it('warns and asks, rather than guessing, for an undeclared organellar file', () => {
    const status = model(
      record([
        {
          name: 'source',
          type: 'source',
          start: 1,
          end: 9,
          direction: 0,
          qualifiers: { organelle: ['mitochondrion'] },
        },
      ])
    ).status;
    expect(status?.warn).toBe(true);
    expect(status?.text).toContain('mitochondrion');
    expect(status?.text).toContain('Pick one');
  });

  it('stays one line — no paragraph of standing policy', () => {
    for (const seq of [yeastMito, record([cds()]), record([cds('3')], 4)]) {
      const text = model(seq).status?.text ?? '';
      expect(text.length).toBeLessThan(90);
      expect(text).not.toContain('\n');
    }
  });
});

const AMBER_DRAFT = {
  name: 'Amber suppression (pAzF at TAG)',
  base: 11,
  changes: { TAG: { kind: 'residue' as const, residue: 'pAzF' } },
  residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
};

describe('a code the file names but nothing can read', () => {
  it('asks the user rather than quietly falling back to the standard code', () => {
    const damaged = { ...record([cds()]), unreadableGeneticCode: 'not a published table' };
    const { status } = model(damaged);
    expect(status).toMatchObject({ warn: true });
    expect(status?.text).toMatch(/cannot read/i);
  });
});
