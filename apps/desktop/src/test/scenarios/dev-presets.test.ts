import { describe, it, expect } from 'vitest';
import {
  DEV_SCENARIO_PRESETS,
  getDevScenarioPresetByAlias,
  getDevScenarioPresetById,
} from './dev-presets';
import { referenceAssemblyById } from '../../features/sequence/reference-catalog';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../db/sequence-package-contract';

describe('dev-preset referenceAssemblyId wiring ', () => {
  it('every preset that declares a referenceAssemblyId resolves to a real assembly', () => {
    const withAssembly = DEV_SCENARIO_PRESETS.filter((p) => p.referenceAssemblyId);
    expect(withAssembly.length).toBeGreaterThan(0);
    for (const preset of withAssembly) {
      const entry = referenceAssemblyById(preset.referenceAssemblyId!);
      expect(entry, `preset ${preset.id} → assembly ${preset.referenceAssemblyId}`).toBeTruthy();
    }
  });

  it('never auto-replays machine-local BAM and CRAM presets on renderer boot', () => {
    for (const presetId of [
      'assembly-grch38-local-na12718-cram',
      'assembly-grch38-local-hg002-80x',
      'assembly-grch38-ucsc-tracks',
      'assembly-grch38-local-hg002-80x-mutations',
    ]) {
      expect(getDevScenarioPresetById(presetId)?.noAutoReplay, presetId).toBe(true);
    }
  });

  it('clears the real GRCh38 assembly lane owner before opening the track picker', () => {
    const scenario = getDevScenarioPresetById('assembly-grch38-ucsc-tracks')?.factory();

    expect(scenario?.laneContract).toEqual({
      assemblyId: 'grch38',
      activeDatasets: [],
    });
  });

  it('exposes an exact indexed MG1655 reference journey without resetting the opened canvas', () => {
    const preset = getDevScenarioPresetById('indexed-mg1655-reference');

    expect(preset?.indexedReference).toEqual({
      preferredLocalAssemblyAccession: 'GCF_000005845.2',
      hostedCatalogId: 'ecoliK12Mg1655',
      expectedLengthBp: 4_641_652,
    });
    expect(preset?.factory()).toEqual({ laneContract: {} });
    expect(preset?.noAutoReplay).toBe(true);
    expect(getDevScenarioPresetByAlias('custom-reference-mg1655')?.id).toBe(
      'indexed-mg1655-reference'
    );
  });

  it('registers the one-click Figure 4N showcase as an authentic saved view', () => {
    const preset = getDevScenarioPresetById('pownall-2023-figure-4n-klf17');

    expect(preset).toMatchObject({
      label: 'Pownall Figure 4N — saved view',
      hostedReferenceCatalogId: 'danRer11',
      hostedReferenceMode: 'metadata-shell',
      closeReferenceAfterTrackViewComposition: true,
      noAutoReplay: true,
      trackViewLocalSources: expect.objectContaining({
        'https://track.giraldezlab.org/miao_et_al_2022_molecular_cell_ChIP-seq/danRer11/AGS001841.bw':
          expect.objectContaining({
            relativePath: 'test-fixtures/indexed/danRer11/pownall-figure-4n/AGS001841.bw',
            sizeBytes: 237_968_484,
          }),
      }),
      saveComposedTrackViewAs: {
        id: 'track-view-pownall-2023-figure-4n',
        createdAt: '2023-07-07T00:00:00.000Z',
      },
      trackViewComposition: {
        name: 'Pownall 2023 — Figure 4N recreation',
        preserveCurrentTracks: false,
        viewport: { chrom: 'chr2', start0: 33_322_000, end0: 33_332_000 },
      },
    });
    const scenario = preset?.factory();
    expect(scenario?.canvas).toMatchObject({
      tabs: [
        {
          type: 'chat',
          entityId: 'pownall-figure-4n-agent-showcase',
          label: 'Figure 4N agent demo',
        },
      ],
      activeTabIndex: 0,
    });
    expect(scenario?.chat?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Open my saved GRCz11 Track View'),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('four complete quantitative signal tracks'),
      }),
    ]);
  });
});

describe('chat rendering showcase preset', () => {
  it('exposes the complete  structured-question UI as one DevPanel preset', () => {
    const preset = getDevScenarioPresetById('agent-structured-question-showcase');
    const scenario = preset?.factory();

    expect(preset?.label).toBe('agentStructuredQuestionShowcase');
    expect(preset?.noAutoReplay).toBe(true);
    expect(scenario?.agentUserInput).toMatchObject({
      provider: 'codex-sdk',
      conversationId: scenario.chat?.conversationId,
      questions: [
        expect.objectContaining({
          id: 'method',
          multiSelect: false,
          allowFreeText: true,
          defaultOptionIds: ['gibson'],
        }),
        expect.objectContaining({
          id: 'checks',
          multiSelect: true,
          defaultOptionIds: ['sequence'],
        }),
        expect.objectContaining({ id: 'notes', options: [], allowFreeText: true }),
      ],
    });
  });

  it('exposes the  live inline-chip path as a one-click preset', () => {
    const preset = getDevScenarioPresetById('inline-entity-chips');
    const scenario = preset?.factory();

    expect(preset?.label).toBe('inlineEntityChipsSession');
    expect(preset?.noAutoReplay).toBe(true);
    expect(scenario?.chat?.streamedInlineReferenceText).toContain(
      'dnaforge-chat://entity/sequence/fixture-inline-chips/pUC19'
    );
    expect(scenario?.chat?.streamedInlineReferenceText).not.toContain('dnaforge-chat://workspace/');
    expect(scenario?.chat?.streamedInlineReferenceText).not.toContain('create_reference');
    expect(scenario?.chat?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Show pUC19 and where it lives.',
      }),
    ]);
    expect(scenario?.files?.['/workspace/fixture-inline-chips/pUC19/pUC19.gb']).toContain(
      'DEFINITION  Cloning vector pUC19c, complete sequence.'
    );
    expect(
      scenario?.files?.['/workspace/fixture-inline-chips/pUC19/.forge/plasmid.json']
    ).toContain(`"formatVersion": ${SEQUENCE_PACKAGE_FORMAT_VERSION}`);
  });

  it('gives each inline-chip scenario run a fresh conversation identity', () => {
    const preset = getDevScenarioPresetById('inline-entity-chips');
    const first = preset?.factory();
    const second = preset?.factory();

    expect(first?.chat?.conversationId).toMatch(/^fixture-inline-entity-chips-/);
    expect(second?.chat?.conversationId).toMatch(/^fixture-inline-entity-chips-/);
    expect(first?.canvas?.layout).toBe('split-vertical');
    expect(first?.canvas?.tabs.map((tab) => tab.type)).toEqual(['page', 'chat']);
    expect(first?.pages?.pages).toHaveLength(1);
    expect(first?.chat?.conversationId).not.toBe(second?.chat?.conversationId);
    expect(first?.canvas?.tabs[1]?.entityId).toBe(first?.chat?.conversationId);
    expect(second?.canvas?.tabs[1]?.entityId).toBe(second?.chat?.conversationId);
  });

  it('exposes the exact literal-user and rich-assistant state as a one-click preset', () => {
    const preset = getDevScenarioPresetById('chat-message-rendering-showcase');

    expect(preset).not.toBeNull();
    expect(preset?.label).toBe('chatMessageRenderingShowcase');
    expect(preset?.noAutoReplay).toBe(true);

    const scenario = preset!.factory();
    expect(scenario.canvas).toMatchObject({
      tabs: [
        {
          type: 'chat',
          entityId: 'chat-message-rendering-showcase',
          label: 'Chat rendering review',
        },
      ],
      activeTabIndex: 0,
    });
    expect(scenario.chat?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Literal user text: **not bold**, # not a heading, and > not a quote.',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('# Restriction digest summary'),
      }),
    ]);
    expect(scenario.chat?.messages?.[1]?.content).toContain(
      '| Enzyme | Recognition site | Expected cuts | Fragment 1 | Fragment 2 | Buffer | Incubation |'
    );
  });

  it('binds the full HG002 BAM and official indexed mutation calls in one preset', () => {
    const preset = getDevScenarioPresetByAlias('full-genome-hg002-mutations');
    const scenario = preset?.factory();

    expect(preset?.referenceAssemblyId).toBe('grch38');
    expect(scenario?.laneContract?.assemblyId).toBe('grch38');
    expect(scenario?.laneContract?.activeDataset?.source?.bamPath).toMatch(
      /HG002_Element_80x_GRCh38\.bam$/
    );
    expect(scenario?.variantSource?.path).toMatch(/HG002_GRCh38_1_22_v4\.2\.1_benchmark\.vcf\.gz$/);
  });
});
