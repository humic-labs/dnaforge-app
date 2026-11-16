import { useVerificationStore } from '../../features/alignment-manager/store';
import type { HostedAiBridge } from '../../shared/hosted-ai-bridge';
import { useCanvasStore } from '../../features/canvas/store';
import type { Tab } from '../../features/canvas/types';
import type { ScenarioFixtureFile } from '../../shared/internal-fixtures';
import { isMocloScenarioPresetId } from '../../shared/internal-fixtures';
import { useDesignStore } from '../../features/design/store';
import { normalizeAssemblySlots } from '../../features/design/assembly-slots';
import { useRichSequenceClipboardStore } from '../../features/sequence-clipboard/store';
import type { SequenceDesign } from '../../features/design/types';
import { useSequenceStore } from '../../features/sequence/store';
import { loadAnnotationCatalogs } from '../../features/sequence/annotation-catalog/annotation-catalog-registry';
import { useEmptySequenceEntryStore } from '../../features/sequence/empty-sequence-entry-store';
import { usePageStore } from '../../features/page/store';
import { useWorkspaceStore, workspaceScopeFromState } from '../../stores/workspaceStore';
import { useChatStore } from '../../features/ai/hooks/useChat';
import { createEmptyConversationState } from '../../features/ai/orchestration/chat-store-types';
import { useDestructiveConfirmStore } from '../../features/ai/agent-confirm/destructive-confirm-store';
import { useAgentUserInputStore } from '../../features/ai/agent-confirm/agent-user-input-store';
import { useImportWizardStore } from '../../features/import-wizard/import-wizard-store';
import { useAISettingsStore } from '../../features/ai/settings';
import {
  buildAssistantTurnRouteSnapshot,
  getActiveAssistantRoute,
} from '../../features/ai/assistant-routes';
import { workspaceRootPathForGitLocator } from '../../features/ai/references/inline/origin';
import { useAttachedReadsStore } from '../../features/sequence/tracks/attached-reads-store';
import { useLaneContractStore } from '../../features/sequence/lane-contract-store';
import { useAgentJobsStore } from '../../features/jobs/agent-jobs-store';
import type { ProviderName } from '../../features/ai/providers';
import { createEntityReference } from '../../db/entity-references';
import { createInlineReferenceSession } from '../../features/ai/references/inline/session';
import {
  replaceConversationState,
  setConversationState,
} from '../../features/ai/orchestration/chat-runtime';
import type { PlatformBridge } from '../../platform';
import type { QuickLookPackageReceipt } from '../../shared/file-association-ipc';
import { DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY } from '../../shared/indexed-genome';
import { isDesktopRuntime } from '../../utils/environment';
import { createRuntimeProfile, type RuntimeProfile } from '../../shared/runtime-profile';
import type { LimsImportPlan } from '../../shared/lims';
import type { DrawerType } from '../../features/sequence/hooks/useDrawerState';
import {
  clearRequestedSequenceDrawer,
  requestSequenceDrawer,
} from '../../features/sequence/hooks/request-sequence-drawer';
import { applyAlignmentScenario, resetAlignmentScenarioState } from './apply-alignment';
import {
  _setDevOverride,
  _clearDevOverride,
  _resetToolboxState,
} from '../../hooks/useToolboxStatus';
import { rebindRendererAgentBridgeForTrustedWorkspaceReplacement } from './renderer-agent-bridge-dev';
import {
  getDevScenarioPresetByAlias,
  getDevScenarioPresetById,
  type DevScenarioPreset,
} from './dev-presets';
import type { AppScenario } from './types';
import { settleMarkdownScenarioBaseline } from './settle-markdown-baseline';
import {
  OPEN_FILE_HANDLING_SETTINGS_EVENT,
  setFileAssociationHandlerDevOverride,
} from '../../features/file-associations/handler-status-source';
import { setUsageAnalyticsDevOverride } from '../../lib/usage-analytics-setting-source';
import { openSettingsEntry } from '../../features/auth/cloud-surface-store';

type BrowserMockUtils = {
  setMockFileContent?: (path: string, content: string | Uint8Array) => void;
  setFileTree?: (
    path: string,
    entries: Array<{ name: string; isDirectory: boolean; content?: string | Uint8Array }>
  ) => void;
};

const BROWSER_MOCK_WORKSPACE_ROOT = '/mock/test/workspace';
const ELECTRON_SCENARIO_ROOT_NAME = 'dev-scenarios';
const BLOCKED_SCENARIO_MUTATION_MESSAGE =
  'Dev scenario mutation is blocked in this Electron profile.';
export const LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY = 'waypoint:last-applied-dev-scenario';
const LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION = 1;
let activeDevScenarioPresetId: string | null = null;

interface LastAppliedDevScenarioRecord {
  version: typeof LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION;
  presetId: string;
  appliedAt: number;
}

export type DevScenarioReplayResult =
  | { status: 'empty' }
  | { status: 'missing'; presetId: string }
  | { status: 'skipped-no-auto-replay'; presetId: string }
  | { status: 'applied'; presetId: string; label: string };

type ScenarioRuntimeWindow = Window & {
  electronAPI?: {
    runtime?: {
      getProfile?: () => RuntimeProfile;
    };
  };
};

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseLastAppliedDevScenarioRecord(
  raw: string | null
): LastAppliedDevScenarioRecord | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<LastAppliedDevScenarioRecord>;
    if (parsed.version === LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION) {
      const appliedAt = parsed.appliedAt;
      if (
        typeof parsed.presetId === 'string' &&
        typeof appliedAt === 'number' &&
        Number.isFinite(appliedAt)
      ) {
        return {
          version: LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION,
          presetId: parsed.presetId,
          appliedAt,
        };
      }
    }
  } catch {
    if (raw.trim()) {
      return {
        version: LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION,
        presetId: raw,
        appliedAt: 0,
      };
    }
  }

  return null;
}

function resolveDevScenarioPreset(presetId: string): DevScenarioPreset | null {
  return getDevScenarioPresetById(presetId) ?? getDevScenarioPresetByAlias(presetId);
}

export function recordLastAppliedDevScenarioPreset(presetId: string): void {
  const preset = resolveDevScenarioPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown dev scenario preset: ${presetId}`);
  }

  const storage = getBrowserStorage();
  if (!storage) return;

  const record: LastAppliedDevScenarioRecord = {
    version: LAST_APPLIED_DEV_SCENARIO_STORAGE_VERSION,
    presetId: preset.id,
    appliedAt: Date.now(),
  };

  storage.setItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY, JSON.stringify(record));
}

export function getLastAppliedDevScenarioPresetId(): string | null {
  const storage = getBrowserStorage();
  const record = parseLastAppliedDevScenarioRecord(
    storage?.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY) ?? null
  );
  if (!record) return null;

  return resolveDevScenarioPreset(record.presetId)?.id ?? null;
}

export function getActiveDevScenarioPresetId(): string | null {
  return activeDevScenarioPresetId;
}

export function clearLastAppliedDevScenarioPreset(): void {
  getBrowserStorage()?.removeItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY);
}

async function openPresetReferenceAssemblyIfAny(
  preset: DevScenarioPreset
): Promise<{ panelId: string; tabId: string } | null> {
  const strategies = [
    preset.referenceAssemblyId,
    preset.indexedReference,
    preset.hostedReferenceCatalogId,
  ].filter((value) => value != null);
  if (strategies.length > 1) {
    throw new Error(`Dev preset ${preset.id} declares two reference-opening strategies.`);
  }
  if (preset.hostedReferenceMode && !preset.hostedReferenceCatalogId) {
    throw new Error(`Dev preset ${preset.id} declares a hosted mode without a hosted reference.`);
  }
  if (strategies.length === 0) return null;

  const active = activeIndexedAssembly();

  if (preset.hostedReferenceCatalogId) {
    if (active?.assemblyId === preset.hostedReferenceCatalogId) return active;
    if (preset.hostedReferenceMode === 'metadata-shell') {
      if (!preset.hostedReferenceShell) {
        throw new Error(`Dev preset ${preset.id} has no hosted reference shell definition.`);
      }
      if (preset.hostedReferenceShell.id !== preset.hostedReferenceCatalogId) {
        throw new Error(`Dev preset ${preset.id} has a mismatched hosted reference shell.`);
      }
      return openHostedReferenceMetadataShell(preset.hostedReferenceShell);
    }
    const { openAssembly } = await import('../../features/sequence/openAssembly');
    const [{ platform }, { INDEXED_ANNOTATION_COLOR_BASIS_THEME }] = await Promise.all([
      import('../../platform'),
      import('@waypoint/genome-renderer/pure'),
    ]);
    const installed = await platform().referenceAssets.installHosted({
      catalogId: preset.hostedReferenceCatalogId,
      themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
      intent: 'open-view',
    });
    const tabId = await openAssembly(installed.entry, {
      annotationThemeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
    });
    if (!tabId) {
      throw new Error(
        `Dev preset ${preset.id} could not open hosted reference assembly: ${preset.hostedReferenceCatalogId}`
      );
    }
    return findOpenTab(tabId);
  }

  const [
    { openAssembly },
    { referenceAssemblyById },
    { referenceAssemblyEntryForTest },
    { platform },
  ] = await Promise.all([
    import('../../features/sequence/openAssembly'),
    import('../../features/sequence/reference-catalog'),
    import('../reference-assembly-entry'),
    import('../../platform'),
  ]);

  if (preset.indexedReference) {
    const expected = preset.indexedReference;
    const localEntry = (
      await platform()
        .referenceAssets.listLocal()
        .catch(() => [])
    ).find((candidate) => candidate.assembly === expected.preferredLocalAssemblyAccession);
    const assertIndexedReferenceIdentity = (candidate: NonNullable<typeof localEntry>): void => {
      const totalLengthBp = candidate.members.reduce(
        (total, member) => total + (member.lengthBp ?? 0),
        0
      );
      if (
        candidate.assembly !== expected.preferredLocalAssemblyAccession ||
        totalLengthBp !== expected.expectedLengthBp
      ) {
        throw new Error(
          `Dev preset ${preset.id} resolved the wrong assembly: expected ` +
            `${expected.preferredLocalAssemblyAccession} (${expected.expectedLengthBp} bp), got ` +
            `${candidate.assembly ?? 'unknown'} (${totalLengthBp} bp)`
        );
      }
    };

    let entry = localEntry;
    if (localEntry) {
      assertIndexedReferenceIdentity(localEntry);
      entry = (
        await platform().referenceAssets.retryLocal({
          operationId: `dev-scenario-${preset.id}-${crypto.randomUUID()}`,
          assemblyId: localEntry.id,
          themeMode: 'light',
        })
      ).entry;
    }
    if (!entry) {
      const hosted = (await platform().referenceAssets.listHosted()).find(
        (candidate) => candidate.id === expected.hostedCatalogId
      );
      if (!hosted) {
        throw new Error(
          `Dev preset ${preset.id} references unknown hosted assembly: ${expected.hostedCatalogId}`
        );
      }
      entry = (
        await platform().referenceAssets.installHosted({
          catalogId: expected.hostedCatalogId,
          themeMode: 'light',
          intent: 'open-view',
        })
      ).entry;
    }
    assertIndexedReferenceIdentity(entry);
    const tabId = await openAssembly(entry);
    if (!tabId) {
      throw new Error(
        `Dev preset ${preset.id} could not open prepared reference assembly: ${entry.id}`
      );
    }
    return findOpenTab(tabId);
  }

  const referenceAssemblyId = preset.referenceAssemblyId;
  if (!referenceAssemblyId) return null;
  if (active?.assemblyId === referenceAssemblyId) return active;

  const localEntry = (
    await platform()
      .referenceAssets.listLocal()
      .catch(() => [])
  ).find((candidate) => candidate.id === referenceAssemblyId);
  const catalogEntry = referenceAssemblyById(referenceAssemblyId);
  if (!localEntry && !catalogEntry) {
    throw new Error(
      `Dev preset ${preset.id} references unknown assembly: ${preset.referenceAssemblyId}`
    );
  }
  const entry = localEntry ?? (await referenceAssemblyEntryForTest(catalogEntry!));
  const tabId = await openAssembly(entry);
  if (!tabId) {
    throw new Error(
      `Dev preset ${preset.id} could not open prepared reference assembly: ${entry.id}`
    );
  }
  return findOpenTab(tabId);
}

function activeIndexedAssembly(): { assemblyId: string; panelId: string; tabId: string } | null {
  const state = useCanvasStore.getState();
  const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : undefined;
  const tab = panel?.tabs.find((candidate) => candidate.id === panel.activeTabId);
  const assemblyId = tab?.indexedGenome?.assembly?.assemblyId;
  return assemblyId && panel && tab ? { assemblyId, panelId: panel.id, tabId: tab.id } : null;
}

function findOpenTab(tabId: string): { panelId: string; tabId: string } | null {
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) return { panelId: panel.id, tabId };
  }
  return null;
}

async function openHostedReferenceMetadataShell(
  definition: NonNullable<DevScenarioPreset['hostedReferenceShell']>
): Promise<{ panelId: string; tabId: string }> {
  const { platform } = await import('../../platform');
  const catalogId = definition.id;
  const appDataRoot = (await platform().path.appDataDir()).replace(/\/+$/, '');
  const shellRoot = `${appDataRoot}/dev-scenarios/reference-shells/${catalogId}`;
  const chromosomes = definition.contigs.map((contig) => {
    const manifest = {
      chrom: contig.chrom,
      fastaPath: `${shellRoot}/${contig.chrom}.fa`,
      faiPath: `${shellRoot}/${contig.chrom}.fa.fai`,
      gffPath: null,
      tbiPath: null,
      length: contig.lengthBp,
      circular: contig.circular,
    };
    return {
      chrom: contig.chrom,
      displayName: contig.displayName,
      length: contig.lengthBp,
      manifest,
      role: contig.circular ? ('mitochondrion' as const) : ('assembled-molecule' as const),
      aliases: { ucsc: contig.chrom },
      circular: contig.circular,
    };
  });
  const anchor = chromosomes[0];
  if (!anchor) throw new Error(`Hosted assembly ${catalogId} has no chromosomes.`);
  const state = useCanvasStore.getState();
  const panelId =
    (state.focusedPanelId && state.panels[state.focusedPanelId]
      ? state.focusedPanelId
      : Object.keys(state.panels)[0]) ?? 'main';
  const documentId = `dev-scenario:reference-shell:${catalogId}`;
  const tabId = state.openTab(panelId, {
    type: 'sequence',
    entityId: documentId,
    label: definition.name,
    loadStatus: 'indexed-pending',
    initialAnnotationMapperPolicy: { ...DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY },
    sequenceDocument: { kind: 'indexed-sequence', documentId },
    indexedGenome: {
      sourcePath: anchor.manifest.fastaPath,
      workspaceRoot: shellRoot,
      sourceExt: '.fa',
      chrom: anchor.chrom,
      manifest: anchor.manifest,
      metadata: {
        length: anchor.length,
        circular: false,
        featureCount: 0,
        annotationTypes: [],
      },
      assembly: {
        assemblyId: definition.id,
        displayName: definition.name,
        organism: definition.organism,
        taxId: definition.taxId,
        assembly: definition.assembly,
        chromosomes,
      },
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'not-applicable',
      assemblySearchReadiness: 'not-applicable',
      assemblyAnnotationTrackTypes: [...(definition.annotationTrackTypes ?? ['mRNA'])],
      scope: { kind: 'all' },
      bamTracks: [],
      dataTracks: [],
    },
  });
  return { panelId, tabId };
}

export async function applyDevScenarioPreset(presetId: string): Promise<void> {
  const preset = resolveDevScenarioPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown dev scenario preset: ${presetId}`);
  }

  await applyResolvedDevScenarioPreset(preset);
}

export async function replayLastAppliedDevScenario(): Promise<DevScenarioReplayResult> {
  const storage = getBrowserStorage();
  const record = parseLastAppliedDevScenarioRecord(
    storage?.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY) ?? null
  );
  if (!record) return { status: 'empty' };

  const preset = resolveDevScenarioPreset(record.presetId);
  if (!preset) {
    clearLastAppliedDevScenarioPreset();
    return { status: 'missing', presetId: record.presetId };
  }

  if (preset.noAutoReplay) {
    clearLastAppliedDevScenarioPreset();
    return { status: 'skipped-no-auto-replay', presetId: preset.id };
  }

  await applyResolvedDevScenarioPreset(preset, { reuseMaterializedProjects: true });
  return { status: 'applied', presetId: preset.id, label: preset.label };
}

async function applyResolvedDevScenarioPreset(
  preset: DevScenarioPreset,
  options: Pick<ApplyScenarioDevOptions, 'reuseMaterializedProjects'> = {}
): Promise<void> {
  activeDevScenarioPresetId = null;
  clearLastAppliedDevScenarioPreset();
  if (preset.projectLibrary) {
    await seedPresetProjectLibrary(preset.projectLibrary);
    activeDevScenarioPresetId = preset.id;
    return;
  }
  try {
    if (preset.loadsAnnotationCatalogs) await loadAnnotationCatalogs();
    const scenario = preset.factory();
    const openReferenceAfterScenario = preset.hostedReferenceMode === 'metadata-shell';
    let openedReference = openReferenceAfterScenario
      ? null
      : await openPresetReferenceAssemblyIfAny(preset);
    const replacesWorkspace =
      !isIndexedGenomeDeltaScenario(scenario) && !isLimsOnlyScenario(scenario);
    const deferInlineReferenceText =
      replacesWorkspace &&
      isDesktopRuntime() &&
      Boolean(scenario.chat?.streamedInlineReferenceText);
    await Promise.resolve(
      applyScenarioDev(scenario, {
        deferStreamedInlineReferenceText: deferInlineReferenceText,
        reuseMaterializedProjects: options.reuseMaterializedProjects,
      })
    );
    if (openReferenceAfterScenario) {
      openedReference = await openPresetReferenceAssemblyIfAny(preset);
    }
    await applyPresetUcscCatalogTracksIfAny(preset);
    const composedTabId = await applyPresetTrackViewCompositionIfAny(preset);
    if (
      preset.closeReferenceAfterTrackViewComposition &&
      openedReference &&
      composedTabId &&
      openedReference.tabId !== composedTabId
    ) {
      useCanvasStore.getState().closeTab(openedReference.panelId, openedReference.tabId);
    }
    if (replacesWorkspace) {
      await rebindScenarioWorkspaceAfterRendererSettles();
      if (deferInlineReferenceText) {
        await applyStreamedInlineReferenceText(scenario);
      }
    }
    activeDevScenarioPresetId = preset.id;
    if (!preset.noAutoReplay) {
      recordLastAppliedDevScenarioPreset(preset.id);
    }
  } catch (error) {
    activeDevScenarioPresetId = null;
    clearLastAppliedDevScenarioPreset();
    throw error;
  }
}

async function applyPresetUcscCatalogTracksIfAny(preset: DevScenarioPreset): Promise<void> {
  const requested = preset.ucscCatalogTracks;
  if (!requested || requested.length === 0) return;

  const [{ findOpenIndexedTab }, { searchUcscTracks }, admission, dataset, identity, genomeData] =
    await Promise.all([
      import('../../features/ai/tools/indexed-current-view'),
      import('../../features/sequence/ucsc-track-client'),
      import('../../features/sequence/ucsc-track-admission'),
      import('../../features/sequence/admitted-track-dataset'),
      import('../../features/sequence/attach-indexed-bigwig'),
      import('@waypoint/genome-data'),
    ]);

  const found = findOpenIndexedTab(useCanvasStore.getState());
  if (!found) {
    throw new Error(`Dev preset ${preset.id} needs an open indexed genome to attach tracks to.`);
  }
  const genome = found.tab.indexedGenome;
  const assemblyId = identity.assemblyIdFromIndexedGenome(genome);
  const assemblyReferences = identity.assemblyReferencesFromIndexedGenome(genome);
  if (assemblyReferences.length === 0) {
    throw new Error(`Dev preset ${preset.id} opened a genome with no chromosome identity.`);
  }

  for (const wanted of requested) {
    const ucscTarget = {
      genomeId: wanted.genome,
      ...(wanted.hubUrl ? { hubUrl: wanted.hubUrl } : {}),
    };
    const matches = await searchUcscTracks({
      genome: wanted.genome,
      query: wanted.track,
      ...(wanted.hubUrl ? { hubUrl: wanted.hubUrl } : {}),
    });
    const track = matches.find((candidate) => candidate.track === wanted.track);
    if (!track) {
      throw new Error(
        `Dev preset ${preset.id} found no UCSC track ${wanted.track} in ${wanted.genome}.`
      );
    }
    const trackId = genomeData.createUcscTrackId({
      sourceKind: track.sourceKind,
      ucscGenome: wanted.genome,
      track: track.track,
      ...(wanted.hubUrl ? { hubUrl: wanted.hubUrl } : {}),
    });
    const source = await admission.admitUcscCatalogTrackSource({
      assemblyId,
      assemblyReferences,
      ucscTarget,
      track,
    });
    useLaneContractStore
      .getState()
      .addLane(
        found.tab.id,
        assemblyId,
        dataset.datasetForAdmittedTrack({ trackId, label: track.shortLabel, source }),
        true,
        source
      );
  }
}

async function seedPresetProjectLibrary(
  library: NonNullable<DevScenarioPreset['projectLibrary']>
): Promise<void> {
  assertScenarioMutationAllowed('seedPresetProjectLibrary');
  const [{ createTrackedEmptyWorkspace }, { archiveWorkspaceByPath, trashWorkspaceByPath }] =
    await Promise.all([
      import('../../features/workspace-loader/workspace-created-telemetry'),
      import('../../features/workspace-loader/workspace-library'),
    ]);
  const create = async (name: string) => (await createTrackedEmptyWorkspace({ name })).rootPath;
  for (const name of library.closed ?? []) await create(name);
  for (const name of library.archived ?? []) await archiveWorkspaceByPath(await create(name));
  for (const name of library.trashed ?? []) await trashWorkspaceByPath(await create(name));
}

async function applyPresetTrackViewCompositionIfAny(
  preset: DevScenarioPreset
): Promise<string | null> {
  if (!preset.trackViewComposition) return null;
  const { composeIndexedTrackView } =
    await import('../../features/ai/tools/compose-indexed-track-view');
  let dependencies: Parameters<typeof composeIndexedTrackView>[1] | undefined;
  if (preset.trackViewLocalSources) {
    const [{ platform }, { admitIndexedBigWigRequest }] = await Promise.all([
      import('../../platform'),
      import('../../features/sequence/public/indexed-track-admission'),
    ]);
    const projectRoot = await platform().path.projectRoot();
    if (!projectRoot) {
      throw new Error(`Dev preset ${preset.id} cannot resolve its checked-in track fixtures.`);
    }
    const localSources = preset.trackViewLocalSources;
    dependencies = {
      admit: async (input) => {
        if (input.request.source.kind !== 'http') {
          throw new Error(`Dev preset ${preset.id} expected a URL-backed showcase track.`);
        }
        const localSource = localSources[input.request.source.url];
        if (!localSource) {
          throw new Error(
            `Dev preset ${preset.id} has no local source for ${input.request.source.url}.`
          );
        }
        const path = resolveProjectFixturePath(projectRoot, localSource.relativePath);
        const stat = await platform().fs.stat(path);
        if (!stat.isFile || stat.size !== localSource.sizeBytes) {
          throw new Error(
            `Dev preset ${preset.id} requires the complete ${localSource.sizeBytes}-byte ` +
              `BigWig at ${localSource.relativePath}; found ${stat.size} bytes.`
          );
        }
        const retained = await platform().internalFixtures.retainTrack({
          relativePath: localSource.relativePath,
        });
        return admitIndexedBigWigRequest({
          request: {
            ...input.request,
            source: {
              kind: 'local-file',
              path: retained.path,
            },
          },
          assemblyReferences: input.assemblyReferences,
          signal: input.signal,
        });
      },
    };
  }
  const result = await composeIndexedTrackView(preset.trackViewComposition, dependencies);
  if (!result.ok) {
    throw new Error(`Dev preset ${preset.id} could not compose its Track View: ${result.error}`);
  }
  if (preset.saveComposedTrackViewAs) {
    await persistComposedTrackViewAsSaved(preset, result.tabId);
  }
  return result.tabId;
}

async function persistComposedTrackViewAsSaved(
  preset: DevScenarioPreset,
  tabId: string
): Promise<void> {
  const identity = preset.saveComposedTrackViewAs;
  const composition = preset.trackViewComposition;
  if (!identity || !composition?.viewport) {
    throw new Error(`Dev preset ${preset.id} cannot save a Track View without a fixed viewport.`);
  }
  let found:
    | {
        panelId: string;
        tab: Tab;
      }
    | undefined;
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      found = { panelId, tab };
      break;
    }
  }
  const indexedGenome = found?.tab.indexedGenome;
  const assembly = indexedGenome?.assembly;
  if (!found || !indexedGenome || !assembly) {
    throw new Error(`Dev preset ${preset.id} did not create an indexed Track View to save.`);
  }

  const [
    { trackViewReference },
    { indexedGenomeDataTrackFromLane },
    { saveTrackView },
    { deriveAnnotationTrackRegistry },
  ] = await Promise.all([
    import('../../features/sequence/open-track-view'),
    import('../../features/sequence/ucsc-track-persistence'),
    import('../../features/sequence/track-view-library'),
    import('../../features/sequence/annotation-track-registry'),
  ]);
  const dataTracks = useLaneContractStore
    .getState()
    .lanesForOwner(tabId)
    .flatMap((lane) => {
      const track = indexedGenomeDataTrackFromLane(lane);
      return track ? [track] : [];
    });
  const globalViewport = assemblyGlobalViewport(
    assembly.chromosomes,
    composition.viewport.chrom,
    composition.viewport.start0,
    composition.viewport.end0
  );
  const orderedAnnotationTrackIds = deriveAnnotationTrackRegistry(
    indexedGenome.assemblyAnnotationTrackTypes ?? []
  ).map((track) => track.trackId);
  const annotationPolicy = found.tab.initialAnnotationMapperPolicy ?? {
    ...DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY,
  };
  const document = {
    schema: 'dnaforge.track-view.v2' as const,
    kind: 'track-view' as const,
    id: identity.id,
    name: composition.name,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
    reference: trackViewReference(indexedGenome),
    viewport: globalViewport,
    scope: {
      kind: 'locus' as const,
      chrom: composition.viewport.chrom,
      start: composition.viewport.start0,
      end: composition.viewport.end0,
    },
    annotation: {
      policy: { ...annotationPolicy },
      orderedTrackIds: orderedAnnotationTrackIds,
      visibilityByTrackId: Object.fromEntries(
        orderedAnnotationTrackIds.map((trackId) => [
          trackId,
          indexedGenome.assemblyAnnotationProductsReadiness !== 'not-applicable',
        ])
      ),
    },
    dataTracks,
    bamTracks: indexedGenome.bamTracks ?? [],
    ...(indexedGenome.variantSource ? { variantSource: indexedGenome.variantSource } : {}),
  };
  const { platform } = await import('../../platform');
  const existing = (await platform().trackViews.list()).views.find(
    (candidate) => candidate.document.id === identity.id
  );
  const { saved } = await saveTrackView({
    document,
    expectedRevision: existing?.revision ?? null,
  });
  useCanvasStore.getState().retargetTab(
    found.panelId,
    tabId,
    {
      type: 'sequence',
      sequenceDocument: { kind: 'indexed-sequence', documentId: saved.document.id },
    },
    {
      label: saved.document.name,
      trackView: saved,
      isDirty: false,
      initialAnnotationMapperPolicy: { ...saved.document.annotation.policy },
      indexedGenome: {
        ...indexedGenome,
        scope: { ...saved.document.scope },
        dataTracks: saved.document.dataTracks.map((track) => ({ ...track })),
        bamTracks: saved.document.bamTracks.map((track) => ({ ...track })),
        variantSource: saved.document.variantSource,
      },
      viewState: {
        ...found.tab.viewState,
        indexedViewport: { ...saved.document.viewport },
        indexedViewportCommand: null,
        indexedGenomeViewRestoreCommand: {
          id: crypto.randomUUID(),
          viewport: { kind: 'assembly-range', ...saved.document.viewport },
          annotationPolicy: { ...saved.document.annotation.policy },
          orderedAnnotationTrackIds: [...saved.document.annotation.orderedTrackIds],
          visibleAnnotationTrackIds: Object.entries(saved.document.annotation.visibilityByTrackId)
            .filter(([, visible]) => visible)
            .map(([trackId]) => trackId),
        },
      },
    }
  );
}

function assemblyGlobalViewport(
  chromosomes: ReadonlyArray<Readonly<{ chrom: string; length: number }>>,
  chrom: string,
  start0: number,
  end0: number
): { start0: number; end0: number } {
  let offset = 0;
  for (const chromosome of chromosomes) {
    if (chromosome.chrom === chrom) {
      if (end0 > chromosome.length) {
        throw new Error(`Saved Track View viewport is outside ${chrom}.`);
      }
      return { start0: offset + start0, end0: offset + end0 };
    }
    offset += chromosome.length;
  }
  throw new Error(`Saved Track View viewport names unknown chromosome ${chrom}.`);
}

function resolveProjectFixturePath(projectRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Dev track fixture path must be a safe project-relative path: ${relativePath}`);
  }
  return `${projectRoot.replace(/[\\/]+$/, '')}/${normalized}`;
}

export async function rebindScenarioWorkspaceAfterRendererSettles(): Promise<void> {
  if (!isDesktopRuntime()) return;
  assertScenarioMutationAllowed('rebindScenarioWorkspaceAfterRendererSettles');

  let previousScope: string | null | undefined;
  let stableFrames = 0;
  for (let frame = 0; frame < 12 && stableFrames < 2; frame += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const currentScope = workspaceScopeFromState(useWorkspaceStore.getState());
    if (currentScope === previousScope) stableFrames += 1;
    else {
      previousScope = currentScope;
      stableFrames = 0;
    }
  }

  if (stableFrames < 2) {
    throw new Error('DevPanel workspace scope did not settle before MCP bridge rebinding.');
  }

  if (!(await rebindRendererAgentBridgeForTrustedWorkspaceReplacement())) {
    throw new Error('Renderer agent bridge is unavailable after applying the DevPanel scenario.');
  }
}

interface ApplyScenarioDevOptions {
  deferStreamedInlineReferenceText?: boolean;
  reuseMaterializedProjects?: boolean;
}

export function applyScenarioDev(
  scenario: AppScenario,
  options: ApplyScenarioDevOptions = {}
): void | Promise<void> {
  cancelSequenceDrawerToolbarRetry();

  if (isIndexedGenomeDeltaScenario(scenario)) {
    return applyMaterializedScenario(scenario);
  }

  if (isLimsOnlyScenario(scenario)) {
    return applyLimsScenario(scenario.lims);
  }

  assertScenarioMutationAllowed('applyScenarioDev');

  if (shouldMaterializeScenarioFilesForRuntime(scenario)) {
    return materializeScenarioFilesForRuntime(
      scenario,
      (runtimeScenario, beforeHydrate) =>
        applyMaterializedScenario(runtimeScenario, options, beforeHydrate),
      options.reuseMaterializedProjects === true
    );
  }

  return applyMaterializedScenario(scenario, options);
}

function isLimsOnlyScenario(
  scenario: AppScenario
): scenario is AppScenario & { lims: NonNullable<AppScenario['lims']> } {
  return (
    Boolean(scenario.lims) &&
    !scenario.sidecar &&
    !scenario.canvas &&
    !scenario.sequences &&
    !scenario.designs &&
    !scenario.files &&
    !scenario.assets?.length &&
    !scenario.workspace &&
    !scenario.alignment &&
    !scenario.multiLane &&
    !scenario.chat &&
    !scenario.variantSource
  );
}

function applyScenarioDesigns(designs: AppScenario['designs']): void {
  if (!designs) return;
  useDesignStore.setState({
    designs: normalizeScenarioDesigns(designs.designs),
    activeDesignId: designs.activeDesignId ?? null,
    pendingDispatchId: designs.pendingDispatchId ?? null,
  });
  const clipboard = useRichSequenceClipboardStore.getState();
  if (designs.lastCopied) clipboard.setCopiedRegion(designs.lastCopied);
  else clipboard.clear();
}

function applyScenarioPages(pagesScenario: AppScenario['pages']): void {
  if (!pagesScenario) return;
  const timestamp = new Date('2026-08-19T12:00:00.000Z');
  const pages = Object.fromEntries(
    pagesScenario.pages.map((page) => [
      page.id,
      {
        ...page,
        date: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
  );
  usePageStore.setState({
    pages,
    pageList: Object.values(pages).map(({ id, title, date, createdAt, updatedAt }) => ({
      id,
      title,
      date,
      createdAt,
      updatedAt,
    })),
    loadingIds: new Set(),
    dirtyIds: new Set(),
    listLoaded: true,
    isListLoading: false,
    listError: null,
    initialized: true,
  });
}

function applyScenarioRuntimeOverrides(runtimeScenario: AppScenario): void {
  setFileAssociationHandlerDevOverride(runtimeScenario.fileAssociations?.handlerStatuses ?? null);
  if (runtimeScenario.fileAssociations?.openSettings) {
    window.dispatchEvent(new Event(OPEN_FILE_HANDLING_SETTINGS_EVENT));
  }
  setUsageAnalyticsDevOverride(runtimeScenario.usageAnalytics ?? null);
  if (runtimeScenario.usageAnalytics) {
    openSettingsEntry('usage-analytics');
  }
  if (runtimeScenario.emptySequenceEntryCue) {
    useEmptySequenceEntryStore.getState().setCue(runtimeScenario.emptySequenceEntryCue);
  }
  if (runtimeScenario.sidecar) {
    _setDevOverride(runtimeScenario.sidecar);
  }
}

function applyScenarioAgentJobs(agentJobs: AppScenario['agentJobs']): void {
  if (!agentJobs) return;
  const activeCount = agentJobs.jobs.filter(
    (job) => job.state === 'queued' || job.state === 'running'
  ).length;
  useAgentJobsStore.setState({
    jobs: agentJobs.jobs,
    jobCount: agentJobs.jobCount ?? agentJobs.jobs.length,
    activeCount: agentJobs.activeCount ?? activeCount,
    terminalCount: agentJobs.terminalCount ?? agentJobs.jobs.length - activeCount,
    historyComplete: agentJobs.historyComplete ?? true,
    loading: false,
    error: agentJobs.error ?? null,
    observedAtMs: agentJobs.observedAtMs,
  });
}

function applyScenarioCanvasLayout(canvas: NonNullable<AppScenario['canvas']>): void {
  const tabs = canvas.tabs.map((t) => ({
    ...t,
    id: crypto.randomUUID(),
  }));
  const activeTabId = tabs[canvas.activeTabIndex ?? 0]?.id ?? null;
  if (canvas.layout === 'three-column' && tabs.length >= 3) {
    const panelIds = ['chat', 'paper', 'protocol'];
    useCanvasStore.setState({
      panels: Object.fromEntries(
        panelIds.map((panelId, index) => [
          panelId,
          {
            id: panelId,
            tabs: index === 2 ? tabs.slice(2) : [tabs[index]],
            activeTabId: tabs[index]?.id ?? null,
          },
        ])
      ),
      layout: {
        type: 'split',
        direction: 'vertical',
        children: panelIds.map((panelId) => ({ type: 'panel' as const, panelId })),
        sizes: [32, 34, 34],
      },
      focusedPanelId: panelIds[0],
    });
    return;
  }
  if (canvas.layout === 'split-vertical' && tabs.length >= 2) {
    const leftPanelId = 'left';
    const rightPanelId = 'right';
    useCanvasStore.setState({
      panels: {
        [leftPanelId]: {
          id: leftPanelId,
          tabs: [tabs[0]],
          activeTabId: tabs[0]!.id,
        },
        [rightPanelId]: {
          id: rightPanelId,
          tabs: tabs.slice(1),
          activeTabId: tabs[1]?.id ?? null,
        },
      },
      layout: {
        type: 'split',
        direction: 'vertical',
        children: [
          { type: 'panel', panelId: leftPanelId },
          { type: 'panel', panelId: rightPanelId },
        ],
        sizes: [50, 50],
      },
      focusedPanelId: (canvas.activeTabIndex ?? 0) === 0 ? leftPanelId : rightPanelId,
    });
    return;
  }
  if (canvas.layout === 'split-horizontal' && tabs.length >= 2) {
    const topPanelId = 'top';
    const bottomPanelId = 'bottom';
    useCanvasStore.setState({
      panels: {
        [topPanelId]: {
          id: topPanelId,
          tabs: [tabs[0]],
          activeTabId: tabs[0]!.id,
        },
        [bottomPanelId]: {
          id: bottomPanelId,
          tabs: tabs.slice(1),
          activeTabId: tabs[1]?.id ?? null,
        },
      },
      layout: {
        type: 'split',
        direction: 'horizontal',
        children: [
          { type: 'panel', panelId: topPanelId },
          { type: 'panel', panelId: bottomPanelId },
        ],
        sizes: [50, 50],
      },
      focusedPanelId: (canvas.activeTabIndex ?? 0) === 0 ? topPanelId : bottomPanelId,
    });
    return;
  }
  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs, activeTabId },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
}

async function applyIndexedGenomeDeltaScenario(runtimeScenario: AppScenario): Promise<boolean> {
  if (!isIndexedGenomeDeltaScenario(runtimeScenario)) return false;
  if (runtimeScenario.laneContract !== undefined) {
    applyLaneContractDirective(runtimeScenario.laneContract);
  }
  if (runtimeScenario.variantSource) {
    await applyVariantSourceDirective(runtimeScenario.variantSource);
  }
  return true;
}

function applyScenarioChatHostedRouteReadiness(
  hostedRouteReadiness: NonNullable<AppScenario['chat']>['hostedRouteReadiness']
): void {
  if (hostedRouteReadiness === undefined) return;
  if (!isDesktopRuntime() && typeof window !== 'undefined') {
    const gatewayOrigin = 'https://hosted-readiness-fixture.invalid';
    const host: {
      electronAPI?: {
        hostedAi?: Partial<Pick<HostedAiBridge, 'getRouteAvailability'>>;
      };
    } = window;
    host.electronAPI ??= {};
    host.electronAPI.hostedAi = {
      ...host.electronAPI.hostedAi,
      getRouteAvailability: async () =>
        hostedRouteReadiness === 'ready'
          ? { ok: true, available: true, gatewayOrigin }
          : hostedRouteReadiness === 'needs-login'
            ? {
                ok: false,
                code: 'signed_out',
                message: 'Sign in to use DNAForge AI.',
                gatewayOrigin,
              }
            : {
                ok: false,
                code: 'gateway_unavailable',
                message: 'DNAForge AI is temporarily unavailable.',
                gatewayOrigin,
              },
    };
  }
  useAISettingsStore.setState({ hostedRouteReadiness });
}

function applyScenarioChatProvider(chat: NonNullable<AppScenario['chat']>): void {
  if (!(chat.provider || chat.model)) return;
  const currentSettings = useAISettingsStore.getState();
  const provider = (chat.provider as ProviderName | undefined) ?? currentSettings.provider;
  const model = chat.model ?? currentSettings.model;
  const providerStatus = currentSettings.providerStatuses[provider];
  useAISettingsStore.setState({
    provider,
    model,
    assistantRoute: { kind: 'provider', provider, model },
    agentTransport: null,
    isConfigured: providerStatus?.isConfigured ?? currentSettings.isConfigured,
    keyringError: null,
  });
}

function applyScenarioChatConversation(chat: NonNullable<AppScenario['chat']>): void {
  if (
    !(chat.messages?.length || chat.queuedMessages?.length || chat.isLoading || chat.isStreaming)
  ) {
    return;
  }
  const convId = chat.conversationId ?? crypto.randomUUID();
  const scenarioQueuedMessages = chat.queuedMessages ?? [];
  const queuedRouteSelection =
    scenarioQueuedMessages.length > 0
      ? getActiveAssistantRoute(useAISettingsStore.getState())
      : null;
  if (scenarioQueuedMessages.length > 0 && !queuedRouteSelection) {
    throw new Error('Queued-message scenarios require an executable assistant route.');
  }
  const queuedRouteSnapshot = queuedRouteSelection
    ? buildAssistantTurnRouteSnapshot(queuedRouteSelection)
    : null;
  const conversationState = {
    ...createEmptyConversationState(),
    messages: chat.messages ?? [],
    queuedMessages: scenarioQueuedMessages.map((message) => ({
      ...message,
      workspacePath: message.workspacePath ?? null,
      referenceIds: [...(message.referenceIds ?? [])],
      routeSelection: queuedRouteSelection!,
      routeSnapshot: queuedRouteSnapshot!,
    })),
    isLoading: chat.isLoading ?? false,
    isStreaming: chat.isStreaming ?? false,
  };
  replaceConversationState(useChatStore.setState, convId, conversationState, {
    activate: true,
  });
}

function applyScenarioChatReferences(
  chat: NonNullable<AppScenario['chat']>,
  runtimeScenario: AppScenario
): void {
  if (!chat.references?.length) return;
  for (const ref of chat.references) {
    createEntityReference({
      entityType: ref.entity_type,
      displayLabel: ref.display_label,
      locator: ref.locator,
      deepLinkParams: ref.deep_link_params ? JSON.parse(ref.deep_link_params) : null,
      data: ref.data ? JSON.parse(ref.data) : null,
      source: ref.source,
      workspaceScope:
        ref.workspace_scope ??
        workspaceScopeFromState({
          activeWorkspaceFile: null,
          folders: runtimeScenario.workspace?.folders ?? [],
        }),
      workspaceRootPath:
        ref.workspace_root_path ??
        workspaceRootPathForGitLocator(ref.locator, runtimeScenario.workspace?.folders ?? []),
    }).catch(() => {});
  }
}

function applyScenarioChat(runtimeScenario: AppScenario): void {
  if (!runtimeScenario.chat) return;
  applyScenarioChatHostedRouteReadiness(runtimeScenario.chat.hostedRouteReadiness);
  applyScenarioChatProvider(runtimeScenario.chat);
  applyScenarioChatConversation(runtimeScenario.chat);
  applyScenarioChatReferences(runtimeScenario.chat, runtimeScenario);
}

async function applyMaterializedScenario(
  runtimeScenario: AppScenario,
  options: ApplyScenarioDevOptions = {},
  beforeHydrate?: () => void
): Promise<void> {
  if (await applyIndexedGenomeDeltaScenario(runtimeScenario)) return;

  beforeHydrate?.();
  resetStores();

  if (isDesktopRuntime() && runtimeScenario.dev?.materializedRoot) {
    const { openWorkspaceFromSource } =
      await import('../../features/workspace-loader/open-workspace-from-source');
    const { reconcileWorkspaceAfterFilesChanged } =
      await import('../../services/workspace-operations');
    for (const folder of runtimeScenario.workspace?.folders ?? []) {
      await openWorkspaceFromSource(
        {
          kind: 'local-folder',
          path: folder.path,
          name: folder.name,
          ...(folder.pinned ? { pinned: true } : {}),
        },
        { inPlace: true }
      );
      await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: folder.path, strict: true });
    }
    if (runtimeScenario.workspace?.selectedPath) {
      useWorkspaceStore.getState().revealPath(runtimeScenario.workspace.selectedPath);
    }
  } else if (!isDesktopRuntime() && runtimeScenario.workspace) {
    useWorkspaceStore.setState({
      folders: runtimeScenario.workspace.folders.map((f) => ({ ...f, addedAt: Date.now() })),
      selectedPath: runtimeScenario.workspace.selectedPath ?? null,
    });
  }

  await registerScenarioSequenceSources(runtimeScenario);

  applyScenarioRuntimeOverrides(runtimeScenario);
  applyScenarioAgentJobs(runtimeScenario.agentJobs);

  if (runtimeScenario.canvas) {
    applyScenarioCanvasLayout(runtimeScenario.canvas);
  }

  if (runtimeScenario.sequences) {
    for (const [documentId, sequence] of Object.entries(runtimeScenario.sequences)) {
      useSequenceStore.getState().setSequence(documentId, sequence);
    }
  }

  applyScenarioDesigns(runtimeScenario.designs);
  applyScenarioPages(runtimeScenario.pages);

  seedBrowserMockFiles(runtimeScenario);

  applyScenarioChat(runtimeScenario);

  if (runtimeScenario.agentConfirmation) {
    useDestructiveConfirmStore.getState().present(runtimeScenario.agentConfirmation);
  }
  if (runtimeScenario.agentUserInput) {
    useAgentUserInputStore.getState().present(runtimeScenario.agentUserInput);
  }

  if (runtimeScenario.alignment) {
    applyAlignmentScenario(runtimeScenario.alignment);
  }

  if (runtimeScenario.openSequenceDrawer) {
    requestSequenceDrawer(runtimeScenario.openSequenceDrawer);
    clickSequenceDrawerToolbar(runtimeScenario.openSequenceDrawer);
  }

  if (runtimeScenario.laneContract !== undefined) {
    applyLaneContractDirective(runtimeScenario.laneContract);
  }

  if (runtimeScenario.importWizard) {
    void useImportWizardStore.getState().openImportWizard(runtimeScenario.importWizard);
  }

  if (runtimeScenario.dev?.openDnaImportReview && isDesktopRuntime()) {
    const { openDnaImportReview } = await import('./import-readiness-review');
    await openDnaImportReview(runtimeScenario);
  }

  if (runtimeScenario.tabularImportShowcase) {
    void (async () => {
      const { runTabularShowcase } =
        await import('../../features/import-wizard/tabular-showcase-dev');
      await runTabularShowcase();
    })();
  }

  if (runtimeScenario.hangingRefsShowcase) {
    void (async () => {
      const { runHangingRefsShowcase } =
        await import('../../features/lims/hanging-refs-showcase-dev');
      await runHangingRefsShowcase();
    })();
  }

  if (runtimeScenario.openSequenceAt) {
    void applyOpenSequenceAt(runtimeScenario.openSequenceAt);
  }

  const followUps: Array<Promise<void>> = [];

  if (runtimeScenario.attachAlignmentQueries) {
    followUps.push(applyAttachAlignmentQueries(runtimeScenario));
  }

  if (runtimeScenario.lims) {
    followUps.push(applyLimsScenario(runtimeScenario.lims));
  }

  if (
    runtimeScenario.chat?.streamedInlineReferenceText &&
    !options.deferStreamedInlineReferenceText
  ) {
    followUps.push(applyStreamedInlineReferenceText(runtimeScenario));
  }

  if (followUps.length === 0) return;
  await Promise.all(followUps);
}

async function registerScenarioSequenceSources(scenario: AppScenario): Promise<void> {
  if (!scenario.sequenceSources) return;

  const [{ bindCatalogEntityToFile, registerCatalogEntity }, { findContainingPathBoundary }] =
    await Promise.all([import('../../db/workspace-catalog'), import('../../shared/path-boundary')]);

  for (const [documentId, source] of Object.entries(scenario.sequenceSources)) {
    if (source.sequenceDocument?.kind === 'managed-sequence') continue;
    const workspaceRoot = findContainingPathBoundary(
      scenario.workspace?.folders ?? [],
      source.sourcePath
    )?.path;
    if (isDesktopRuntime() && scenario.dev?.materializedRoot && !workspaceRoot) {
      throw new Error(`Dev sequence has no owning project: ${source.name ?? documentId}.`);
    }
    await registerCatalogEntity({
      id: documentId,
      type: 'sequence',
      name: source.name ?? 'Sequence',
      locator: `file://${source.sourcePath}`,
      storageType: 'file',
      workspaceRoot,
      metadata: { devScenario: true },
    });
    await bindCatalogEntityToFile({
      entityId: documentId,
      path: source.sourcePath,
      fileKind: 'sequence',
      workspaceRoot,
    });
  }
}

async function applyStreamedInlineReferenceText(scenario: AppScenario): Promise<void> {
  const content = scenario.chat?.streamedInlineReferenceText;
  if (!content) return;
  const workspace = useWorkspaceStore.getState();
  const session = createInlineReferenceSession({
    roots: workspace.folders,
    workspaceScope: workspaceScopeFromState({
      activeWorkspaceFile: workspace.activeWorkspaceFile,
      folders: workspace.folders,
    }),
    allowedExistingReferenceIds: [],
  });
  session.update('dev-inline-reference', content);
  const finalized = await session.finalize();
  const block = finalized.blocks.get('dev-inline-reference');
  if (!block) throw new Error('Inline-reference DevPanel scenario did not produce a text block.');
  const conversationId = scenario.chat?.conversationId;
  if (!conversationId) {
    throw new Error('Inline-reference DevPanel scenario needs a stable conversation id.');
  }
  setConversationState(useChatStore.setState, conversationId, () => ({
    streamingBlocks: [
      {
        type: 'text',
        id: block.id,
        content: block.content,
        document: block.document,
        referenceIds: block.referenceIds,
      },
    ],
    isStreaming: true,
    isLoading: false,
  }));
}

async function applyAttachAlignmentQueries(scenario: AppScenario): Promise<void> {
  if (!isDesktopRuntime()) return;

  const spec = scenario.attachAlignmentQueries;
  if (!spec?.queryPaths.length) return;

  const activeTab = scenario.canvas?.tabs[scenario.canvas.activeTabIndex ?? 0];
  const documentId = spec.documentId ?? activeTab?.entityId;
  let sourcePath = spec.sourcePath;
  if (!sourcePath && activeTab?.sequenceDocument) {
    const { resolveSequenceDocument } =
      await import('../../features/sequence/sequence-document-repository');
    sourcePath = (await resolveSequenceDocument(activeTab.sequenceDocument)).sourcePath;
  }
  if (!documentId || !sourcePath) {
    throw new Error(
      'attachAlignmentQueries needs a stable sequence document and a resolvable byte source'
    );
  }

  const store = useVerificationStore.getState();
  store.registerReferenceSource(documentId, sourcePath);
  const sessionId = store.createSession(documentId, {
    name: spec.sessionName ?? 'Attached clones',
    mode: spec.mode ?? 'one-per-clone',
    queryPaths: spec.queryPaths,
  });
  await store.runSessionAlignments(documentId, sessionId, spec.queryPaths);
}

let devOpenAtNavSeq = 0;

async function applyOpenSequenceAt(
  directive: NonNullable<AppScenario['openSequenceAt']>
): Promise<void> {
  const { initPlatform } = await import('../../platform');
  const bridge = await initPlatform();
  const projectRoot = await bridge.path.projectRoot();
  if (!projectRoot) {
    console.warn('[DevScenario] openSequenceAt needs a dev checkout (projectRoot is null)');
    return;
  }

  const filePath = `${stripTrailingSlash(projectRoot)}/${directive.filePath.replace(/^\/+/, '')}`;
  if (!(await bridge.fs.exists(filePath).catch(() => false))) {
    console.warn(`[DevScenario] openSequenceAt: file not found — ${filePath}`);
    return;
  }

  const { openSequenceFile } = await import('../../features/document-opening/compat');
  const { primerBindingToViewState } =
    await import('../../features/sequence/primer-binding-viewstate');
  const { modelPatchToTabViewState, normalizeSequenceViewStatePatch } =
    await import('../../features/sequence/view-state/sequence-view-state');

  const tabId = await openSequenceFile({
    filePath,
    label: directive.label ?? directive.filePath.split('/').pop() ?? directive.filePath,
    strategy: { kind: 'focused' },
  });
  if (!tabId) return;

  const focus = primerBindingToViewState(directive.start, directive.end);
  const store = useCanvasStore.getState();
  for (const panel of Object.values(store.panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) {
      store.setTabViewState(panel.id, tabId, {
        ...focus,
        ...(directive.mapShape ? { sequenceMapShape: directive.mapShape } : {}),
        ...(directive.viewState
          ? modelPatchToTabViewState(normalizeSequenceViewStatePatch(directive.viewState))
          : {}),
        sequenceNavigationRequestId: ++devOpenAtNavSeq,
      });
      return;
    }
  }
}

function applyLaneContractDirective(directive: NonNullable<AppScenario['laneContract']>): void {
  if (directive.assemblyId) {
    const datasets =
      directive.activeDatasets ??
      (directive.activeDataset === undefined
        ? undefined
        : directive.activeDataset
          ? [directive.activeDataset]
          : []);
    if (datasets !== undefined) {
      const laneOwnerId = activeLaneOwnerIdForAssembly(directive.assemblyId);
      useLaneContractStore.getState().replaceForOwner(laneOwnerId, directive.assemblyId, datasets);
    }
    return;
  }
  if (directive.activeDatasets !== undefined) {
    useLaneContractStore.getState().setActiveDatasets(directive.activeDatasets);
    return;
  }
  if (directive.activeDataset !== undefined) {
    useLaneContractStore.getState().setActiveDataset(directive.activeDataset);
  }
}

function activeLaneOwnerIdForAssembly(assemblyId: string): string {
  const canvas = useCanvasStore.getState();
  const matchesAssembly = (tab: {
    entityId: string;
    indexedGenome?: { assembly?: { assemblyId?: string } };
  }): boolean =>
    tab.entityId === `assembly:${assemblyId}` ||
    tab.indexedGenome?.assembly?.assemblyId === assemblyId;
  const focusedPanel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : undefined;
  const focusedTab = focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId);
  if (focusedTab && matchesAssembly(focusedTab)) return focusedTab.id;

  const activeMatches = Object.values(canvas.panels).flatMap((panel) => {
    const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
    return activeTab && matchesAssembly(activeTab) ? [activeTab] : [];
  });
  if (activeMatches.length === 1) return activeMatches[0].id;

  throw new Error(
    `Lane scenario for ${assemblyId} needs one active matching assembly tab; found ${activeMatches.length}.`
  );
}

async function applyLimsScenario(lims: NonNullable<AppScenario['lims']>): Promise<void> {
  const { createLimsImportPlan, applyAcceptedLimsImportPlan } =
    await import('../../features/lims/ingress');

  if (lims.imports.some((importSpec) => importSpec.allowExisting)) {
    const { resetLimsRegistry } = await import('../../features/lims/operations');
    await resetLimsRegistry();
  }

  for (const importSpec of lims.imports) {
    const source = await resolveLimsImportSource(importSpec);
    const plan = await createLimsImportPlan({
      fileName: importSpec.sourceName,
      sourcePath: source.sourcePath,
      text: source.text,
      defaultKind: importSpec.defaultKind,
    });

    if (!plan.canApply) {
      throw new Error(
        `Cannot apply LIMS dev scenario import ${importSpec.sourceName}: ${describeLimsPlanBlockers(plan)}`
      );
    }

    await applyAcceptedLimsImportPlan(plan, {
      actor: importSpec.actor,
      batchId: importSpec.batchId,
    });
  }
}

async function resolveLimsImportSource(
  importSpec: NonNullable<AppScenario['lims']>['imports'][number]
): Promise<{ text: string; sourcePath?: string }> {
  if (importSpec.sourcePath) {
    const { initPlatform } = await import('../../platform');
    const bridge = await initPlatform();
    const exists = await bridge.fs.exists(importSpec.sourcePath).catch(() => false);
    if (exists) {
      return {
        text: await bridge.fs.readTextFile(importSpec.sourcePath),
        sourcePath: importSpec.sourcePath,
      };
    }
  }

  if (importSpec.text !== undefined) return { text: importSpec.text };

  throw new Error(
    `LIMS dev scenario source is unavailable and has no text fallback: ${importSpec.sourceName}`
  );
}

const SEQUENCE_DRAWER_TOOLBAR_TEST_IDS: Partial<Record<DrawerType, string>> = {
  metadata: 'toolbar-metadata',
  alignments: 'toolbar-alignments',
  primers: 'toolbar-toggle-primers',
  structure: 'toolbar-structure',
  'restriction-enzymes': 'toolbar-restriction-enzymes',
  'git-history': 'toolbar-git-history',
};

let sequenceDrawerToolbarRetryTimer: number | null = null;
let sequenceDrawerToolbarRetryDocument: Document | null = null;

export function cancelSequenceDrawerToolbarRetry(): void {
  if (sequenceDrawerToolbarRetryTimer !== null) {
    globalThis.clearTimeout(sequenceDrawerToolbarRetryTimer);
    sequenceDrawerToolbarRetryTimer = null;
  }
  sequenceDrawerToolbarRetryDocument?.removeEventListener(
    'pointerdown',
    cancelSequenceDrawerToolbarRetry,
    true
  );
  sequenceDrawerToolbarRetryDocument?.removeEventListener(
    'keydown',
    cancelSequenceDrawerToolbarRetry,
    true
  );
  sequenceDrawerToolbarRetryDocument = null;
}

export function clickSequenceDrawerToolbar(drawer: DrawerType): void {
  cancelSequenceDrawerToolbarRetry();
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const testId = SEQUENCE_DRAWER_TOOLBAR_TEST_IDS[drawer];
  if (!testId) return;
  sequenceDrawerToolbarRetryDocument = document;
  document.addEventListener('pointerdown', cancelSequenceDrawerToolbarRetry, true);
  document.addEventListener('keydown', cancelSequenceDrawerToolbarRetry, true);
  const retryDeadline = performance.now() + 2_000;
  const tryClick = (attempt: number): void => {
    sequenceDrawerToolbarRetryTimer = null;
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      cancelSequenceDrawerToolbarRetry();
      return;
    }
    const button = document.querySelector(`[data-testid="${testId}"]`);
    if (button instanceof HTMLElement) {
      const activeState = button.getAttribute('data-active');
      if (activeState !== 'true') button.click();
      if (activeState === null || performance.now() >= retryDeadline) {
        cancelSequenceDrawerToolbarRetry();
        return;
      }
      sequenceDrawerToolbarRetryTimer = window.setTimeout(() => tryClick(attempt + 1), 50);
      return;
    }
    if (performance.now() >= retryDeadline) {
      cancelSequenceDrawerToolbarRetry();
      return;
    }
    sequenceDrawerToolbarRetryTimer = window.setTimeout(() => tryClick(attempt + 1), 50);
  };
  tryClick(0);
}

function describeLimsPlanBlockers(plan: LimsImportPlan): string {
  const blockers: string[] = [];
  for (const record of plan.records) {
    for (const error of record.errors) {
      blockers.push(`row ${record.sourceRow}: ${error}`);
    }
    for (const unresolved of record.unresolvedLinks) {
      blockers.push(
        `row ${record.sourceRow}: unresolved ${unresolved.label} (${unresolved.reason})`
      );
    }
    if (record.duplicateCandidates.length > 0 && record.accepted) {
      blockers.push(`row ${record.sourceRow}: duplicate ${record.duplicateCandidates[0].name}`);
    }
  }
  return blockers.join('; ') || 'no accepted records';
}

function shouldMaterializeScenarioFilesForRuntime(scenario: AppScenario): boolean {
  return isDesktopRuntime() && Boolean(scenario.files || scenario.assets?.length);
}

function isIndexedGenomeDeltaScenario(scenario: AppScenario): boolean {
  if (scenario.laneContract === undefined && scenario.variantSource === undefined) return false;
  const otherKeys: Array<keyof AppScenario> = [
    'sidecar',
    'canvas',
    'sequences',
    'designs',
    'files',
    'assets',
    'workspace',
    'alignment',
    'attachAlignmentQueries',
    'openSequenceDrawer',
    'multiLane',
    'chat',
    'emptySequenceEntryCue',
    'agentConfirmation',
    'agentUserInput',
  ];
  for (const key of otherKeys) {
    if (scenario[key] !== undefined) return false;
  }
  return true;
}

async function applyVariantSourceDirective(
  directive: NonNullable<AppScenario['variantSource']>
): Promise<void> {
  const canvas = useCanvasStore.getState();
  const owner = Object.entries(canvas.panels)
    .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
    .find(({ tab }) => tab.type === 'sequence' && Boolean(tab.indexedGenome?.assembly));
  const indexedGenome = owner?.tab.indexedGenome;
  const assembly = indexedGenome?.assembly;
  if (!owner || !indexedGenome || !assembly) {
    throw new Error('Variant-source DevPanel preset requires an open indexed assembly.');
  }

  const { prepareVariantSource } = await import('../../features/sequence/variant-client');
  const prepared = await prepareVariantSource({
    variantPath: directive.path,
    references: assembly.chromosomes.map((chromosome) => ({
      name: chromosome.chrom,
      length: chromosome.length,
    })),
  });
  useCanvasStore.getState().updateTab(owner.panelId, owner.tab.id, {
    indexedGenome: {
      ...indexedGenome,
      variantSource: {
        ...prepared,
        matchedReferences: [...prepared.matchedReferences],
        samples: [...prepared.samples],
        attachedAt: Date.now(),
      },
    },
  });
}

const DEV_SCENARIO_PROJECTS_STORAGE_KEY = 'waypoint:dev-scenario-projects';

function readScenarioProjectRecords(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      getBrowserStorage()?.getItem(DEV_SCENARIO_PROJECTS_STORAGE_KEY) ?? '{}'
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordScenarioProjectRoots(scenarioId: string, roots: ReadonlyMap<string, string>): void {
  getBrowserStorage()?.setItem(
    DEV_SCENARIO_PROJECTS_STORAGE_KEY,
    JSON.stringify({ ...readScenarioProjectRecords(), [scenarioId]: Object.fromEntries(roots) })
  );
}

async function reusableScenarioProjectRoots(scenarioId: string): Promise<Map<string, string>> {
  const entry = readScenarioProjectRecords()[scenarioId];
  const recorded = new Map(
    entry && typeof entry === 'object'
      ? Object.entries(entry).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string'
        )
      : []
  );
  if (recorded.size === 0) return recorded;
  const { listWorkspaceLibrary } =
    await import('../../features/workspace-loader/workspace-library');
  const activeProjects = new Set(
    (await listWorkspaceLibrary()).active
      .filter((project) => !project.rootState)
      .map((project) => project.repoPath)
  );
  return new Map([...recorded].filter(([, root]) => activeProjects.has(root)));
}

async function materializeScenarioFilesForRuntime(
  inputScenario: AppScenario,
  apply: (runtimeScenario: AppScenario, beforeHydrate?: () => void) => Promise<void>,
  reuseMaterializedProjects = false
): Promise<void> {
  if (!isDesktopRuntime() || (!inputScenario.files && !inputScenario.assets?.length))
    return apply(inputScenario);

  const { initPlatform } = await import('../../platform');
  const { loadScenarioAssets } = await import('./assets');
  const bridge = await initPlatform();
  const scenario = await loadScenarioAssets(inputScenario, (path) => bridge.fs.readTextFile(path));
  const appDataDir = stripTrailingSlash(await bridge.path.appDataDir());
  const scenarioId = sanitizePathSegment(
    scenario.dev?.scenarioId ??
      scenario.alignment?.activeSessionId ??
      scenario.canvas?.tabs[0]?.label ??
      'scenario'
  );
  const checkoutRoot = await bridge.path.projectRoot();
  const scenarioRoot = checkoutRoot
    ? `${stripTrailingSlash(checkoutRoot)}/test-results/${ELECTRON_SCENARIO_ROOT_NAME}/${scenarioId}`
    : `${appDataDir}/${ELECTRON_SCENARIO_ROOT_NAME}/${scenarioId}`;

  const pathMap = new Map<string, string>();
  const materializedFiles: Record<string, string | Uint8Array> = {};
  const managedDocuments = new Map<
    string,
    Extract<NonNullable<Tab['sequenceDocument']>, { kind: 'managed-sequence' }>
  >();
  const [
    { getTabTypeForFile, getExtension, getFilename },
    { managedSequenceRepository },
    {
      sequencePackagePaths,
      sequencePackageRootForMetaPath,
      parseSequencePackageDocument,
      serializeSequencePackageDocument,
    },
  ] = await Promise.all([
    import('../../utils/fileTypes'),
    import('../../features/sequence/managed-sequence-repository'),
    import('../../db/sequence-package'),
  ]);
  const workspace = scenario.workspace?.folders.length
    ? scenario.workspace
    : {
        folders: [{ path: BROWSER_MOCK_WORKSPACE_ROOT, name: 'Development project' }],
        selectedPath: BROWSER_MOCK_WORKSPACE_ROOT,
      };

  const previousRoots = reuseMaterializedProjects
    ? await reusableScenarioProjectRoots(scenarioId)
    : new Map<string, string>();
  const reusedRoots = new Set(previousRoots.values());
  const referenceRoots = new Map<string, string | undefined>();
  const authoringRoots = new Set<string>();
  for (const folder of workspace.folders) {
    if (folder.pinned) {
      const root = `${scenarioRoot}/reference-${crypto.randomUUID()}`;
      pathMap.set(folder.path, root);
      referenceRoots.set(root, folder.name);
    } else {
      const root =
        previousRoots.get(folder.path) ??
        stripTrailingSlash(
          (await bridge.workspace.createEmptyWorkspace({ name: folder.name })).rootPath
        );
      pathMap.set(folder.path, root);
      authoringRoots.add(root);
    }
  }

  const destinationFor = (sourcePath: string) => {
    const owner = workspace.folders
      .filter((folder) => sourcePath.startsWith(`${stripTrailingSlash(folder.path)}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const sourceIsDocument = Object.values(scenario.sequenceSources ?? {}).some(
      (source) => source.sourcePath === sourcePath
    );
    const fallbackOwner = !scenario.workspace || sourceIsDocument ? workspace.folders[0] : null;
    const project = owner ?? fallbackOwner;
    const targetPath = project
      ? `${pathMap.get(project.path)}/${owner ? sourcePath.slice(stripTrailingSlash(owner.path).length + 1) : scenarioRelativePath(sourcePath)}`
      : `${scenarioRoot}/${scenarioRelativePath(sourcePath)}`;
    return { project, targetPath, sourceIsDocument };
  };
  const nativeMaterializedFiles = new Set<string>();
  const mocloPresetId = scenario.dev?.scenarioId;
  if (isMocloScenarioPresetId(mocloPresetId)) {
    if (workspace.folders.length !== 1 || workspace.folders[0].pinned)
      throw new Error('Bundled MoClo scenarios require one writable project.');
    const folder = workspace.folders[0];
    const root = pathMap.get(folder.path)!;
    const copied = await bridge.internalFixtures.materializeMocloScenarioKit({
      workspaceRoot: root,
      presetId: mocloPresetId,
      ...(reusedRoots.has(root) ? { reuseExisting: true as const } : {}),
    });
    for (const relativePath of copied.files) {
      const sourcePath = `${stripTrailingSlash(folder.path)}/${relativePath}`;
      if (!(sourcePath in scenario.files))
        throw new Error(`The bundled MoClo scenario file is missing: ${sourcePath}`);
      nativeMaterializedFiles.add(sourcePath);
      pathMap.set(sourcePath, `${root}/${relativePath}`);
    }
    for (const item of copied.packages) {
      managedDocuments.set(item.sourcePackageId, {
        kind: 'managed-sequence',
        packageId: item.packageId,
        packageRoot: `${root}/${item.relativeRoot}`,
      });
    }
  }
  const directories = new Set(referenceRoots.keys());
  for (const sourcePath of Object.keys(scenario.files)) {
    if (nativeMaterializedFiles.has(sourcePath)) continue;
    const { targetPath } = destinationFor(sourcePath);
    directories.add(targetPath.slice(0, targetPath.lastIndexOf('/')));
  }
  for (const targetParent of directories) {
    if (authoringRoots.has(targetParent)) continue;
    await bridge.fs.mkdir(targetParent, { recursive: true }).catch((cause: unknown) => {
      throw new Error(`Scenario directory was refused: ${targetParent}`, { cause });
    });
  }
  for (const root of referenceRoots.keys()) {
    for (const args of [
      ['init'],
      ['config', 'user.name', 'DNAForge fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
    ]) {
      const initialized = await bridge.shell.execute('git', args, root);
      if (initialized.code !== 0) {
        throw new Error(`Could not initialize reference fixtures: ${initialized.stderr}`);
      }
    }
  }

  const { getCatalogEntity } = await import('../../db/workspace-catalog');
  const copiedPackages = new Map<string, string>();
  for (const [sourcePath, content] of Object.entries(scenario.files)) {
    if (nativeMaterializedFiles.has(sourcePath)) continue;
    const packageRoot = sequencePackageRootForMetaPath(sourcePath);
    if (!packageRoot) continue;
    const owner = workspace.folders
      .filter((folder) => packageRoot.startsWith(`${stripTrailingSlash(folder.path)}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!owner) throw new Error(`Sequence fixture has no owning project: ${sourcePath}`);
    const document = parseSequencePackageDocument(textContent(content, sourcePath));
    if (!(await getCatalogEntity(document.id))) continue;
    if (managedDocuments.has(document.id)) {
      throw new Error(`Sequence fixture identity is repeated: ${document.id}`);
    }
    const ownerRoot = pathMap.get(owner.path);
    if (!ownerRoot) throw new Error(`Dev project was not created: ${owner.name}.`);
    const targetRoot = `${ownerRoot}${packageRoot.slice(stripTrailingSlash(owner.path).length)}`;
    const existingMeta = sequencePackagePaths(targetRoot).metaPath;
    const packageId =
      reusedRoots.has(ownerRoot) && (await bridge.fs.exists(existingMeta))
        ? parseSequencePackageDocument(await bridge.fs.readTextFile(existingMeta)).id
        : crypto.randomUUID();
    managedDocuments.set(document.id, {
      kind: 'managed-sequence',
      packageId,
      packageRoot: targetRoot,
    });
    copiedPackages.set(
      sourcePath,
      serializeSequencePackageDocument({ ...document, id: packageId })
    );
  }

  const auxiliaryPaths = new Set<string>();
  for (const folder of workspace.folders) {
    const root = pathMap.get(folder.path)!;
    const files: ScenarioFixtureFile[] = [];
    for (const [sourcePath, content] of Object.entries(scenario.files)) {
      if (nativeMaterializedFiles.has(sourcePath)) continue;
      if (!sourcePath.startsWith(`${stripTrailingSlash(folder.path)}/`)) continue;
      if (
        workspace.folders.some(
          (nested) =>
            nested.path.length > folder.path.length &&
            sourcePath.startsWith(`${stripTrailingSlash(nested.path)}/`)
        )
      )
        continue;
      if (getTabTypeForFile(sourcePath) !== 'sequence') continue;
      if (
        Object.values(scenario.sequenceSources ?? {}).some(
          (source) => source.sourcePath === sourcePath
        )
      )
        continue;
      const parent = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
      if (scenario.files[sequencePackagePaths(parent).metaPath]) continue;
      const relativePath = sourcePath.slice(stripTrailingSlash(folder.path).length + 1);
      const path = `${root}/${relativePath}`;
      const directory = path.slice(0, path.lastIndexOf('/'));
      if (!authoringRoots.has(directory)) await bridge.fs.mkdir(directory, { recursive: true });
      await bridge.fs.writeTextFile(path, textContent(content, sourcePath));
      pathMap.set(sourcePath, path);
      materializedFiles[path] = content;
      auxiliaryPaths.add(sourcePath);
      const extension = getExtension(sourcePath);
      files.push({
        relativePath,
        name: getFilename(relativePath),
        fileKind:
          extension === 'gb' || extension === 'gbk' || extension === 'genbank'
            ? 'genbank'
            : extension === 'dna'
              ? 'snapgene'
              : 'fasta',
      });
    }
    if (files.length === 0) continue;
    await bridge.internalFixtures.registerScenarioFiles({ workspaceRoot: root, files });
  }

  for (const [sourcePath, sourceContent] of Object.entries(scenario.files)) {
    if (nativeMaterializedFiles.has(sourcePath)) continue;
    if (auxiliaryPaths.has(sourcePath)) continue;
    const content = copiedPackages.get(sourcePath) ?? sourceContent;
    const { project, targetPath, sourceIsDocument } = destinationFor(sourcePath);
    const sourceParent = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const isPackagedProduct = Boolean(scenario.files[sequencePackagePaths(sourceParent).metaPath]);
    if (
      project &&
      sourceIsDocument &&
      getTabTypeForFile(sourcePath) === 'sequence' &&
      !isPackagedProduct
    ) {
      const workspaceRoot = pathMap.get(project.path);
      if (!workspaceRoot) throw new Error(`Dev project was not created: ${project.name}.`);
      const imported = await bridge.workspace.importSequenceFromContent({
        targetRoot: workspaceRoot,
        relativePath: targetPath.slice(workspaceRoot.length + 1),
        content: textContent(content, sourcePath),
        collisionPolicy: reusedRoots.has(workspaceRoot) ? 'replace' : 'refuse',
      });
      if (imported.kind !== 'imported' || imported.packageRoots.length !== 1) {
        throw new Error(`Could not import dev sequence ${sourcePath}: ${JSON.stringify(imported)}`);
      }
      const resolved = await managedSequenceRepository.openPackage(imported.packageRoots[0]);
      pathMap.set(sourcePath, resolved.productPath);
      materializedFiles[resolved.productPath] = content;
      for (const [documentId, source] of Object.entries(scenario.sequenceSources ?? {})) {
        if (source.sourcePath === sourcePath) managedDocuments.set(documentId, resolved.ref);
      }
      continue;
    }
    await bridge.fs.writeTextFile(targetPath, textContent(content, sourcePath));
    pathMap.set(sourcePath, targetPath);
    materializedFiles[targetPath] = content;
  }

  let remappedScenario = remapScenarioPaths(
    {
      ...scenario,
      workspace,
      dev: {
        ...scenario.dev,
        materializedRoot: scenarioRoot,
      },
      files: materializedFiles,
    },
    pathMap,
    managedDocuments
  );

  const designArtifactBindings: Array<{
    design: SequenceDesign;
    path: string;
    workspaceRoot: string;
    sizeBytes: number;
  }> = [];
  if (scenario.dev?.materializeDesignArtifacts) {
    const folders = remappedScenario.workspace?.folders ?? [];
    const designs = Object.values(
      normalizeScenarioDesigns(remappedScenario.designs?.designs ?? {})
    );
    if (folders.length !== 1 || designs.length === 0) {
      throw new Error(
        'File-backed design scenarios require one workspace and at least one design.'
      );
    }
    const workspaceRoot = folders[0].path;
    const usedPaths = new Set<string>();
    for (const design of designs) {
      const path = `${workspaceRoot}/${sanitizePathSegment(design.id)}.wpdesign.json`;
      if (usedPaths.has(path)) throw new Error(`Duplicate scenario design artifact: ${path}`);
      usedPaths.add(path);
      const serialized = `${JSON.stringify(
        {
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id: design.id,
          name: design.name,
          storage: { type: 'localStorage', key: 'waypoint-designs', id: design.id },
          design,
          plannedOutputs: [{ format: 'genbank', status: 'pending-sequence' }],
        },
        null,
        2
      )}\n`;
      await bridge.fs.writeTextFile(path, serialized);
      designArtifactBindings.push({
        design,
        path,
        workspaceRoot,
        sizeBytes: new TextEncoder().encode(serialized).length,
      });
    }
  }

  const finishMaterialization = async (materialized: AppScenario, assertCurrent?: () => void) => {
    for (const folder of workspace.folders) {
      if (!folder.pinned) continue;
      const root = pathMap.get(folder.path);
      if (!root) throw new Error(`Could not resolve reference fixtures for ${folder.name}.`);
      assertCurrent?.();
      await bridge.db.ensureWorkspaceOwner(root, 'reference', { name: folder.name });
      assertCurrent?.();
    }

    if (designArtifactBindings.length > 0) {
      assertCurrent?.();
      const { registerCatalogEntity, bindCatalogEntityToFile } =
        await import('../../db/workspace-catalog');
      assertCurrent?.();
      for (const { design, path, workspaceRoot, sizeBytes } of designArtifactBindings) {
        assertCurrent?.();
        const entity = await registerCatalogEntity({
          id: design.id,
          type: 'design',
          name: design.name,
          locator: `entity://design/${design.id}`,
          storageType: 'localStorage',
          workspaceRoot,
          metadata: { devScenario: true, artifactSchema: 'waypoint.design.v1' },
        });
        assertCurrent?.();
        await bindCatalogEntityToFile({
          entityId: entity.id,
          path,
          fileKind: 'waypoint-design',
          workspaceRoot,
          sizeBytes,
          modifiedAt: Date.now(),
        });
        assertCurrent?.();
      }
    }

    assertCurrent?.();
    const scoped = await scopeMaterializedPagesToWorkspace(materialized);
    assertCurrent?.();
    return apply(scoped, assertCurrent);
  };
  recordScenarioProjectRoots(
    scenarioId,
    new Map(
      workspace.folders.flatMap((folder) => {
        const root = folder.pinned ? undefined : pathMap.get(folder.path);
        return root ? [[folder.path, root] as const] : [];
      })
    )
  );
  if (scenario.dev?.initializeGit) {
    return settleMarkdownScenarioBaseline(
      bridge,
      remappedScenario,
      (root, message, assertCurrent) =>
        commitMaterializedScenarioFiles(bridge, root, message, assertCurrent),
      (canonicalPaths, assertCurrent) =>
        finishMaterialization(remapScenarioPaths(remappedScenario, canonicalPaths), assertCurrent)
    );
  }
  return finishMaterialization(remappedScenario);
}

async function scopeMaterializedPagesToWorkspace(scenario: AppScenario): Promise<AppScenario> {
  if (!scenario.pages) return scenario;

  const workspaceFolders = scenario.workspace?.folders ?? [];
  if (workspaceFolders.length !== 1) {
    throw new Error(
      'Electron dev scenarios with notebook pages require exactly one materialized workspace folder.'
    );
  }

  const [{ resolveWorkspaceScope }, { scopedProjectionId }] = await Promise.all([
    import('../../db/workspace-catalog'),
    import('../../shared/workspace-scoped-identity'),
  ]);
  const scope = await resolveWorkspaceScope(workspaceFolders[0].path);
  if (!scope) {
    throw new Error('Could not resolve a workspace scope for the materialized notebook scenario.');
  }

  const scopedIds = new Map(
    scenario.pages.pages.map((page) => [page.id, scopedProjectionId(scope, page.id)])
  );

  return {
    ...scenario,
    pages: {
      pages: scenario.pages.pages.map((page) => ({
        ...page,
        id: scopedIds.get(page.id) ?? page.id,
      })),
    },
    canvas: scenario.canvas
      ? {
          ...scenario.canvas,
          tabs: scenario.canvas.tabs.map((tab) => ({
            ...tab,
            entityId:
              tab.type === 'page' ? (scopedIds.get(tab.entityId) ?? tab.entityId) : tab.entityId,
          })),
        }
      : undefined,
  };
}

async function commitMaterializedScenarioFiles(
  bridge: PlatformBridge,
  workspaceRoot: string,
  commitMessage: string,
  assertCurrent: () => void
): Promise<void> {
  const runGit = async (args: string[]): Promise<void> => {
    assertCurrent();
    const result = await bridge.shell.execute('git', args, workspaceRoot);
    assertCurrent();
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(`Could not commit DevPanel project fixtures: git ${args[0]}: ${detail}`);
    }
  };

  await runGit(['add', '--all']);
  assertCurrent();
  const staged = await bridge.shell.execute('git', ['status', '--porcelain'], workspaceRoot);
  assertCurrent();
  if (staged.code !== 0) {
    throw new Error(
      `Could not inspect DevPanel project fixtures: ${staged.stderr.trim() || staged.stdout.trim() || staged.code}`
    );
  }
  if (!staged.stdout.split('\n').some((line) => line[0] && line[0] !== ' ' && line[0] !== '?'))
    return;
  await runGit(['commit', '-m', commitMessage]);
}

function remapScenarioPaths(
  scenario: AppScenario,
  pathMap: Map<string, string>,
  managedDocuments: Map<
    string,
    Extract<NonNullable<Tab['sequenceDocument']>, { kind: 'managed-sequence' }>
  > = new Map()
): AppScenario {
  const remap = (path: string): string => {
    const exact = managedDocuments.get(path)?.packageId ?? pathMap.get(path);
    if (exact) return exact;

    const prefixMatch = [...pathMap.entries()]
      .filter(([sourcePath]) => path.startsWith(`${sourcePath}/`))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!prefixMatch) return path;

    const [sourcePath, targetPath] = prefixMatch;
    return `${targetPath}${path.slice(sourcePath.length)}`;
  };

  const remapQuickLookReceipt = (receipt: QuickLookPackageReceipt): QuickLookPackageReceipt => {
    const records = receipt.records.map((record) => ({
      ...record,
      productPath: remap(record.productPath),
    }));
    const firstRecord = records[0];
    if (!firstRecord) throw new Error('Quick Look receipt contains no sequence records.');
    return {
      ...receipt,
      sourcePath: remap(receipt.sourcePath),
      productPath: remap(receipt.productPath),
      packageRoot: remap(receipt.packageRoot),
      records: [firstRecord, ...records.slice(1)],
    };
  };

  return {
    ...scenario,
    canvas: scenario.canvas
      ? {
          ...scenario.canvas,
          tabs: scenario.canvas.tabs.map((tab) => ({
            ...tab,
            entityId: remap(tab.entityId),
            quickLookSource: tab.quickLookSource
              ? remapQuickLookReceipt(tab.quickLookSource)
              : undefined,
            sequenceDocument:
              managedDocuments.get(tab.entityId) ??
              (tab.sequenceDocument?.kind === 'managed-sequence'
                ? {
                    ...tab.sequenceDocument,
                    packageId: remap(tab.sequenceDocument.packageId),
                    packageRoot: remap(tab.sequenceDocument.packageRoot),
                  }
                : tab.sequenceDocument),
          })),
        }
      : undefined,
    sequences: scenario.sequences
      ? Object.fromEntries(
          Object.entries(scenario.sequences).map(([id, sequence]) => [
            remap(id),
            { ...sequence, id: remap(id) },
          ])
        )
      : undefined,
    sequenceSources: scenario.sequenceSources
      ? Object.fromEntries(
          Object.entries(scenario.sequenceSources).map(([documentId, source]) => [
            remap(documentId),
            {
              ...source,
              sourcePath: remap(source.sourcePath),
              sequenceDocument:
                managedDocuments.get(documentId) ??
                (source.sequenceDocument?.kind === 'managed-sequence'
                  ? {
                      ...source.sequenceDocument,
                      packageId: remap(source.sequenceDocument.packageId),
                      packageRoot: remap(source.sequenceDocument.packageRoot),
                    }
                  : source.sequenceDocument),
            },
          ])
        )
      : undefined,
    designs: scenario.designs
      ? {
          ...scenario.designs,
          designs: Object.fromEntries(
            Object.entries(scenario.designs.designs).map(([id, design]) => [
              id,
              {
                ...design,
                regions: design.regions.map((region) => ({
                  ...region,
                  sourceSequenceId: remap(region.sourceSequenceId),
                })),
                backboneSequenceId: design.backboneSequenceId
                  ? remap(design.backboneSequenceId)
                  : design.backboneSequenceId,
              },
            ])
          ),
          lastCopied: scenario.designs.lastCopied
            ? {
                ...scenario.designs.lastCopied,
                sourceId: remap(scenario.designs.lastCopied.sourceId),
              }
            : scenario.designs.lastCopied,
        }
      : undefined,
    workspace: scenario.workspace
      ? {
          ...scenario.workspace,
          folders: scenario.workspace.folders.map((folder) => ({
            ...folder,
            path: remap(folder.path),
          })),
          selectedPath: scenario.workspace.selectedPath
            ? remap(scenario.workspace.selectedPath)
            : undefined,
        }
      : undefined,
    alignment: scenario.alignment
      ? {
          ...scenario.alignment,
          documentId: remap(scenario.alignment.documentId),
          sourcePath: remap(scenario.alignment.sourcePath),
          sessions: scenario.alignment.sessions.map((session) => ({
            ...session,
            tracks: session.tracks.map((track) => ({
              ...track,
              queryPath: remap(track.queryPath),
            })),
          })),
        }
      : undefined,
    attachAlignmentQueries: scenario.attachAlignmentQueries
      ? {
          ...scenario.attachAlignmentQueries,
          documentId: scenario.attachAlignmentQueries.documentId
            ? remap(scenario.attachAlignmentQueries.documentId)
            : undefined,
          queryPaths: scenario.attachAlignmentQueries.queryPaths.map(remap),
          sourcePath: scenario.attachAlignmentQueries.sourcePath
            ? remap(scenario.attachAlignmentQueries.sourcePath)
            : undefined,
        }
      : undefined,
  };
}

function scenarioRelativePath(sourcePath: string): string {
  const relativePath = sourcePath.startsWith(`${BROWSER_MOCK_WORKSPACE_ROOT}/`)
    ? sourcePath.slice(BROWSER_MOCK_WORKSPACE_ROOT.length + 1)
    : sourcePath.replace(/^\/+/, '');
  const segments = relativePath.split('/').filter(Boolean).map(sanitizePathSegment);
  return segments.length > 0 ? segments.join('/') : 'fixture';
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'fixture';
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function textContent(content: string | Uint8Array, sourcePath: string): string {
  if (typeof content === 'string') return content;

  throw new Error(
    `Electron dev scenario file materialization only supports text files; ` +
      `${sourcePath} is binary. Add a binary filesystem bridge writer before ` +
      `using Uint8Array fixtures in Electron scenarios.`
  );
}

export function getScenarioMutationProfile(): RuntimeProfile {
  if (!isDesktopRuntime()) {
    return createRuntimeProfile({
      isElectron: false,
      isE2e: false,
      scenarioMutationAllowed: true,
      scenarioMutationReason: 'Browser/mock runtime uses in-memory fixture state.',
    });
  }

  const profile = (
    typeof window === 'undefined'
      ? undefined
      : (window as ScenarioRuntimeWindow).electronAPI?.runtime?.getProfile?.()
  ) as RuntimeProfile | undefined;

  if (profile) return profile;

  return createRuntimeProfile({
    isElectron: true,
    isE2e: false,
    scenarioMutationAllowed: false,
    scenarioMutationReason:
      'Blocked: Electron runtime profile is unavailable. Refusing to mutate live state.',
  });
}

export function assertScenarioMutationAllowed(operation: string): void {
  const profile = getScenarioMutationProfile();
  if (profile.scenarioMutationAllowed) return;

  throw new Error(
    `${BLOCKED_SCENARIO_MUTATION_MESSAGE} ` +
      `${operation} would reset in-memory app stores and may hide the user's active chat/workspace. ` +
      `Launch a disposable scenario profile with --e2e plus WAYPOINT_TEST=1, or ` +
      `DNAFORGE_ALLOW_SCENARIO_MUTATION=1. Runtime profile: ${profile.kind}. ` +
      profile.scenarioMutationReason
  );
}

function resetStores(): void {
  _resetToolboxState();

  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs: [], activeTabId: null },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });

  useSequenceStore.getState().clearAll();

  useEmptySequenceEntryStore.getState().reset();
  usePageStore.setState({
    pages: {},
    pageList: [],
    loadingIds: new Set(),
    dirtyIds: new Set(),
    listLoaded: false,
    isListLoading: false,
    listError: null,
    initialized: false,
  });

  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  useRichSequenceClipboardStore.getState().clear();

  useWorkspaceStore.setState({
    folders: [],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
    selectedPath: null,
    isLoading: false,
    error: null,
  });

  resetAlignmentScenarioState();
  clearRequestedSequenceDrawer();

  useAttachedReadsStore.getState().clear();

  useChatStore.setState({
    messages: [],
    turns: {},
    activeTurnId: null,
    conversations: [],
    streamingBlocks: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    queuedMessages: [],
    currentConversationId: null,
    pendingMessage: null,
    pendingDraft: null,
    pendingAskAiPicker: null,
    askAiInlineChat: null,
    _convStates: new Map(),
  });

  useDestructiveConfirmStore.getState().clear();
  useAgentUserInputStore.getState().clear();

  useLaneContractStore.getState().clear();
  useAgentJobsStore.getState().resetForTests();
}

function seedBrowserMockFiles(scenario: AppScenario): void {
  if (!scenario.files || typeof window === 'undefined') return;

  const mockUtils = (window as Window & { __mockUtils?: BrowserMockUtils }).__mockUtils;
  if (!mockUtils?.setMockFileContent) return;

  for (const [path, content] of Object.entries(scenario.files)) {
    mockUtils.setMockFileContent(path, content);
  }

  if (!mockUtils.setFileTree) return;

  const byDirectory = new Map<
    string,
    Array<{ name: string; isDirectory: boolean; content?: string | Uint8Array }>
  >();
  for (const [path, content] of Object.entries(scenario.files)) {
    const slash = path.lastIndexOf('/');
    if (slash <= 0) continue;
    const directory = path.slice(0, slash);
    const name = path.slice(slash + 1);
    const entries = byDirectory.get(directory) ?? [];
    entries.push({ name, isDirectory: false, content });
    byDirectory.set(directory, entries);
  }

  for (const [directory, entries] of byDirectory) {
    mockUtils.setFileTree(directory, entries);
  }
}

export function resetToLiveState(): void {
  cancelSequenceDrawerToolbarRetry();
  clearLastAppliedDevScenarioPreset();
  assertScenarioMutationAllowed('resetToLiveState');
  activeDevScenarioPresetId = null;
  _clearDevOverride();
  setUsageAnalyticsDevOverride(null);
  resetStores();
}

function normalizeScenarioDesigns(
  designs: Record<string, SequenceDesign>
): Record<string, SequenceDesign> {
  return Object.fromEntries(
    Object.entries(designs).map(([id, design]) => [
      id,
      {
        ...normalizeAssemblySlots(design),
        createdAt: new Date(design.createdAt),
        updatedAt: new Date(design.updatedAt),
      },
    ])
  );
}
