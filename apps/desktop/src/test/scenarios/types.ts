import type { Tab } from '../../features/canvas/types';
import type { SequenceDesign } from '../../features/design/types';
import type { CopiedRegion } from '../../features/design/store';
import type { SessionMode, TrackStatus } from '../../features/alignment-manager/types';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceViewStatePatch } from '../../features/sequence/view-state/sequence-view-state';
import type { JSONContent } from '@tiptap/core';
import type { LimsEntityKind } from '../../shared/lims';
import type {
  AgentUserInputRequest,
  DestructiveFileConfirmRequest,
} from '../../shared/agent-confirm-types';
import type { HostedRouteReadiness } from '../../features/ai/hosted-gateway';
import type { FileAssociationHandlerStatus } from '../../shared/file-association-ipc';
import type { AgentJobRecord } from '../../features/jobs/agent-jobs-presentation';

export interface ProgressInfo {
  phase: string;
  percent: number;
  detail: string;
}

export interface ComponentStatus {
  id: string;
  label: string;
  status: 'ready' | 'downloading' | 'error' | 'unavailable';
  source: string;
  version?: string;
  path?: string;
  progress?: ProgressInfo;
  size_mb?: number;
}

export interface CapabilityStatus {
  id: string;
  label: string;
  status: 'ready' | 'downloading' | 'error' | 'unavailable';
  source: string;
  tier: 'base' | 'optional';
  auto_install: boolean;
  components: ComponentStatus[];
}

export interface ToolboxStatusResponse {
  capabilities: CapabilityStatus[];
}

export interface AppScenario {
  dev?: {
    scenarioId?: string;
    materializedRoot?: string;

    initializeGit?: boolean;

    initialGitCommitMessage?: string;

    materializeDesignArtifacts?: boolean;

    openDnaImportReview?: boolean;
  };

  fileAssociations?: {
    handlerStatuses: readonly FileAssociationHandlerStatus[];
    openSettings?: boolean;
  };

  usageAnalytics?: { enabled: boolean | null };

  sidecar?: ToolboxStatusResponse;

  agentJobs?: {
    jobs: AgentJobRecord[];
    jobCount?: number;
    activeCount?: number;
    terminalCount?: number;
    historyComplete?: boolean;
    observedAtMs: number;
    error?: string | null;
  };

  canvas?: {
    tabs: Array<
      Pick<Tab, 'type' | 'entityId' | 'label'> &
        Partial<Pick<Tab, 'readOnly' | 'quickLookSource' | 'sourceFileName' | 'sequenceDocument'>>
    >;
    activeTabIndex?: number;
    layout?: 'single' | 'split-horizontal' | 'split-vertical' | 'three-column';
  };

  sequences?: Record<string, AnnotatedSequence>;

  sequenceSources?: Record<
    string,
    {
      sourcePath: string;
      name?: string;

      sequenceDocument?: Extract<
        NonNullable<Tab['sequenceDocument']>,
        { kind: 'managed-sequence' }
      >;
    }
  >;

  designs?: {
    designs: Record<string, SequenceDesign>;
    activeDesignId?: string | null;
    pendingDispatchId?: string | null;

    lastCopied?: CopiedRegion | null;
  };

  pages?: {
    pages: Array<{
      id: string;
      title: string;
      content: JSONContent;
    }>;
  };

  files?: Record<string, string | Uint8Array>;

  assets?: Array<{
    wpAssetsPath: string;

    mountPath: string;

    optional?: boolean;
  }>;

  workspace?: {
    folders: Array<{ path: string; name: string; pinned?: boolean }>;
    selectedPath?: string;
  };

  lims?: {
    imports: Array<{
      sourceName: string;

      sourcePath?: string;

      text?: string;

      defaultKind?: LimsEntityKind;

      batchId?: string;

      actor?: string | null;

      allowExisting?: boolean;
    }>;
  };

  attachAlignmentQueries?: {
    queryPaths: string[];
    sessionName?: string;
    mode?: SessionMode;

    documentId?: string;

    sourcePath?: string;
  };

  alignment?: {
    documentId: string;

    sourcePath: string;
    isStale: boolean;

    staleSessionIds?: string[];
    storedChecksum?: string;
    sessions: Array<{
      id: string;
      name: string;
      mode: SessionMode;
      tracks: Array<{
        id: string;
        queryPath: string;
        label: string;
        alignment?: {
          alignedReference: string;
          alignedQuery: string;
          identity: number;
          coverageStart: number;
          coverageEnd: number;
          algorithm: string;
        };
        mutations?: Array<{
          id: string;
          position: number;
          type: 'substitution' | 'insertion' | 'deletion';
          referenceBase: string;
          alternateBase: string;
          length: number;
        }>;
        status: TrackStatus;
        alignedAt?: string;
        checkedMutations?: string[];
      }>;
    }>;
    activeSessionId?: string;
  };

  multiLane?: {
    columnCount: number;

    pxPerColumn: number;

    lanes: Array<{
      id: string;
      type: 'reference' | 'read' | 'consensus' | 'feature' | 'translation' | string;
      height: number;

      color: string;
      header?: { width: number; label: string };
    }>;

    scrollTop?: number;
  };

  chat?: {
    conversationId?: string;
    messages?: Array<{
      id: string;
      role: 'user' | 'assistant' | 'tool' | 'activity';
      content: string;
      toolName?: string;
      toolCallId?: string;
      createdAt: number;
    }>;

    queuedMessages?: Array<{
      id: string;
      content: string;
      workspacePath?: string | null;
      referenceIds?: string[];
      createdAt: number;
    }>;

    isLoading?: boolean;
    isStreaming?: boolean;
    references?: Array<{
      id: string;
      entity_type: string;
      display_label: string;
      locator: string;
      deep_link_params: string | null;
      data: string | null;
      source: string;
      status: string;
      created_at: number;
      updated_at: number;
      workspace_scope?: string | null;
      workspace_root_path?: string | null;
    }>;
    provider?: string;
    model?: string;

    hostedRouteReadiness?: HostedRouteReadiness;

    streamedInlineReferenceText?: string;
  };

  agentConfirmation?: DestructiveFileConfirmRequest;

  agentUserInput?: AgentUserInputRequest;

  laneContract?: {
    assemblyId?: string;
    activeDataset?:
      | import('../../features/sequence/lane-contract-store').ActiveStressDataset
      | null;
    activeDatasets?: ReadonlyArray<
      import('../../features/sequence/lane-contract-store').ActiveStressDataset
    >;
  };

  variantSource?: {
    path: string;
  };

  importWizard?: import('../../features/workspace-loader/import-wizard-state').ImportWizardState;

  emptySequenceEntryCue?: import('../../features/sequence/empty-sequence-entry-store').EmptySequenceEntryCue;

  tabularImportShowcase?: boolean;

  hangingRefsShowcase?: boolean;

  openSequenceDrawer?:
    | 'annotations'
    | 'metadata'
    | 'alignments'
    | 'git-history'
    | 'primers'
    | 'structure'
    | 'restriction-enzymes';

  openSequenceAt?: {
    filePath: string;
    label?: string;
    start: number;
    end: number;

    mapShape?: 'circular' | 'linear';

    viewState?: SequenceViewStatePatch;
  };
}
