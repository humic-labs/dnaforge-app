import { describe, it, expect, vi } from 'vitest';
import {
  buildAssemblyDemoWorkspace,
  buildSampleAssembly,
  regionFromPlasmid,
  assemblyDemoWorkspace,
  ASSEMBLY_DEMO_PARTS,
} from './assembly-demo';
import { getComposedSequence } from '../../features/design/types';

const ROOT = '/tmp/test/assembly-demo';

const CODONS: Record<string, string> = {};
{
  const b = 'TCAG';
  const aa = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
  let i = 0;
  for (const a of b) for (const c of b) for (const d of b) CODONS[a + c + d] = aa[i++];
}
const translate = (s: string) =>
  Array.from(
    { length: Math.floor(s.length / 3) },
    (_, i) => CODONS[s.toUpperCase().slice(i * 3, i * 3 + 3)] ?? 'X'
  ).join('');

describe('assembly demo workspace', () => {
  const ws = buildAssemblyDemoWorkspace(ROOT);

  it('loads five full, annotated plasmids + the README', () => {
    expect(Object.keys(ws.sequences)).toHaveLength(5);
    expect(ws.files[ws.readmePath]).toContain('Extractable parts');

    const pcdna = ws.sequences[ws.documentIds['plasmids/pEGFP-N1.gb']];
    expect(pcdna.circular).toBe(true);
    expect(pcdna.annotations.some((a) => a.type === 'promoter' && /CMV/.test(a.name))).toBe(true);
    expect(pcdna.annotations.some((a) => /EGFP/.test(a.name))).toBe(true);

    const pcw = ws.sequences[ws.documentIds['plasmids/pTRE.gb']];
    expect(pcw.annotations.some((a) => a.type === 'promoter' && /TRE/.test(a.name))).toBe(true);
    expect(pcw.annotations.filter((a) => /tetO/i.test(a.name))).toHaveLength(7);

    const pr6k = ws.sequences[ws.documentIds['plasmids/pUC19-DsRed.gb']];
    expect(pr6k.annotations.some((a) => /FP583/.test(a.name))).toBe(true);
  });

  it('every catalog coordinate extracts the right part from the full plasmid', () => {
    const get = (name: string) => ASSEMBLY_DEMO_PARTS.find((p) => p.part === name)!;
    const slice = (name: string) => {
      const p = get(name);
      return regionFromPlasmid(ws, p.rel, p.start, p.end, p.part, 0).sequence;
    };

    const egfp = slice('EGFP');
    expect(egfp.length % 3).toBe(0);
    expect(translate(egfp).startsWith('MVSKGEELFT')).toBe(true);
    expect(translate(egfp).endsWith('DELYK*')).toBe(true);

    const mscarlet = slice('DsRed (FP583)');
    expect(mscarlet.length % 3).toBe(0);
    expect(translate(mscarlet).startsWith('MRSSKNVIKE')).toBe(true);
    expect(translate(mscarlet).endsWith('GRHHLFL*')).toBe(true);

    expect(slice('TRE promoter').endsWith('CGGGACCGATCCAGCCT')).toBe(true);

    for (const p of ASSEMBLY_DEMO_PARTS) {
      expect(regionFromPlasmid(ws, p.rel, p.start, p.end, p.part, 0).sequence.length).toBe(
        p.end - p.start + 1
      );
    }
  });

  it('drafts a 4-region inducible-red construct from full plasmids', () => {
    const { design } = buildSampleAssembly(
      ['TRE promoter', 'DsRed (FP583)', 'SV40 polyA', 'p15A + KanR backbone'],
      'Dox red',
      ROOT
    );
    expect(design.topology).toBe('circular');
    expect(design.regions).toHaveLength(4);
    expect(new Set(design.regions.map((r) => r.sourceSequenceId)).size).toBe(4);
    expect(design.homologyRegions).toHaveLength(4);
    expect(design.designPrimers).toHaveLength(4);
    expect(design.assemblyState).toBe('ready');

    const composed = getComposedSequence(design.regions, design.spacers);
    expect(composed).toContain('CGGGACCGATCCAGCCTATGAGGTCTTCCAAGAATGTT');
  });

  it('drafts a 3-region constitutive-green construct', () => {
    const { design } = buildSampleAssembly(
      ['CMV promoter', 'EGFP', 'p15A + KanR backbone'],
      'CMV GFP',
      ROOT
    );
    expect(design.regions).toHaveLength(3);
    expect(design.homologyRegions).toHaveLength(3);
    expect(design.designPrimers).toHaveLength(3);
    expect(design.assemblyState).toBe('ready');
  });

  it('factory wires a full-plasmid workspace + a fresh chat (no pre-built design, no forced route)', () => {
    const scenario = assemblyDemoWorkspace();
    expect(scenario.designs).toBeUndefined();
    expect(scenario.workspace?.folders[0]?.name).toBe('assembly-demo');
    expect(scenario.canvas?.tabs.some((t) => t.type === 'sequence')).toBe(true);
    const chatTab = scenario.canvas?.tabs.find((t) => t.type === 'chat');
    expect(chatTab).toBeTruthy();
    expect(chatTab?.entityId).toBeTruthy();
    expect(chatTab?.entityId).not.toBe('test-conversation');
    expect(scenario.chat).toBeUndefined();
  });

  it('each apply uses a distinct fresh chat conversation', () => {
    const a = assemblyDemoWorkspace().canvas?.tabs.find((t) => t.type === 'chat')?.entityId;
    const b = assemblyDemoWorkspace().canvas?.tabs.find((t) => t.type === 'chat')?.entityId;
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('leaves native materialization to the scenario application owner', () => {
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    try {
      const scenario = assemblyDemoWorkspace();
      expect(Object.keys(scenario.files ?? {})).toHaveLength(6);
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      schedule.mockRestore();
    }
  });
});
