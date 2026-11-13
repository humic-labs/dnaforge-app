import { parseGenBankFull } from '@waypoint/sequence-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { applyScenario, resetAllStores } from './apply';
import { sidecarScenarios, withMafft, withPlugin } from './sidecar';
import { withPUC19, withGFP, withMiniPlasmid, PUC19, GFP_LINEAR } from './sequences';
import { withSequenceTab, withSplitLayout, withChatTab, withMultipleTabs } from './canvas';
import { withWorkspaceFolder, withStandardWorkspace, withEmptyWorkspace } from './workspace';
import { useCanvasStore } from '../../features/canvas/store';
import { useSequenceStore } from '../../features/sequence/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { AppScenario } from './types';
import { PUC19_GENBANK } from '../fixtures/sequences';

afterEach(() => {
  resetAllStores();
});

describe('Deep composition chains', () => {
  it('stacks 5+ modifiers and retains all state', () => {
    const scenario = withSplitLayout(
      withGFP(
        withPUC19(
          withStandardWorkspace(
            withChatTab({
              sidecar: withPlugin(withMafft(sidecarScenarios.downloadingTools(50)), 'alphafold', {
                label: 'AlphaFold',
                url: 'http://localhost:9001',
              }),
            })
          )
        )
      ),
      'split-vertical'
    );

    applyScenario(scenario);

    expect(global.fetch).toBeDefined();
    const sidecar = scenario.sidecar!;
    expect(sidecar.capabilities.find((c) => c.id === 'annotation')).toBeDefined();
    expect(sidecar.capabilities.find((c) => c.id === 'alignment')).toBeDefined();
    expect(sidecar.capabilities.find((c) => c.id === 'alphafold')).toBeDefined();
    const alignment = sidecar.capabilities.find((c) => c.id === 'alignment')!;
    expect(alignment.status).toBe('ready');

    const canvas = useCanvasStore.getState();
    const allTabs = Object.values(canvas.panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(3);
    expect(canvas.layout.type).toBe('split');

    const seqs = useSequenceStore.getState().sequences;
    expect(seqs['fixture:sequence:puc19']).toBeDefined();
    expect(seqs['fixture:sequence:gfp']).toBeDefined();

    expect(useWorkspaceStore.getState().folders).toHaveLength(2);
  });
});

describe('Modifier order independence', () => {
  it('withGFP + withPUC19 in either order produces same sequences', () => {
    const base: AppScenario = { sidecar: sidecarScenarios.fullyReady() };

    const a = withGFP(withPUC19(base));
    const b = withPUC19(withGFP(base));

    expect(Object.keys(a.sequences!).sort()).toEqual(Object.keys(b.sequences!).sort());
    expect(a.sequences!['fixture:sequence:puc19']).toEqual(b.sequences!['fixture:sequence:puc19']);
    expect(a.sequences!['fixture:sequence:gfp']).toEqual(b.sequences!['fixture:sequence:gfp']);
  });

  it('withWorkspaceFolder order does not lose data', () => {
    const base: AppScenario = { sidecar: sidecarScenarios.fullyReady() };

    const a = withWorkspaceFolder(withWorkspaceFolder(base, '/lab/a'), '/lab/b');
    const b = withWorkspaceFolder(withWorkspaceFolder(base, '/lab/b'), '/lab/a');

    expect(a.workspace!.folders).toHaveLength(2);
    expect(b.workspace!.folders).toHaveLength(2);

    const aPaths = a.workspace!.folders.map((f) => f.path).sort();
    const bPaths = b.workspace!.folders.map((f) => f.path).sort();
    expect(aPaths).toEqual(bPaths);
  });

  it('withMafft + withPlugin order does not matter for sidecar', () => {
    const base = sidecarScenarios.freshInstall();

    const a = withPlugin(withMafft(base), 'ext');
    const b = withMafft(withPlugin(base, 'ext'));

    const aAlignment = a.capabilities.find((c) => c.id === 'alignment')!;
    const bAlignment = b.capabilities.find((c) => c.id === 'alignment')!;
    expect(aAlignment.status).toBe('ready');
    expect(bAlignment.status).toBe('ready');

    expect(a.capabilities.find((c) => c.id === 'ext')).toBeDefined();
    expect(b.capabilities.find((c) => c.id === 'ext')).toBeDefined();
  });
});

describe('Duplicate modifier idempotency', () => {
  it('applying withPUC19 twice creates 2 tabs (documents additive behavior)', () => {
    const base: AppScenario = { sidecar: sidecarScenarios.fullyReady() };
    const doubled = withPUC19(withPUC19(base));

    expect(doubled.canvas!.tabs).toHaveLength(2);
    expect(doubled.canvas!.tabs[0].entityId).toBe('fixture:sequence:puc19');
    expect(doubled.canvas!.tabs[1].entityId).toBe('fixture:sequence:puc19');

    expect(Object.keys(doubled.sequences!)).toHaveLength(1);
  });

  it('applying withWorkspaceFolder twice with same path creates 2 entries', () => {
    const base: AppScenario = {};
    const doubled = withWorkspaceFolder(withWorkspaceFolder(base, '/workspace'), '/workspace');

    expect(doubled.workspace!.folders).toHaveLength(2);
  });

  it('applying withPlugin twice with same id creates 2 capabilities', () => {
    const base = sidecarScenarios.fullyReady();
    const doubled = withPlugin(withPlugin(base, 'ext'), 'ext');

    const extCaps = doubled.capabilities.filter((c) => c.id === 'ext');
    expect(extCaps).toHaveLength(2);
  });
});

describe('Cross-domain consistency', () => {
  it('withPUC19 creates matching tab, sequence, and file', () => {
    const scenario = withPUC19({ sidecar: sidecarScenarios.fullyReady() });
    const inMemorySequence = scenario.sequences!['fixture:sequence:puc19'];
    const materializedSequence = parseGenBankFull(scenario.files!['/workspace/pUC19.gb']);

    expect(inMemorySequence).toBeDefined();
    expect(inMemorySequence.name).toBe('pUC19');

    expect(materializedSequence.sequence).toHaveLength(2_686);
    expect(materializedSequence.length).toBe(materializedSequence.sequence.length);
    expect(inMemorySequence.sequence).toBe(materializedSequence.sequence);
    expect(inMemorySequence.length).toBe(materializedSequence.length);
    expect(PUC19_GENBANK).toBe(
      readFileSync(
        join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'),
        'utf8'
      )
    );

    expect(scenario.canvas?.tabs.some((t) => t.entityId === 'fixture:sequence:puc19')).toBe(true);

    expect(scenario.files?.['/workspace/pUC19.gb']).toBeDefined();
    expect(typeof scenario.files!['/workspace/pUC19.gb']).toBe('string');
  });

  it('withGFP creates matching tab, sequence, and file', () => {
    const scenario = withGFP({ sidecar: sidecarScenarios.fullyReady() });

    expect(scenario.sequences?.['fixture:sequence:gfp']).toBeDefined();
    expect(scenario.sequences!['fixture:sequence:gfp'].name).toBe('GFP');

    expect(scenario.canvas?.tabs.some((t) => t.entityId === 'fixture:sequence:gfp')).toBe(true);

    expect(scenario.files?.['/workspace/gfp.fasta']).toBeDefined();
  });

  it('withMiniPlasmid creates tab and sequence but no file content', () => {
    const scenario = withMiniPlasmid({ sidecar: sidecarScenarios.fullyReady() });

    expect(scenario.sequences?.['fixture:sequence:mini-plasmid']).toBeDefined();
    expect(scenario.canvas?.tabs.some((t) => t.entityId === 'fixture:sequence:mini-plasmid')).toBe(
      true
    );

    expect(scenario.files?.['/workspace/mini.gb']).toBeUndefined();
  });

  it('withStandardWorkspace populates files in workspace folders', () => {
    const scenario = withStandardWorkspace({});

    expect(scenario.workspace!.folders).toHaveLength(2);

    expect(scenario.files!['/workspace/plasmids/pUC19.gb']).toBeDefined();
    expect(scenario.files!['/workspace/sequences/gfp.fasta']).toBeDefined();
  });
});

describe('Novel fixture composition', () => {
  it('builds alignment review scenario that was not pre-planned', () => {
    const alignmentReview = withSplitLayout(
      withGFP(
        withPUC19(
          withWorkspaceFolder(
            { sidecar: sidecarScenarios.downloadingDatabases(75) },
            '/lab/alignments'
          )
        )
      ),
      'split-vertical'
    );

    applyScenario(alignmentReview);

    const canvas = useCanvasStore.getState();
    const allTabs = Object.values(canvas.panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(2);
    expect(canvas.layout.type).toBe('split');

    const seqs = useSequenceStore.getState().sequences;
    expect(Object.keys(seqs)).toHaveLength(2);

    expect(useWorkspaceStore.getState().folders).toHaveLength(1);
    expect(useWorkspaceStore.getState().folders[0].path).toBe('/lab/alignments');
  });

  it('builds multi-sequence editing session with plugins', () => {
    const multiEdit = withMiniPlasmid(
      withGFP(
        withPUC19({
          sidecar: withPlugin(
            withPlugin(sidecarScenarios.fullyReady(), 'codon_optimizer', {
              label: 'Codon Optimizer',
            }),
            'gene_synthesis',
            { label: 'Gene Synthesis' }
          ),
        })
      )
    );

    applyScenario(multiEdit);

    const seqs = useSequenceStore.getState().sequences;
    expect(Object.keys(seqs)).toHaveLength(3);

    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(3);

    expect(multiEdit.sidecar!.capabilities).toHaveLength(6);
  });

  it('builds fresh install with empty workspace and chat tab', () => {
    const freshWithChat = withChatTab(
      withEmptyWorkspace({ sidecar: sidecarScenarios.freshInstall() }, '/new-project')
    );

    applyScenario(freshWithChat);

    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(allTabs[0].type).toBe('chat');

    expect(useWorkspaceStore.getState().folders).toHaveLength(1);
    expect(useWorkspaceStore.getState().folders[0].path).toBe('/new-project');
  });
});

describe('Gap identification', () => {
  it('TODO: alignment results cannot be represented yet', () => {
    const scenario: AppScenario = {
      sidecar: sidecarScenarios.fullyReady(),
    };

    expect('alignments' in scenario).toBe(false);
  });

  it('TODO: primer design state cannot be represented yet', () => {
    const scenario: AppScenario = {
      sidecar: sidecarScenarios.fullyReady(),
    };

    expect('primers' in scenario).toBe(false);
  });

  it('TODO: notebook content cannot be represented yet', () => {
    const scenario: AppScenario = {
      sidecar: sidecarScenarios.fullyReady(),
    };

    expect('notebook' in scenario).toBe(false);
  });

  it('TODO: AI chat history cannot be represented yet', () => {
    const scenario = withChatTab({ sidecar: sidecarScenarios.fullyReady() });

    expect(scenario.canvas?.tabs[0].type).toBe('chat');
    expect('messages' in (scenario as Record<string, unknown>)).toBe(false);
  });
});
