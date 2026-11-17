import { cdsMutationGallery, CDS_MUTATION_GALLERY_ID } from './cds-mutation-gallery';
import { agentWorkflowCheck } from './agent-workflow-check';
import type { NativeDataLayerExample } from './native-data-layer-examples';
import {
  typicalSession,
  freshSession,
  editingSession,
  downloadingSession,
  errorSession,
  staleAlignmentSession,
  sequencePackageAttachTwoClones,
  sequencePackageMetadata,
  tabularCsvCrashRepro,
  aiExploreSession,
  inlineEntityChipsSession,
  aiMultiFileSession,
  agentTraceCliSession,
  demoSession,
  sangerCleanFwdSession,
  sangerCleanRcSession,
  sangerRcWithIndelsSession,
  sangerHeterozygousSession,
  sangerFailedSession,
  sangerAttachedCleanFwdSession,
  sangerAttachedCleanRcSession,
  sangerAttachedRcWithIndelsSession,
  sangerAttachedHeterozygousSession,
  sangerAttachedFailedSession,
  sangerAttachedOriginSpanningSession,
  sangerAttachedMultiReadSession,
  cutSiteHomingEndoSession,
  structureThrLSession,
  assemblyCutGeneAcrossJunctionScenario,
  cdsExtensionIncompleteCdsScenario,
  cdsExtensionOriginSpanScenario,
  cdsExtensionStopJustPastOriginScenario,
  cdsExtensionStopFarPastOriginScenario,
  realAssemblyGibsonPcrPcr,
  realAssemblyGibsonPcrPcrSpacer,
  realAssemblyGibsonPcrPcrSpacerFinalization,
  realAssemblyGibsonPcrRdPcr,
  realAssemblyGibsonPcrRdPcrTwoSpacers,
  realAssemblyGibsonRd5PrimePcr,
  realAssemblyGibsonRdSpacerPcr,
  realAssemblyGibsonRd3PrimePcr,
  realAssemblyGibsonRdBluntPcr,
  realAssemblyGibsonRdRdInvalid,
  realAssemblyNebuilderRdSpacer,
  realAssemblyNebuilderRdRdInvalid,
  assemblyUiCleanupShowcase,
  assemblyCrossoverEditingShowcase,
  cidarMocloRedFluorescentTu,
  cidarMocloMixedRouteRedFluorescentTu,
  ytkMocloFactoryExpressionCassette,
  realAssemblyGoldenGatePcrPcr,
  realAssemblyGoldenGatePcrPcrSpacer,
  realAssemblyGoldenGatePcrRdPcr,
  realAssemblyGoldenGateRdEnzymeMismatchInvalid,
  realAssemblyGoldenGateInternalSite,
  realAssemblyManyTabs,
  realAssemblyManyTabsStress,
  limsHeaderlessPrimerTsvScenario,
  limsMessyPrimerCsvImportScenario,
  limsPrimerCsvImportScenario,
  assemblyDemoWorkspace,
  multiProjectRootsSession,
  primerFileAuthorityWorkspace,
  legacyReferenceRepairWorkspace,
  is3TransposaseMinusOneSlip,
  nrdFBGroupIIntron,
  prfBPlusOneSkip,
  completeMg1655Linear,
} from './presets';
import {
  grch38GenomeWidePileup,
  grch38GenomeWideLocalNA12718Cram,
  grch38GenomeWideLocalHg002_80x,
  grch38GenomeWideLocalHg002_80xMutations,
} from './full-genome-pileup';
import type { AppScenario } from './types';
import { importWizardShowcaseScenario } from './import-wizard-showcase';
import { importReadinessReview } from './import-readiness-review';
import { serializeGenBank } from '@waypoint/sequence-utils';
import type { EmptySequenceEntryCue } from '../../features/sequence/empty-sequence-entry-store';
import { paperProtocolScenario } from './paper-protocol';
import { notebookContentExtensionsSession } from './notebook-content-extensions';
import { agentScientificAuthoringWorkspace } from './agent-scientific-authoring';
import { jobsAgentActionsRegistry, jobsAnnotationWorkspace } from './jobs-annotation';
import { MG1655_ANNOTATION_CATALOG_PRESET } from './mg1655-annotation-catalog';
import type { ComposeIndexedTrackViewInput } from '../../features/ai/tools/compose-indexed-track-view';
import {
  POWNALL_FIGURE_4N_COMPOSITION,
  POWNALL_FIGURE_4N_LOCAL_SOURCES,
  POWNALL_FIGURE_4N_PRESET_ID,
  POWNALL_FIGURE_4N_REFERENCE_ID,
  POWNALL_FIGURE_4N_REFERENCE_SHELL,
  pownallFigure4NShowcaseScenario,
} from './pownall-figure-4n';

const CHAT_RENDERING_CONVERSATION_ID = 'chat-message-rendering-showcase';
const CHAT_RENDERING_USER_MESSAGE =
  'Literal user text: **not bold**, # not a heading, and > not a quote.';
const CHAT_RENDERING_ASSISTANT_MESSAGE = `# Restriction digest summary

The candidate construct has a clean two-enzyme diagnostic pattern.

| Enzyme | Recognition site | Expected cuts | Fragment 1 | Fragment 2 | Buffer | Incubation |
| --- | --- | ---: | ---: | ---: | --- | --- |
| EcoRI-HF | GAATTC | 1 | 1,842 bp | 3,906 bp | rCutSmart | 37 °C, 15 min |
| HindIII-HF | AAGCTT | 1 | 2,417 bp | 3,331 bp | rCutSmart | 37 °C, 15 min |
| EcoRI-HF + HindIII-HF | Dual digest | 2 | 1,842 bp | 2,417 bp + 1,489 bp | rCutSmart | 37 °C, 15 min |

- Use a **1% agarose gel** for separation.
- Include an undigested control.

\`Expected total length: 5,748 bp\``;

function chatMessageRenderingShowcase(): AppScenario {
  return {
    canvas: {
      tabs: [
        {
          type: 'chat',
          entityId: CHAT_RENDERING_CONVERSATION_ID,
          label: 'Chat rendering review',
        },
      ],
      activeTabIndex: 0,
    },
    chat: {
      conversationId: CHAT_RENDERING_CONVERSATION_ID,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          id: 'chat-message-rendering-user',
          role: 'user',
          content: CHAT_RENDERING_USER_MESSAGE,
          createdAt: 1,
        },
        {
          id: 'chat-message-rendering-assistant',
          role: 'assistant',
          content: CHAT_RENDERING_ASSISTANT_MESSAGE,
          createdAt: 2,
        },
      ],
    },
  };
}

function emptySequenceEntryShowcase(cue: EmptySequenceEntryCue): AppScenario {
  const filePath = '/mock/test/workspace/Empty DNA sequence.gb';
  const documentId = `fixture:sequence:empty-dna-${cue}`;
  const sequence = {
    id: 'empty-dna-sequence',
    name: 'Empty DNA sequence',
    sequence: '',
    length: 0,
    circular: false,
    annotations: [],
  };

  return {
    dev: { scenarioId: `fixture-empty-sequence-${cue}` },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: documentId,
          label: 'Empty DNA sequence',
          sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
        },
      ],
      activeTabIndex: 0,
    },
    sequences: { [documentId]: { ...sequence, id: documentId } },
    sequenceSources: {
      [documentId]: { sourcePath: filePath, name: 'Empty DNA sequence' },
    },
    files: { [filePath]: serializeGenBank(sequence) },
    emptySequenceEntryCue: cue,
  };
}

function recentlyEditedReferenceBoundary(): AppScenario {
  const writableRoot = '/mock/test/workspace/recent-edit-writable';
  const referenceRoot = '/mock/test/workspace/recent-edit-reference';
  const writablePath = `${writableRoot}/results/future-sample.dnaforge-next`;

  return {
    dev: {
      scenarioId: 'fixture-recently-edited-reference-boundary',
      initializeGit: true,
      initialGitCommitMessage: 'Seed recent activity boundary',
    },
    files: {
      [writablePath]: 'future writable artifact',
      [`${referenceRoot}/annotation-input-revisions`]: 'reference fixture',
      [`${referenceRoot}/v09.expect`]: 'reference fixture expectation',
    },
    workspace: {
      folders: [
        { path: writableRoot, name: 'Writable project' },
        { path: referenceRoot, name: 'test-fixtures', pinned: true },
      ],
      selectedPath: writableRoot,
    },
  };
}

function agentInlineApprovalShowcase(): AppScenario {
  const conversationId = 'agent-inline-approval-showcase';
  return {
    canvas: {
      tabs: [{ type: 'chat', entityId: conversationId, label: 'Agent approval review' }],
      activeTabIndex: 0,
    },
    chat: {
      conversationId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          id: 'agent-inline-approval-user',
          role: 'user',
          content: 'Remove the generated build directory.',
          createdAt: 1,
        },
      ],
    },
    agentConfirmation: {
      requestId: 'agent-inline-approval-request',
      conversationId,
      toolName: 'Bash',
      operation: 'Run shell command',
      resolvedPath: '/workspace/dnaforge',
      command: 'rm -rf build',
      risk: 'destructive',
      riskSummary: 'This command can delete files or directories.',
    },
  };
}

function agentStructuredQuestionShowcase(): AppScenario {
  const conversationId = 'agent-structured-question-showcase';
  return {
    canvas: {
      tabs: [{ type: 'chat', entityId: conversationId, label: 'Agent question review' }],
      activeTabIndex: 0,
    },
    chat: {
      conversationId,
      provider: 'openai',
      model: 'gpt-5-codex',
      isLoading: true,
      messages: [
        {
          id: 'agent-question-user',
          role: 'user',
          content: 'Plan the assembly and ask me for the remaining choices.',
          createdAt: 1,
        },
      ],
    },
    agentUserInput: {
      requestId: 'agent-structured-question-request',
      conversationId,
      provider: 'codex-sdk',
      questions: [
        {
          id: 'method',
          header: 'Assembly',
          prompt: 'Which assembly method should I use?',
          options: [
            { id: 'gibson', label: 'Gibson', description: 'Join overlapping fragments.' },
            {
              id: 'golden-gate',
              label: 'Golden Gate',
              description: 'Use Type IIS restriction assembly.',
            },
          ],
          multiSelect: false,
          allowFreeText: true,
          defaultOptionIds: ['gibson'],
        },
        {
          id: 'checks',
          header: 'Validation',
          prompt: 'Which checks should I include?',
          options: [
            { id: 'sequence', label: 'Sequence', description: 'Check the final bases.' },
            { id: 'topology', label: 'Topology', description: 'Check circular assembly.' },
          ],
          multiSelect: true,
          allowFreeText: false,
          defaultOptionIds: ['sequence'],
        },
        {
          id: 'notes',
          header: 'Notes',
          prompt: 'Add any constraints the agent should follow.',
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
  };
}

function agentQueuedMessagesShowcase(): AppScenario {
  const conversationId = 'agent-queued-messages-showcase';
  return {
    canvas: {
      tabs: [{ type: 'chat', entityId: conversationId, label: 'Queued message review' }],
      activeTabIndex: 0,
    },
    chat: {
      conversationId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      isLoading: true,
      messages: [
        {
          id: 'agent-queued-active-user',
          role: 'user',
          content: 'Inspect the workspace and summarize the current design.',
          createdAt: 1,
        },
      ],
      queuedMessages: [
        {
          id: 'agent-queued-first',
          content: 'Then identify the highest-risk unresolved issue.',
          createdAt: 2,
        },
        {
          id: 'agent-queued-second',
          content: 'Finally, propose the smallest safe next change.',
          createdAt: 3,
        },
        {
          id: 'agent-queued-third',
          content: 'Then list the verification evidence needed before landing.',
          createdAt: 4,
        },
      ],
    },
  };
}

export interface DevScenarioPreset {
  id: string;
  label: string;
  description: string;
  factory: () => AppScenario;
  aliases?: string[];
  referenceAssemblyId?: string;
  referenceSourcePath?: string;
  nativeContactProjection?: boolean;
  nativeComparisonProjection?: boolean;
  nativeExpressionTracks?: boolean;
  nativeOrdinaryExpression?: boolean;
  nativeDataLayerExample?: NativeDataLayerExample;

  indexedReference?: {
    preferredLocalAssemblyAccession: string;
    hostedCatalogId: string;
    expectedLengthBp: number;
  };

  hostedReferenceCatalogId?: string;

  hostedReferenceMode?: 'install' | 'metadata-shell';

  hostedReferenceShell?: {
    id: string;
    name: string;
    organism: string;
    taxId: number;
    assembly: string;
    annotationTrackTypes?: ReadonlyArray<string>;
    contigs: ReadonlyArray<{
      chrom: string;
      displayName: string;
      lengthBp: number;
      circular: boolean;
    }>;
  };

  trackViewComposition?: ComposeIndexedTrackViewInput;

  trackViewLocalSources?: Readonly<
    Record<string, Readonly<{ relativePath: string; sizeBytes: number; sha256: string }>>
  >;

  saveComposedTrackViewAs?: Readonly<{ id: string; createdAt: string }>;

  closeReferenceAfterTrackViewComposition?: boolean;

  noAutoReplay?: boolean;
  loadsAnnotationCatalogs?: boolean;

  ucscCatalogTracks?: ReadonlyArray<{
    readonly genome: string;
    readonly track: string;
    readonly hubUrl?: string;
  }>;

  projectLibrary?: Readonly<{
    closed?: readonly string[];
    archived?: readonly string[];
    trashed?: readonly string[];
  }>;
}

export interface DevScenarioPresetGroup {
  id: string;
  heading: string;
  presets: readonly DevScenarioPreset[];
}

export const DEV_SCENARIO_PRESET_GROUPS: readonly DevScenarioPresetGroup[] = [
  {
    id: 'agent-workflows',
    heading: 'Agent workflows',
    presets: [
      {
        id: 'agent-workflow-check',
        label: 'Agent workflow check',
        description:
          'A new local project with an editable sequence, human notes and strain records for trying native agent actions.',
        factory: agentWorkflowCheck,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'jobs',
    heading: 'Jobs',
    presets: [
      {
        id: 'jobs-annotation-workspace',
        label: 'jobsAnnotationWorkspace',
        description:
          'Fresh file-backed annotation workspace using the real execution owner and left sidebar.',
        factory: jobsAnnotationWorkspace,
        noAutoReplay: true,
      },
      {
        id: 'jobs-agent-actions-registry',
        label: 'jobsAgentActionsRegistry',
        description:
          'Deterministic Jobs presentation with a visible, independently owned long-running agent action.',
        factory: jobsAgentActionsRegistry,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'app-state',
    heading: 'App State',
    presets: [
      {
        id: 'typical',
        label: 'typicalSession',
        description: 'Ready + pUC19 + project',
        factory: typicalSession,
      },
      { id: 'fresh', label: 'freshSession', description: 'Fresh install', factory: freshSession },
      {
        id: 'editing',
        label: 'editingSession',
        description: 'pUC19 open, no project',
        factory: editingSession,
      },
      {
        id: 'downloading',
        label: 'downloadingSession',
        description: 'Downloading tools 50%',
        factory: downloadingSession,
      },
      { id: 'error', label: 'errorSession', description: 'Tools failed', factory: errorSession },
      {
        id: 'privacy-usage-analytics-on',
        label: 'privacyUsageAnalyticsOn',
        description:
          ' — Settings → Privacy with usage analytics and crash reports shared (opt-out regions by default)',
        factory: () => ({ usageAnalytics: { enabled: true } }),
        aliases: ['analytics', 'telemetry', 'consent'],
        noAutoReplay: true,
      },
      {
        id: 'privacy-usage-analytics-off',
        label: 'privacyUsageAnalyticsOff',
        description:
          ' — Settings → Privacy with sharing off (an opt-out, or an EU/UK/Swiss user before choosing)',
        factory: () => ({ usageAnalytics: { enabled: false } }),
        aliases: ['analytics', 'telemetry', 'consent', 'opt-in'],
        noAutoReplay: true,
      },
      {
        id: 'privacy-usage-analytics-unavailable',
        label: 'privacyUsageAnalyticsUnavailable',
        description: ' — Settings → Privacy where this window cannot report the telemetry choice',
        factory: () => ({ usageAnalytics: { enabled: null } }),
        aliases: ['analytics', 'telemetry', 'consent'],
        noAutoReplay: true,
      },
      {
        id: 'file-associations-showcase',
        label: 'fileAssociationsShowcase',
        description:
          ' — File Handling settings with GenBank owned by Preview and SnapGene owned by SnapGene',
        factory: () => ({
          fileAssociations: {
            openSettings: true,
            handlerStatuses: [
              {
                familyId: 'genbank',
                state: 'other',
                handlerName: 'Preview',
                handlerPath: '/System/Applications/Preview.app',
                defaultAction: 'native',
                detail: null,
              },
              {
                familyId: 'snapgene',
                state: 'other',
                handlerName: 'SnapGene',
                handlerPath: '/Applications/SnapGene.app',
                defaultAction: 'native',
                detail: null,
              },
            ],
          },
        }),
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'project-workflows',
    heading: 'Project Workflows',
    presets: [
      {
        id: 'recently-edited-reference-boundary',
        label: 'Recently edited — writable vs reference',
        description:
          ' — a writable root with an unknown future extension beside a pinned reference root whose fixture files must stay out of recent activity',
        factory: recentlyEditedReferenceBoundary,
        noAutoReplay: true,
      },
      {
        id: 'multi-project-roots',
        label: 'multiProjectRootsSession',
        description:
          'Two open project-style roots with sequence files and split tabs for project-specific root menu QA',
        factory: multiProjectRootsSession,
      },
      {
        id: 'paper-derived-protocol',
        label: 'paperDerivedProtocol',
        description:
          ' — a paper-derived protocol with exact source spans, a resolved Supplementary Table S3 reference, and an explicit cited-paper hole',
        factory: paperProtocolScenario,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'sequence-metadata',
    heading: 'Sequence metadata ',
    presets: [
      {
        id: 'sequence-package-metadata',
        label: 'sequencePackageMetadata',
        description:
          'Fresh Git workspace with a real pUC19 package opened by package identity and the sparse Metadata drawer visible.',
        factory: sequencePackageMetadata,
        aliases: ['dna-2242-metadata', 'sequence-metadata'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'empty-sequence-editor',
    heading: 'Empty DNA sequence ',
    presets: [
      {
        id: 'empty-sequence-caret',
        label: 'Empty sequence — blinking cursor',
        description: '2D-only editor with a blinking cursor and no explanatory copy',
        factory: () => emptySequenceEntryShowcase('caret'),
        noAutoReplay: true,
      },
      {
        id: 'empty-sequence-rows',
        label: 'Empty sequence — two rows',
        description: 'Caret plus an active first sequence row and muted second row',
        factory: () => emptySequenceEntryShowcase('rows'),
        noAutoReplay: true,
      },
      {
        id: 'empty-sequence-hint',
        label: 'Empty sequence — typing hint',
        description: 'Caret plus one quiet Start typing instruction',
        factory: () => emptySequenceEntryShowcase('hint'),
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'chat',
    heading: 'Chat',
    presets: [
      {
        id: 'chat-message-rendering-showcase',
        label: 'chatMessageRenderingShowcase',
        description:
          ' +  — literal user Markdown beside a rich assistant restriction-digest table for manual rendering and containment review',
        factory: chatMessageRenderingShowcase,
        noAutoReplay: true,
      },
      {
        id: 'agent-inline-approval-showcase',
        label: 'agentInlineApprovalShowcase',
        description:
          ' — destructive shell approval shown inside the chat flow with the composer and chat chrome left accessible',
        factory: agentInlineApprovalShowcase,
        noAutoReplay: true,
      },
      {
        id: 'agent-structured-question-showcase',
        label: 'agentStructuredQuestionShowcase',
        description:
          ' — provider-neutral single choice, multi-choice, defaults, and free-text question card in live chat chrome',
        factory: agentStructuredQuestionShowcase,
        aliases: ['agent-question', 'dna-2565-question'],
        noAutoReplay: true,
      },
      {
        id: 'agent-queued-messages-showcase',
        label: 'agentQueuedMessagesShowcase',
        description:
          ' — active chat with three visible FIFO messages, per-row advance controls, and the inline Pause control',
        factory: agentQueuedMessagesShowcase,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'notebook-references',
    heading: 'Notebook references',
    presets: [
      {
        id: 'notebook-content-extensions',
        label: 'notebookContentExtensionsSession',
        description:
          ' — a supported rich table beside a preserved future-version table using the safe compatibility fallback',
        factory: notebookContentExtensionsSession,
        noAutoReplay: true,
      },
      {
        id: 'legacy-reference-repair',
        label: 'legacyReferenceRepairWorkspace',
        description:
          ' — a workspace that is ALREADY BROKEN: real CIDAR parts at packaged paths, a notebook whose chips point at the old flat paths. Open the notebook to watch the one-time repair make three dead links work. PROOF.md has the walkthrough.',
        factory: legacyReferenceRepairWorkspace,
        aliases: ['legacy-repair', 'notebook-reference-repair'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'projects',
    heading: 'Projects',
    presets: [
      {
        id: 'manage-projects-library',
        label: 'Project library: closed, archived, trashed',
        description:
          ' — creates real empty projects: 2 closed (not open in Files), 2 archived, 1 in Trash. Then open the project menu in the Files header to see every section and try Restore / Delete now / New project.',
        factory: () => ({ dev: { scenarioId: 'fixture-manage-projects-library' } }),
        projectLibrary: {
          closed: ['Closed project A', 'Closed project B'],
          archived: ['Archived project A', 'Archived project B'],
          trashed: ['Trashed project'],
        },
        aliases: ['project-library', 'archived-projects'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'primer-workflows',
    heading: 'Primer workflows',
    presets: [
      {
        id: 'agent-scientific-authoring',
        label: 'Agent scientific authoring',
        description:
          'Two native sequence projects for assembly, oligo and notebook authoring, including distinct pUC19 clones with the same name.',
        factory: agentScientificAuthoringWorkspace,
        noAutoReplay: true,
      },
      {
        id: 'primer-file-authority',
        label: 'primerFileAuthorityWorkspace',
        description:
          ' — fresh Git workspace with real pUC19 and PROOF.md for file, registry, relationship, and history verification',
        factory: primerFileAuthorityWorkspace,
        aliases: ['primer-proof', 'primer-file-authority-workspace'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'linear-genome-viewer',
    heading: 'Linear genome viewer',
    presets: [
      {
        id: 'complete-mg1655-linear',
        label: 'Complete MG1655 — linear',
        description:
          'Complete 4,641,652 bp E. coli MG1655 opened through the real file path and forced into the ordinary linear WebGL view. Zoom in and out to inspect forward/reverse strand spacing.',
        factory: completeMg1655Linear,
        aliases: ['mg1655-linear', 'strand-spacing-linear'],
        noAutoReplay: true,
      },
      MG1655_ANNOTATION_CATALOG_PRESET,
    ],
  },
  {
    id: 'recoded-genes',
    heading: 'Recoded genes ',
    presets: [
      {
        id: 'is3-slip',
        label: 'is3TransposaseMinusOneSlip',
        description:
          'THE TEST CASE — E. coli W3110 IS3 transposase, join(314515..314776,314776..315677). A -1 programmed frameshift: base 314776 is READ TWICE. Predicted broken: the intron guard only cancels an abutting junction, so a 1-base overlap falls into the origin-spanning branch and fabricates a ~4.6 Mb intron across the whole chromosome.',
        factory: is3TransposaseMinusOneSlip,
        noAutoReplay: true,
      },
      {
        id: 'nrdfb-group-i-intron',
        label: 'nrdFBGroupIIntron',
        description:
          'THE CONTROL — B. subtilis 168 nrdFB, an 808 bp group I (self-splicing) intron in the SPbeta prophage. A real bacterial intron, no /ribosomal_slippage. Expected to render CORRECTLY today. If this one is also broken, the diagnosis is wrong.',
        factory: nrdFBGroupIIntron,
        noAutoReplay: true,
      },
      {
        id: 'prfb-plus-one-skip',
        label: 'prfBPlusOneSkip',
        description:
          'B. subtilis 168 prfB, join(3627139..3628167,3628169..3628240) — a +1 frameshift, base 3628168 SKIPPED. Same biology as the E. coli prfB in the ticket. Renders as a 1 bp "intron": visually near-invisible, semantically wrong.',
        factory: prfBPlusOneSkip,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'demo',
    heading: 'Demo',
    presets: [
      {
        id: 'assembly-demo',
        label: 'assemblyDemoWorkspace',
        description:
          ' — NCBI-derived nonviral plasmids (pEGFP-N1, pTRE, synthetic pUC19-DsRed, pACYC177, pUC19) + README catalog + ready AI chat. Agent extracts regions from the FULL plasmids to build constructs on a prompt.',
        factory: assemblyDemoWorkspace,
        noAutoReplay: true,
      },
      {
        id: 'demo',
        label: 'demoSession',
        description: 'pDEMO035 - incomplete annotations (pLannotate showcase)',
        factory: demoSession,
      },
    ],
  },
  {
    id: 'import',
    heading: 'Import',
    presets: [
      {
        id: 'import-readiness-review',
        label: 'Import review — real DNA files',
        description:
          'Real SnapGene and SGD DNA, two fresh projects, file selection and DNA-type confirmation. Confirm performs the real import.',
        factory: importReadinessReview,
        aliases: ['dna-3336-import-review'],
        noAutoReplay: true,
      },
      {
        id: 'import-wizard-showcase',
        label: 'importWizardShowcase',
        description:
          ' — opens the import wizard with a diverse item set (every bucket + a folder + skip/collision dedup states) so the grouped ledger, collapse, and per-group "→ destination" assignment can be tested in one click. Synthetic paths (great for the UI; drag real files to test the actual copy).',
        factory: importWizardShowcaseScenario,
        noAutoReplay: true,
      },
      {
        id: 'tabular-import-showcase',
        label: 'tabularImportShowcase',
        description:
          ' Phase 1 tier-2 — resets the registry, seeds 4 link-target plasmids, and opens the stepped tabular→registry wizard on the 34-strain fixture. One click drives Resolve ("1 ready · 0 need you") → Review ("34 register · 0 duplicate") → Confirm (+34 into the registry) → the persistent Undo toast (+0).',
        factory: () => ({ tabularImportShowcase: true }),
        noAutoReplay: true,
      },
      {
        id: 'hanging-refs-showcase',
        label: 'hangingRefsShowcase',
        description:
          ' — resets the registry, then imports strains that reference parents by name to produce a hanging reference in EACH state: OPEN (parent never imported), DRAFT (one matching parent → Connect), AMBIGUOUS (two strains named "Backbone" → pick one). Opens the LIMS panel so you can Connect / Not-this / Dismiss / Restore and watch each reference resolve.',
        factory: () => ({ hangingRefsShowcase: true }),
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'tabular-files',
    heading: 'Tabular files',
    presets: [
      {
        id: 'tabular-csv-crash-repro',
        label: 'tabularCsvCrashRepro',
        description:
          ' repro harness — opens quoted-samples.csv in the editable table tab. The reported crash gesture: double-click a column label to rename it → Save → open Find, search, close it → toggle "First row is headers" OFF then back ON → click a data cell. That click was reported to kill the renderer. Does NOT reproduce as of 2026-07-30 (5/5 clean local runs); the original evidence was Linux CI and this is macOS, so a second pair of eyes is real information.',
        factory: tabularCsvCrashRepro,
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'alignments',
    heading: 'Alignments',
    presets: [
      {
        id: CDS_MUTATION_GALLERY_ID,
        label: 'Final CDS mutations · 29 cases',
        description:
          'Final proteins recomputed from the mutated DNA, with gray unchanged residues and distinct mutation colors across substitutions, insertions, deletions, frame changes and stops.',
        factory: cdsMutationGallery,
      },
      {
        id: 'alignment-stale-session',
        label: 'staleAlignmentSession',
        description: 'Sequence tab + stale alignment session + mutation review state',
        factory: staleAlignmentSession,
      },
      {
        id: 'sequence-package-attach-two-clones',
        label: 'sequencePackageAttachTwoClones',
        description:
          ' — runs the real Alignments attach path on a format-4 package: two same-basename clone-1.fasta files become contents/clone-1.fasta + contents/clone-1-2.fasta and appear as clone rows. Drawer opens.',
        factory: sequencePackageAttachTwoClones,
        aliases: ['dna-2229-attach', 'package-attach'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'cut-sites',
    heading: 'Cut sites',
    presets: [
      {
        id: 'cut-site-homing-endo',
        label: 'cutSiteHomingEndoSession',
        description:
          'pUC19 + I-CeuI / I-SceI / PI-PspI / PI-SceI engineered sites; all 4 enzymes pre-active ',
        factory: cutSiteHomingEndoSession,
      },
    ],
  },
  {
    id: 'lims',
    heading: 'LIMS',
    presets: [
      {
        id: 'lims-primer-csv-import',
        label: 'limsPrimerCsvImportScenario',
        description: 'Imports wp-assets primers-alt-headers.csv as registered oligo entities',
        factory: limsPrimerCsvImportScenario,
        aliases: ['lims-primer-csv', 'primer-csv-import'],
      },
      {
        id: 'lims-messy-primer-csv-import',
        label: 'limsMessyPrimerCsvImportScenario',
        description: 'Opens a primer order sheet with many source-only provenance columns',
        factory: limsMessyPrimerCsvImportScenario,
        aliases: ['lims-messy-primer-csv', 'messy-primer-csv-import'],
      },
      {
        id: 'lims-headerless-primer-tsv-import',
        label: 'limsHeaderlessPrimerTsvScenario',
        description: 'Imports raw no-header wp-assets primers.tsv as registered oligo entities',
        factory: limsHeaderlessPrimerTsvScenario,
        aliases: ['lims-headerless-primer-tsv', 'raw-primer-tsv'],
      },
    ],
  },
  {
    id: 'structure-drawer',
    heading: 'Structure drawer ',
    presets: [
      {
        id: 'structure-thrl',
        label: 'structureThrLSession',
        description:
          'MG1655 thrL with full xref qualifier surface (UniProt P0AD86, GeneID, taxon). Right-click -> View Structure exercises the  sidecar resolver chain end-to-end.',
        factory: structureThrLSession,
      },
    ],
  },
  {
    id: 'real-assembly-pipeline',
    heading: 'Real assembly pipeline',
    presets: [
      {
        id: 'real-assembly-many-tabs',
        label: 'realAssemblyManyTabs',
        description:
          '8 drafted assembly tabs, MIDDLE one active . Close the middle tab: sibling tabs must not flicker, blank, or lose scroll position, and closing the 8th must feel identical to closing the 2nd. Middle is deliberate — closing the LAST tab shifts no portal indices and was never the slow case.',
        factory: realAssemblyManyTabs,
      },
      {
        id: 'real-assembly-many-tabs-stress',
        label: 'realAssemblyManyTabsStress',
        description:
          '11 drafted assembly tabs — same check as realAssemblyManyTabs, at the top of the fixture pool. Use this to confirm close cost does not scale with tab count.',
        factory: realAssemblyManyTabsStress,
      },
      {
        id: 'assembly-cut-gene-across-junction',
        label: 'assemblyCutGeneAcrossJunction',
        description: 'pUC19 fragment ends inside AmpR; frame continues past the junction',
        factory: assemblyCutGeneAcrossJunctionScenario,
      },
      {
        id: 'cds-extension-stop-just-past-origin',
        label: 'cdsExtensionStopJustPastOrigin',
        description:
          'Synthetic 300 bp circle. The CDS ends on the last base and its frame stops at bases 7..9 — entirely past the origin, with the join falling cleanly between two codons rather than through one.',
        factory: cdsExtensionStopJustPastOriginScenario,
      },
      {
        id: 'cds-extension-stop-far-past-origin',
        label: 'cdsExtensionStopFarPastOrigin',
        description:
          'Synthetic 900 bp circle. The frame runs a hundred codons past the origin before stopping at 301..303, so the extension adds a third of the molecule — the case that catches anything capped at a codon or two past the end.',
        factory: cdsExtensionStopFarPastOriginScenario,
      },
      {
        id: 'cds-extension-origin-span',
        label: 'cdsExtensionOriginSpan',
        description:
          'pUC19 with a CDS ending on its last base whose frame finishes past the origin — extending it produces an origin-spanning CDS (end below start), not a coordinate off the end of the molecule',
        factory: cdsExtensionOriginSpanScenario,
      },
      {
        id: 'cds-extension-incomplete-cds',
        label: 'cdsExtensionIncompleteCds',
        description:
          'pUC19 sequence tab whose AmpR CDS is clipped in frame at both ends — grey arrows appear on either side of the chevrons; hover one to preview the rest of the frame, click to pin it, right-click the grey codons to commit',
        factory: cdsExtensionIncompleteCdsScenario,
      },
      {
        id: 'real-assembly-gibson-pcr-pcr',
        label: 'realAssemblyGibsonPcrPcr',
        description: 'pUC19 Gibson PCR/PCR draft',
        factory: realAssemblyGibsonPcrPcr,
      },
      {
        id: 'real-assembly-gibson-pcr-pcr-spacer',
        label: 'realAssemblyGibsonPcrPcrSpacer',
        description: 'pUC19 Gibson PCR/PCR draft with real spacer',
        factory: realAssemblyGibsonPcrPcrSpacer,
      },
      {
        id: 'real-assembly-gibson-pcr-pcr-spacer-finalization',
        label: 'realAssemblyGibsonPcrPcrSpacerFinalization',
        description:
          'File-backed Git workspace with a ready pUC19 Gibson assembly for preview/finalize/reopen testing',
        factory: realAssemblyGibsonPcrPcrSpacerFinalization,
        noAutoReplay: true,
      },
      {
        id: 'real-assembly-gibson-pcr-rd-pcr',
        label: 'realAssemblyGibsonPcrRdPcr',
        description: 'pUC19 Gibson PCR/RD/PCR draft',
        factory: realAssemblyGibsonPcrRdPcr,
      },
      {
        id: 'real-assembly-gibson-pcr-rd-pcr-two-spacers',
        label: 'realAssemblyGibsonPcrRdPcrTwoSpacers',
        description: 'pUC19 Gibson PCR/RD/PCR draft with two real spacers',
        factory: realAssemblyGibsonPcrRdPcrTwoSpacers,
      },
      {
        id: 'real-assembly-gibson-rd-5prime-pcr',
        label: 'realAssemblyGibsonRd5PrimePcr',
        description: "pUC19 Gibson EcoRI 5' RD/PCR chewback",
        factory: realAssemblyGibsonRd5PrimePcr,
      },
      {
        id: 'real-assembly-gibson-rd-spacer-pcr',
        label: 'realAssemblyGibsonRdSpacerPcr',
        description: 'pUC19 Gibson BsmBI RD/PCR draft with real spacer',
        factory: realAssemblyGibsonRdSpacerPcr,
      },
      {
        id: 'real-assembly-gibson-rd-3prime-pcr',
        label: 'realAssemblyGibsonRd3PrimePcr',
        description: "pUC19 Gibson PstI 3' RD/PCR retained scar",
        factory: realAssemblyGibsonRd3PrimePcr,
      },
      {
        id: 'real-assembly-gibson-rd-blunt-pcr',
        label: 'realAssemblyGibsonRdBluntPcr',
        description: 'pUC19 Gibson SmaI blunt RD/PCR',
        factory: realAssemblyGibsonRdBluntPcr,
      },
      {
        id: 'real-assembly-gibson-rd-rd-invalid',
        label: 'realAssemblyGibsonRdRdInvalid',
        description: 'pUC19 Gibson invalid adjacent RD/RD preflight',
        factory: realAssemblyGibsonRdRdInvalid,
      },
      {
        id: 'real-assembly-nebuilder-rd-spacer',
        label: 'realAssemblyNebuilderRdSpacer',
        description: 'pUC19 NEBuilder RD/PCR draft with real spacer',
        factory: realAssemblyNebuilderRdSpacer,
      },
      {
        id: 'real-assembly-nebuilder-rd-rd-invalid',
        label: 'realAssemblyNebuilderRdRdInvalid',
        description: 'pUC19 NEBuilder invalid adjacent RD/RD preflight',
        factory: realAssemblyNebuilderRdRdInvalid,
      },
      {
        id: 'assembly-ui-cleanup-showcase',
        label: 'assemblyUiCleanupShowcase',
        description:
          ' drawer cleanup on a real pUC19 Golden Gate draft. Click a boundary between parts to inspect the named PCR paste action and specific empty-part issue.',
        factory: assemblyUiCleanupShowcase,
      },
      {
        id: 'assembly-crossover-editing-showcase',
        label: 'assemblyCrossoverEditingShowcase',
        description:
          ' technical four-part pUC19 PCR fixture for selecting a provenance arc and dragging both source-crossover boundaries in the WebGL map.',
        factory: assemblyCrossoverEditingShowcase,
      },
      {
        id: 'cidar-moclo-red-fluorescent-tu',
        label: 'cidarMocloRedFluorescentTu',
        description:
          'Real CIDAR BsaI assembly: J23106 promoter, B0034m RBS, E1010m mRFP, and B0015 terminator into the DVA_AE destination backbone. Fusion sites enforce A-B-C-D-E order.',
        factory: cidarMocloRedFluorescentTu,
      },
      {
        id: 'cidar-moclo-mixed-route-red-fluorescent-tu',
        label: 'cidarMocloMixedRouteRedFluorescentTu',
        description:
          'The real CIDAR red transcription unit with J23106 and E1010m produced by PCR while B0034m, B0015, and DVA_AE remain BsaI digest fragments.',
        factory: cidarMocloMixedRouteRedFluorescentTu,
      },
      {
        id: 'ytk-moclo-factory-expression-cassette',
        label: 'ytkMocloFactoryExpressionCassette',
        description:
          'Real YTK hierarchical factory with a 96-member versioned kit definition. Opens the BsaI expression-cassette stage with pYTK009, pYTK033, pYTK051, and pYTK096.',
        factory: ytkMocloFactoryExpressionCassette,
        noAutoReplay: true,
      },
      {
        id: 'real-assembly-goldengate-pcr-pcr',
        label: 'realAssemblyGoldenGatePcrPcr',
        description: 'pUC19 Golden Gate PCR/PCR draft',
        factory: realAssemblyGoldenGatePcrPcr,
      },
      {
        id: 'real-assembly-goldengate-pcr-pcr-spacer',
        label: 'realAssemblyGoldenGatePcrPcrSpacer',
        description: 'pUC19 Golden Gate PCR/PCR draft with real spacer',
        factory: realAssemblyGoldenGatePcrPcrSpacer,
      },
      {
        id: 'real-assembly-goldengate-pcr-rd-pcr',
        label: 'realAssemblyGoldenGatePcrRdPcr',
        description: 'pUC19 Golden Gate PCR/RD/PCR fixed-overhang warning',
        factory: realAssemblyGoldenGatePcrRdPcr,
      },
      {
        id: 'real-assembly-goldengate-rd-enzyme-mismatch-invalid',
        label: 'realAssemblyGoldenGateRdEnzymeMismatchInvalid',
        description: 'pUC19 Golden Gate rejects BsmBI RD fragment under BsaI',
        factory: realAssemblyGoldenGateRdEnzymeMismatchInvalid,
      },
      {
        id: 'real-assembly-goldengate-internal-site',
        label: 'realAssemblyGoldenGateInternalSite',
        description: 'pUC19 Golden Gate invalid internal-site warning',
        factory: realAssemblyGoldenGateInternalSite,
      },
    ],
  },
  {
    id: 'sanger-direct',
    heading: 'Sanger Fixtures - direct .ab1 (path 1)',
    presets: [
      {
        id: 'sanger-clean-fwd',
        label: 'sangerCleanFwdSession',
        description: 'Clean forward read (~99.8% id, 1 gap)',
        factory: sangerCleanFwdSession,
      },
      {
        id: 'sanger-clean-rc',
        label: 'sangerCleanRcSession',
        description: 'Clean reverse-complement (~99.9% id, 0 gaps)',
        factory: sangerCleanRcSession,
      },
      {
        id: 'sanger-rc-indels',
        label: 'sangerRcWithIndelsSession',
        description: 'RC w/ small indels (2 gaps)',
        factory: sangerRcWithIndelsSession,
      },
      {
        id: 'sanger-het',
        label: 'sangerHeterozygousSession',
        description: 'Mixed peaks (>30 mixed-call peaks)',
        factory: sangerHeterozygousSession,
      },
      {
        id: 'sanger-failed',
        label: 'sangerFailedSession',
        description: 'Failed read (Phred ~16)',
        factory: sangerFailedSession,
      },
    ],
  },
  {
    id: 'sanger-attached',
    heading: 'Sanger Fixtures - attached to reference (path 2)',
    presets: [
      {
        id: 'sanger-attached-clean-fwd',
        label: 'sangerAttachedCleanFwdSession',
        description: 'clean-fwd -> its reference (99.77% id, fwd)',
        factory: sangerAttachedCleanFwdSession,
      },
      {
        id: 'sanger-attached-clean-rc',
        label: 'sangerAttachedCleanRcSession',
        description: 'clean-rc -> its reference (99.89% id, RC)',
        factory: sangerAttachedCleanRcSession,
      },
      {
        id: 'sanger-attached-rc-indels',
        label: 'sangerAttachedRcWithIndelsSession',
        description: 'rc-with-indels -> its reference (99.17% id, RC + 2 gaps)',
        factory: sangerAttachedRcWithIndelsSession,
      },
      {
        id: 'sanger-attached-het',
        label: 'sangerAttachedHeterozygousSession',
        description: 'heterozygous -> its reference (mixed peaks, ~98% id)',
        factory: sangerAttachedHeterozygousSession,
      },
      {
        id: 'sanger-attached-failed',
        label: 'sangerAttachedFailedSession',
        description: 'failed-low-quality -> its reference (Phred ~16, ~30% aligns)',
        factory: sangerAttachedFailedSession,
      },
      {
        id: 'sanger-attached-origin-spanning',
        label: 'sangerAttachedOriginSpanningSession',
        description:
          'clean-fwd -> its reference rotated by 10000 bp (origin-spanning; bridge code does doubled-ref alignment + splits into two stacked lanes pending ',
        factory: sangerAttachedOriginSpanningSession,
      },
      {
        id: 'sanger-attached-multi-read',
        label: 'sangerAttachedMultiReadSession',
        description:
          'Same .ab1 attached TWICE with different read ids -> two stacked chromatogram lanes; tests overlay dedup namespacing',
        factory: sangerAttachedMultiReadSession,
      },
    ],
  },
  {
    id: 'annotation-assembly-pileup',
    heading: 'Assembly tracks',
    presets: [
      {
        id: 'native-aligned-genomes',
        label: 'Aligned genomes · native synteny',
        description:
          'Exact E. coli and Shigella genome alignment with CIGAR gaps, reverse blocks and unaligned joins in the existing indexed canvas.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeComparisonProjection: true,
        noAutoReplay: true,
      },
      {
        id: 'native-contact-matrix',
        label: 'Chromosome contacts · native matrix',
        description:
          'Measured chromosome contacts on exact U00096.2 genomic axes in the normal indexed viewer. Pan both axes, zoom, and select a measured bin pair.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes/U00096.2-contacts',
        nativeContactProjection: true,
        noAutoReplay: true,
      },
      {
        id: 'native-expression-tracks',
        label: 'Expression samples · native tracks',
        description:
          'Real PRECISE expression conditions in the existing indexed track rows and settings.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeExpressionTracks: true,
        noAutoReplay: true,
      },
      {
        id: 'genome-markup-indexed',
        label: 'Shared genome markup · indexed reference',
        description: 'Real expression measurements in the native indexed track owner.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeExpressionTracks: true,
        noAutoReplay: true,
      },
      {
        id: 'genome-markup-ordinary',
        label: 'Shared genome markup · ordinary sequence',
        description:
          'The same measurements on a real 17 kb MG1655 locus in the normal sequence viewer.',
        factory: () => ({ laneContract: {} }),
        nativeOrdinaryExpression: true,
        noAutoReplay: true,
      },
      {
        id: 'native-crispri-guides',
        label: 'CRISPRi · guide growth effects',
        description:
          '820 exact guide-sequence placements on NC_000913.3 with measured growth effects and a signed color scale.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeDataLayerExample: 'crispri',
        noAutoReplay: true,
      },
      {
        id: 'native-regulatory-sites',
        label: 'RegulonDB · binding sites',
        description:
          '176 sequence-verified regulatory sites in native interval lanes. Site widths describe genomic extent.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeDataLayerExample: 'regulondb',
        noAutoReplay: true,
      },
      ...(['araAB', 'arcA', 'groSL', 'aphA'] as const).map((gene) => ({
        id: `native-regseq-${gene}`,
        label: `RegSeq · ${gene} promoter footprint`,
        description:
          'Two measured conditions on the supplied 160-base promoter fragment, using a shared signed scale and the normal sequence viewer.',
        factory: () => ({ laneContract: {} }),
        nativeDataLayerExample: `regseq-${gene}` as const,
        noAutoReplay: true,
      })),
      {
        id: 'native-rna-reactivity',
        label: 'RNA · SHAPE and paired bases',
        description:
          'Measured reactivity and supplied base-pair arcs on the same 432-base RNA sequence. Missing measurements remain missing.',
        factory: () => ({ laneContract: {} }),
        nativeDataLayerExample: 'shape-rpsT_5',
        noAutoReplay: true,
      },
      ...(
        [
          [
            '01-tradis',
            'Transposon · gene insertion indices',
            'BW25113 gene-level insertion indices transferred by exact gene identity to MG1655 annotations. Unmatched and repeated source genes remain excluded. These are gene summaries.',
          ],
          [
            '02-chemical-genetics',
            'Mutant fitness · condition matrix',
            'Published growth scores across 21 conditions, mapped by exact ECK aliases to MG1655 genes. Missing scores remain missing.',
          ],
          [
            '06-proteome',
            'Proteome · condition matrix',
            'BW25113 protein abundance across 22 conditions, transferred by verified protein-to-gene identities onto MG1655 annotations.',
          ],
          [
            '17-conservation',
            'Gene states · matched subset',
            'Published states across 21 strains for the uniquely matched subset of a pseudogene-enriched source table. Foreign-reference coordinates are excluded.',
          ],
        ] as const
      ).map(([id, label, description]) => ({
        id: `native-${id}`,
        label,
        description,
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes',
        nativeDataLayerExample: id,
        noAutoReplay: true,
      })),
      ...(
        [
          [
            '05-ribosome-profiling',
            'Ribosome profiling · exact source genome',
            'Two conditions on NC_000913.2. Empty source bins remain missing; density is the reported read contribution divided by bin width.',
          ],
          [
            '08-tss-coverage',
            'RNA starts · coverage and TSS points',
            'Strand coverage and published expression step heights on exact NC_000913.2, with independently verified TSS sequence anchors.',
          ],
          [
            '14-supercoiling',
            'Chromosome topology · condition matrix',
            'Stationary and exponential psoralen crosslinking signals on NC_000913.2. Values describe published signal ratios.',
          ],
        ] as const
      ).map(([id, label, description]) => ({
        id: `native-${id}`,
        label,
        description,
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes/native-references/NC_000913.2',
        nativeDataLayerExample: id,
        noAutoReplay: true,
      })),
      {
        id: 'native-09-termseq',
        label: 'RNA ends · three measured replicates',
        description:
          '118 sequence-anchored positions and three read-count replicates on exact CP009273.1. Original endpoint conventions and their limitations are retained with the source.',
        factory: () => ({ laneContract: {} }),
        referenceSourcePath: 'test-fixtures/genome-view-prototypes/native-references/CP009273.1',
        nativeDataLayerExample: '09-termseq',
        noAutoReplay: true,
      },
      {
        id: 'indexed-mg1655-reference',
        label: 'Indexed MG1655 reference',
        description:
          'Open the exact GCF_000005845.2 E. coli K-12 MG1655 indexed reference. ' +
          'Uses the local custom import when present and the matching hosted source ' +
          'otherwise, with the same zoomable annotation renderer in both paths.',
        factory: () => ({ laneContract: {} }),
        indexedReference: {
          preferredLocalAssemblyAccession: 'GCF_000005845.2',
          hostedCatalogId: 'ecoliK12Mg1655',
          expectedLengthBp: 4_641_652,
        },
        aliases: ['mg1655-indexed', 'ecoli-indexed-reference', 'custom-reference-mg1655'],
        noAutoReplay: true,
      },
      {
        id: POWNALL_FIGURE_4N_PRESET_ID,
        label: 'Pownall Figure 4N — saved view',
        description:
          'Open the saved GRCz11/danRer11 Figure 4N view at klf17 with all four complete published BigWigs and their saved presentation settings.',
        factory: pownallFigure4NShowcaseScenario,
        hostedReferenceCatalogId: POWNALL_FIGURE_4N_REFERENCE_ID,
        hostedReferenceMode: 'metadata-shell',
        hostedReferenceShell: POWNALL_FIGURE_4N_REFERENCE_SHELL,
        trackViewComposition: POWNALL_FIGURE_4N_COMPOSITION,
        trackViewLocalSources: POWNALL_FIGURE_4N_LOCAL_SOURCES,
        saveComposedTrackViewAs: {
          id: 'track-view-pownall-2023-figure-4n',
          createdAt: '2023-07-07T00:00:00.000Z',
        },
        closeReferenceAfterTrackViewComposition: true,
        aliases: ['figure-4n', 'pownall-figure-4n', 'klf17-four-track-view'],
        noAutoReplay: true,
      },
      {
        id: 'assembly-grch38-ucsc-tracks',
        label: 'GRCh38 + Add data',
        description:
          'FULL GRCh38 assembly (all 24 chromosomes) ready for hand-driven local ' +
          'BAM/CRAM/BigWig attachment, direct BigWig URLs, public CpG/search results, ' +
          'and ENCODE signals. Click Add data in the left gutter.',
        factory: () => ({
          laneContract: { assemblyId: 'grch38', activeDatasets: [] },
        }),
        referenceAssemblyId: 'grch38',
        aliases: ['grch38-ucsc', 'ucsc-track-loading'],
        noAutoReplay: true,
      },
      {
        id: 'ucsc-catalog-folders-and-facets',
        label: 'Public catalog: full table',
        description:
          'FULL GRCh38. Click Add data in the left gutter to browse the whole ' +
          'catalog as a table. (1) Search H3K27ac, then choose Signal and Organ ' +
          'brain in the sidebar. (2) Click a column heading to sort every match; ' +
          'click its magnifier to filter, or drag its divider to resize. ' +
          '(3) Open Columns to show published metadata such as Organ, Data type, ' +
          'Factor, or donor identifiers. Column filters combine with the search ' +
          'and sidebar choices. (4) Clear the filters and search GENCODE: ' +
          'releases share a row, and Release chooses the edition that Add ' +
          'attaches. (5) Scroll continuously through results or search for CpG Islands ' +
          'and add it. Reopening and adding it again keeps one track.',
        factory: () => ({
          laneContract: { assemblyId: 'grch38', activeDatasets: [] },
        }),
        referenceAssemblyId: 'grch38',
        aliases: ['ucsc-folders', 'ucsc-facets', 'full-table', 'ucsc-catalog-table'],
        noAutoReplay: true,
      },
      {
        id: 'ucsc-native-gene-models',
        label: 'UCSC tables: gene models',
        description:
          'FULL GRCh38 with Genscan Genes and AUGUSTUS attached and already loaded. ' +
          'UCSC serves both from its own database rather than as downloadable ' +
          'files, so both were refused outright before. Each paints as gene models ' +
          'with exon blocks joined by thin introns, never as solid rectangles: ' +
          'Genscan carries 41,025 genes drawn as 588,345 separate exon blocks, ' +
          'AUGUSTUS 30,257 genes as 695,161 blocks, and neither drops a record. ' +
          'Zoom into a gene to see its exon structure, then to individual bases ' +
          'for coding chevrons and amino-acid letters read from the reference DNA. In Add data ' +
          'both list as "Gene model" on a "UCSC table".',
        factory: () => ({
          laneContract: { assemblyId: 'grch38', activeDatasets: [] },
        }),
        referenceAssemblyId: 'grch38',
        ucscCatalogTracks: [
          { genome: 'hg38', track: 'genscan' },
          { genome: 'hg38', track: 'augustusGene' },
        ],
        aliases: ['ucsc-genepred', 'native-gene-models'],
        noAutoReplay: true,
      },
      {
        id: 'ucsc-native-encode-peaks',
        label: 'UCSC tables: ENCODE peak calls',
        description:
          'FULL GRCh38 with two ENCODE transcription-factor ChIP-seq peak tracks ' +
          'attached: POLR2A and CTCF, both measured in vagina tissue. UCSC serves ' +
          'these from its own tables, and all 1,351 of them were refused before. ' +
          'POLR2A carries 14,389 peaks and CTCF 17,256, and each paints at a height ' +
          'that follows its measured signal rather than a flat block. Add data ' +
          'lists both as "Peaks" on a "UCSC table" with cellType vagina and factor ' +
          'chips. The two factors land in different places, which is the point: ' +
          'CTCF is punctate and spread across the genome, POLR2A piles up at gene ' +
          'starts.',
        factory: () => ({
          laneContract: { assemblyId: 'grch38', activeDatasets: [] },
        }),
        referenceAssemblyId: 'grch38',
        ucscCatalogTracks: [
          { genome: 'hg38', track: 'encTfChipPkENCFF635MUK' },
          { genome: 'hg38', track: 'encTfChipPkENCFF579GUD' },
        ],
        aliases: ['ucsc-peaks', 'encode-peaks'],
        noAutoReplay: true,
      },
      {
        id: 'ucsc-publisher-signal-range',
        label: "UCSC signal: the publisher's own range",
        description:
          'FULL GRCh38 with GC Percent attached. UCSC declares this track should be ' +
          "drawn against 30 to 70, so it opens on the publisher's range instead of " +
          'one computed from the data. Click the gear on the GC Percent row: under ' +
          'Signal scale, Range reads "Fixed range", Minimum 30 and Maximum 70. ' +
          'Nothing in the app picks those numbers; they are what the hub declared. ' +
          'The drawn axis tops out at 70 while the loaded data never exceeds 56.2, ' +
          'which is the tell, because a computed axis would stop near 56. The fill ' +
          'still starts at 0 since a filled histogram keeps a zero baseline. Change ' +
          'Range to "Stable whole track" and the axis moves, which shows the ' +
          'declared range seeds the track rather than locking it.',
        factory: () => ({
          laneContract: { assemblyId: 'grch38', activeDatasets: [] },
        }),
        referenceAssemblyId: 'grch38',
        ucscCatalogTracks: [{ genome: 'hg38', track: 'gc5BaseBw' }],
        aliases: ['ucsc-viewlimits', 'publisher-signal-range'],
        noAutoReplay: true,
      },
      {
        id: 'assembly-grch38-genomewide-pileup',
        label: 'grch38GenomeWidePileup',
        description:
          'FULL GRCh38 assembly (all 24 chromosomes) + WGS pileup streamed per-chrom ' +
          'from a remote whole-genome BAM. Open, then deep-zoom into ANY chromosome.',
        factory: grch38GenomeWidePileup,
        referenceAssemblyId: 'grch38',
        aliases: ['grch38-genomewide-pileup', 'full-genome-pileup'],
      },
      {
        id: 'assembly-grch38-local-na12718-cram',
        label: 'grch38GenomeWideLocalNA12718Cram',
        description:
          'FULL GRCh38 assembly + WGS pileup from the LOCAL NA12718 30× CRAM (all ' +
          'chromosomes, decoded against the local GRCh38 reference). The lighter ' +
          'pressure-test for full-genome read streaming — get this buttery first.',
        factory: grch38GenomeWideLocalNA12718Cram,
        referenceAssemblyId: 'grch38',
        aliases: ['grch38-local-na12718-cram', 'full-genome-na12718'],
        noAutoReplay: true,
      },
      {
        id: 'assembly-grch38-local-hg002-80x',
        label: 'grch38GenomeWideLocalHg002_80x',
        description:
          'FULL GRCh38 assembly + WGS pileup from the LOCAL HG002 80× BAM (all ' +
          'chromosomes). The worst-case density — the acceptance bar for full-genome ' +
          'read streaming.',
        factory: grch38GenomeWideLocalHg002_80x,
        referenceAssemblyId: 'grch38',
        aliases: ['grch38-local-hg002-80x', 'full-genome-hg002-80x'],
        noAutoReplay: true,
      },
      {
        id: 'assembly-grch38-local-hg002-80x-mutations',
        label: 'grch38GenomeWideLocalHg002_80xMutations',
        description:
          'FULL GRCh38 assembly + local HG002 80× whole-genome BAM + official ' +
          'indexed HG002 GIAB calls. The variant navigator remains loaded for its ' +
          'dedicated entry-point follow-up; it is intentionally absent from the compact toolbar.',
        factory: grch38GenomeWideLocalHg002_80xMutations,
        referenceAssemblyId: 'grch38',
        aliases: ['full-genome-hg002-mutations'],
        noAutoReplay: true,
      },
    ],
  },
  {
    id: 'ai-chat',
    heading: 'AI Chat',
    presets: [
      {
        id: 'ai-explore',
        label: 'aiExploreSession',
        description: 'Chat + project + pUC19',
        factory: aiExploreSession,
      },
      {
        id: 'inline-entity-chips',
        label: 'inlineEntityChipsSession',
        description:
          ' — live notebook/chat split with switchable shared entity-chip styles, real pUC19 package actions, links, and code',
        factory: inlineEntityChipsSession,
        noAutoReplay: true,
      },
      {
        id: 'ai-multi-file',
        label: 'aiMultiFileSession',
        description: 'Chat + pUC19 + GFP',
        factory: aiMultiFileSession,
      },
      {
        id: 'agent-trace-cli',
        label: 'agentTraceCliSession',
        description: 'Chat + real CLI trace fixture project + prompt pack',
        factory: agentTraceCliSession,
        aliases: ['agent-trace-cli-session'],
      },
    ],
  },
] as const;

export const DEV_SCENARIO_PRESETS: readonly DevScenarioPreset[] =
  DEV_SCENARIO_PRESET_GROUPS.flatMap((group) => group.presets);

export function getDevScenarioPresetById(id: string): DevScenarioPreset | null {
  return DEV_SCENARIO_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function getDevScenarioPresetByAlias(alias: string): DevScenarioPreset | null {
  return DEV_SCENARIO_PRESETS.find((preset) => preset.aliases?.includes(alias)) ?? null;
}

export function filterDevScenarioPresetGroups(
  groups: readonly DevScenarioPresetGroup[],
  query: string
): readonly DevScenarioPresetGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups;

  const result: DevScenarioPresetGroup[] = [];
  for (const group of groups) {
    const presets = group.presets.filter((preset) => {
      const haystack = [
        preset.label,
        preset.description,
        preset.id,
        ...(preset.aliases ?? []),
        group.heading,
      ]
        .join('\n')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    if (presets.length > 0) result.push({ ...group, presets });
  }
  return result;
}
