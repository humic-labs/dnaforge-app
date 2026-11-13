import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { useDesignStore } from '../features/design/store';
import { useVerificationStore } from '../features/alignment-manager/store';
import { useChatStore } from '../features/ai/hooks/useChat';
import { useCanvasStore } from '../features/canvas/store';
import { useSequenceStore } from '../features/sequence/store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  clearLastAppliedDevScenarioPreset,
  getLastAppliedDevScenarioPresetId,
} from '../test/scenarios/apply-dev';
import {
  ALIGNMENT_STALE_DOCUMENT_ID,
  ALIGNMENT_STALE_REFERENCE_PATH,
} from '../test/scenarios/alignment';
import { realAssemblyPipelineDevScenarios } from '../test/scenarios/assembly-real-pipeline';
import {
  MULTI_PROJECT_ALPHA_ROOT,
  MULTI_PROJECT_ALPHA_DOCUMENT_ID,
  MULTI_PROJECT_ALPHA_SEQUENCE,
  MULTI_PROJECT_BETA_ROOT,
  MULTI_PROJECT_BETA_DOCUMENT_ID,
  MULTI_PROJECT_BETA_SEQUENCE,
} from '../test/scenarios/presets';
import REAL_PUC19_GB from '../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import ECOLI_MG1655_REGION_GB from '../../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb?raw';

vi.mock('../db/workspace-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/workspace-catalog')>();
  return {
    ...actual,
    registerCatalogEntity: vi.fn(),
    bindCatalogEntityToFile: vi.fn(),
  };
});

let DevPanel: typeof import('./DevPanel').DevPanel;
let canvasGetContextSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const originalWarn = console.warn;
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    if (String(args[0]).includes('[AI Settings] No dev env keys found')) return;
    originalWarn(...args);
  });
  canvasGetContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        fillRect: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
      }) as unknown as CanvasRenderingContext2D
  );
  ({ DevPanel } = await import('./DevPanel'));
});

afterAll(() => {
  canvasGetContextSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe('DevPanel real assembly pipeline presets', () => {
  afterEach(() => {
    cleanup();
    clearLastAppliedDevScenarioPreset();
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    useVerificationStore.setState({
      verificationState: {},
      staleReferences: {},
      staleSessionIds: {},
      referenceFileChecksums: {},
      sessionViewPreferences: {},
    });
    useChatStore.setState({
      messages: [],
      conversations: [],
      streamingBlocks: [],
      currentConversationId: null,
      isLoading: false,
      isStreaming: false,
      error: null,
    });
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
    useSequenceStore.setState({
      sequences: {},
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      dirtyPaths: {},
    });
  });

  it('exposes every real assembly pipeline scenario and applies one through the UI surface', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Real assembly pipeline')).toBeTruthy();
    for (const factoryName of Object.keys(realAssemblyPipelineDevScenarios)) {
      expect(screen.getByText(factoryName)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('devpanel-real-assembly-gibson-pcr-rd-pcr-two-spacers'));

    await waitFor(() => expect(useDesignStore.getState().activeDesignId).toBeTruthy());

    const designState = useDesignStore.getState();
    expect(designState.activeDesignId).toBeTruthy();
    const activeDesign = designState.designs[designState.activeDesignId!];
    expect(activeDesign.name).toBe('Real Gibson PCR/RD/PCR + two spacers');
    expect(activeDesign.regions.map((region) => region.sourceType ?? 'pcr')).toEqual([
      'pcr',
      'rd',
      'pcr',
    ]);
    expect((activeDesign.spacers ?? []).map((spacer) => spacer.sequence.length)).toEqual([5, 7]);
    expect(activeDesign.designPrimers.map((pair) => pair.fragmentIndex)).toEqual([0, 2]);
  });

  it('exposes and applies the stale alignment session preset', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Alignments')).toBeTruthy();
    fireEvent.click(screen.getByTestId('devpanel-alignment-stale-session'));

    await waitFor(() =>
      expect(
        useVerificationStore.getState().verificationState[ALIGNMENT_STALE_DOCUMENT_ID]?.sessions
      ).toHaveLength(1)
    );

    const state = useVerificationStore.getState();
    expect(state.verificationState[ALIGNMENT_STALE_DOCUMENT_ID]?.sessions).toHaveLength(1);
    expect(state.staleReferences[ALIGNMENT_STALE_DOCUMENT_ID]).toBe(true);
    expect(state.staleSessionIds[ALIGNMENT_STALE_DOCUMENT_ID]).toEqual(['alignment-stale-session']);
  });

  it('exposes and applies the agent trace CLI test kit through the AI Chat section', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('AI Chat')).toBeTruthy();
    fireEvent.click(screen.getByTestId('devpanel-agent-trace-cli'));

    await waitFor(() =>
      expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit')
    );

    expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/workspace/agent-trace-cli');
    expect(useWorkspaceStore.getState().selectedPath).toBe('/workspace/agent-trace-cli');
    expect(useChatStore.getState().messages[0]?.content).toContain(
      'Claude Native CLI or Codex Native CLI'
    );
  });

  it('exposes and applies the multi-project roots workflow preset', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Project Workflows')).toBeTruthy();
    fireEvent.click(screen.getByTestId('devpanel-multi-project-roots'));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual([
        MULTI_PROJECT_ALPHA_ROOT,
        MULTI_PROJECT_BETA_ROOT,
      ])
    );

    expect(useWorkspaceStore.getState().selectedPath).toBe(MULTI_PROJECT_ALPHA_SEQUENCE);
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);
    expect(tabs.map((tab) => tab.entityId)).toEqual(
      expect.arrayContaining([MULTI_PROJECT_ALPHA_DOCUMENT_ID, MULTI_PROJECT_BETA_DOCUMENT_ID])
    );
    expect(tabs.map((tab) => tab.label)).toEqual(
      expect.arrayContaining(['pUC19.gb', 'ecoli-mg1655-region.gb'])
    );
    expect(tabs.map((tab) => tab.label)).not.toContain('pUC19-alpha.gb');
    expect(tabs.map((tab) => tab.label)).not.toContain('gfp-beta.fasta');
    expect(useSequenceStore.getState().sequences[MULTI_PROJECT_ALPHA_DOCUMENT_ID].sequence).toBe(
      parseGenBankFull(REAL_PUC19_GB).sequence
    );
    expect(useSequenceStore.getState().sequences[MULTI_PROJECT_BETA_DOCUMENT_ID].sequence).toBe(
      parseGenBankFull(ECOLI_MG1655_REGION_GB).sequence
    );
    expect(useSequenceStore.getState().dirtyPaths).toEqual({});
    expect(useCanvasStore.getState().layout).toMatchObject({
      type: 'split',
      direction: 'vertical',
    });
  });

  it('exposes the LIMS primer CSV import scenario', () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('LIMS')).toBeTruthy();
    expect(screen.getByTestId('devpanel-lims-primer-csv-import')).toHaveTextContent(
      'limsPrimerCsvImportScenario'
    );
    expect(screen.getByTestId('devpanel-lims-primer-csv-import')).toHaveTextContent(
      'primers-alt-headers.csv'
    );
    expect(screen.getByTestId('devpanel-lims-headerless-primer-tsv-import')).toHaveTextContent(
      'limsHeaderlessPrimerTsvScenario'
    );
    expect(screen.getByTestId('devpanel-lims-headerless-primer-tsv-import')).toHaveTextContent(
      'primers.tsv'
    );
  });

  it('exposes and applies the file-authoritative primer proof workspace', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Primer workflows')).toBeTruthy();
    const preset = screen.getByTestId('devpanel-primer-file-authority');
    expect(preset).toHaveTextContent('primerFileAuthorityWorkspace');
    expect(preset).toHaveTextContent('fresh Git workspace');

    fireEvent.click(preset);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().folders[0]?.path).toBe(
        '/mock/test/workspace/primer-file-authority'
      )
    );
    expect(useWorkspaceStore.getState().selectedPath).toBe(
      '/mock/test/workspace/primer-file-authority/pUC19.gb'
    );
    expect(useCanvasStore.getState().panels.main.tabs[0]?.label).toBe('pUC19');
  });

  it('persists the last clicked preset and restores its active state on remount', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('devpanel-agent-trace-cli'));

    await waitFor(() => expect(getLastAppliedDevScenarioPresetId()).toBe('agent-trace-cli'));
    expect(screen.getByTestId('devpanel-agent-trace-cli')).toHaveAttribute('aria-pressed', 'true');

    cleanup();
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('devpanel-agent-trace-cli')).toHaveAttribute('aria-pressed', 'true');
  });
});
