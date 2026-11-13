import { parseGenBankFull } from '@waypoint/sequence-utils';
import { sidecarScenarios } from './sidecar';
import { withPUC19, withGFP, withSequenceFile } from './sequences';
import { withStandardWorkspace, withWorkspaceFolder } from './workspace';
import { withChatTab, withSequenceTab } from './canvas';
import { withChatHistory, withChatReady } from './chat';
import { sequencePackageFixtureDocument } from './sequence-package-fixture';
import { SANGER_FIXTURES, sangerFixture, withSangerFixture, type SangerFixture } from './sanger';
export {
  limsHeaderlessPrimerTsvScenario,
  limsMessyPrimerCsvImportScenario,
  limsPrimerCsvImportScenario,
} from './lims';
import type { AppScenario } from './types';
import HOMING_ENDO_TARGETS_GB from '../../../../../test-fixtures/sequences/circular/homing-endo-targets-synthetic.gb?raw';
import REAL_PUC19_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import ECOLI_MG1655_REGION_GB from '../../../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb?raw';

import MG1655_THRL_MULTI_XREF_GB from '../../../../../test-fixtures/sequences/linear/mg1655-thrL-multi-xref-synthetic.gb?raw';

declare const __DEV_WP_ASSETS_PATH__: string;
const WP_ASSETS = __DEV_WP_ASSETS_PATH__ || import.meta.env.VITE_WP_ASSETS_PATH || '';

export {
  staleAlignmentSession,
  ALIGNMENT_STALE_REFERENCE_PATH,
  ALIGNMENT_STALE_QUERY_PATH,
  ALIGNMENT_STALE_SESSION_ID,
  ALIGNMENT_STALE_TRACK_ID,
} from './alignment';

export {
  sequencePackageAttachTwoClones,
  SEQUENCE_PACKAGE_ATTACH_WORKSPACE_ROOT,
  SEQUENCE_PACKAGE_ATTACH_PACKAGE_ROOT,
  SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
  SEQUENCE_PACKAGE_ATTACH_META_PATH,
  SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH,
  SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH,
  SEQUENCE_PACKAGE_ATTACH_GUIDE_PATH,
} from './sequence-package-attach';

export {
  sequencePackageMetadata,
  SEQUENCE_METADATA_WORKSPACE_ROOT,
  SEQUENCE_METADATA_PACKAGE_ROOT,
  SEQUENCE_METADATA_PRODUCT_PATH,
  SEQUENCE_METADATA_META_PATH,
} from './sequence-package-metadata';

export { assemblyDemoWorkspace } from './assembly-demo';
export { primerFileAuthorityWorkspace } from './primer-file-authority';
export {
  legacyReferenceRepairWorkspace,
  LEGACY_REPAIR_GUIDE_PATH,
  LEGACY_REPAIR_NOTEBOOK_DIR,
  LEGACY_REPAIR_ROOT,
} from './legacy-reference-repair';

export {
  realAssemblyManyTabs,
  realAssemblyManyTabsStress,
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
  realAssemblyPipelineDevScenarios,
} from './assembly-real-pipeline';

function withSidecar(sidecar: AppScenario['sidecar']): AppScenario {
  return { sidecar };
}

export function typicalSession(): AppScenario {
  return withPUC19(withStandardWorkspace(withSidecar(sidecarScenarios.fullyReady())));
}

export const MULTI_PROJECT_ALPHA_ROOT = '/workspace/projects/strain-buildout';
export const MULTI_PROJECT_BETA_ROOT = '/workspace/projects/qc-reference';
export const MULTI_PROJECT_ALPHA_SEQUENCE = `${MULTI_PROJECT_ALPHA_ROOT}/vectors/pUC19.gb`;
export const MULTI_PROJECT_BETA_SEQUENCE = `${MULTI_PROJECT_BETA_ROOT}/references/ecoli-mg1655-region.gb`;
export const MULTI_PROJECT_ALPHA_DOCUMENT_ID = 'fixture:sequence:multi-project-alpha-puc19';
export const MULTI_PROJECT_BETA_DOCUMENT_ID = 'fixture:sequence:multi-project-beta-mg1655';

export function multiProjectRootsSession(): AppScenario {
  const workspace = withWorkspaceFolder(
    withWorkspaceFolder(withSidecar(sidecarScenarios.fullyReady()), MULTI_PROJECT_ALPHA_ROOT, [
      {
        name: 'README.md',
        content: '# Strain Buildout\n\nProject-like root using real public fixture files.\n',
      },
      { name: 'vectors/pUC19.gb', content: REAL_PUC19_GB },
      {
        name: 'notes/import-plan.md',
        content: 'Verify that project actions stay attached to this root only.\n',
      },
    ]),
    MULTI_PROJECT_BETA_ROOT,
    [
      {
        name: 'README.md',
        content: '# QC Reference\n\nSecond project-like root using real public fixture files.\n',
      },
      { name: 'references/ecoli-mg1655-region.gb', content: ECOLI_MG1655_REGION_GB },
      {
        name: 'results/qc.tsv',
        content: 'sample\tstatus\nmg1655-region\tpass\n',
      },
    ]
  );

  const scenario = withSequenceFile(
    withSequenceFile(workspace, {
      documentId: MULTI_PROJECT_ALPHA_DOCUMENT_ID,
      sourcePath: MULTI_PROJECT_ALPHA_SEQUENCE,
      sequence: parseGenBankFull(REAL_PUC19_GB),
      fileContent: REAL_PUC19_GB,
    }),
    {
      documentId: MULTI_PROJECT_BETA_DOCUMENT_ID,
      sourcePath: MULTI_PROJECT_BETA_SEQUENCE,
      sequence: parseGenBankFull(ECOLI_MG1655_REGION_GB),
      fileContent: ECOLI_MG1655_REGION_GB,
    }
  );

  return {
    ...scenario,
    dev: { scenarioId: 'multi-project-roots' },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: MULTI_PROJECT_ALPHA_DOCUMENT_ID,
          label: 'pUC19.gb',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: MULTI_PROJECT_ALPHA_DOCUMENT_ID,
          },
        },
        {
          type: 'sequence',
          entityId: MULTI_PROJECT_BETA_DOCUMENT_ID,
          label: 'ecoli-mg1655-region.gb',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: MULTI_PROJECT_BETA_DOCUMENT_ID,
          },
        },
      ],
      activeTabIndex: 0,
      layout: 'split-vertical',
    },
    workspace: scenario.workspace
      ? {
          ...scenario.workspace,
          selectedPath: MULTI_PROJECT_ALPHA_SEQUENCE,
        }
      : scenario.workspace,
  };
}

export function freshSession(): AppScenario {
  return withSidecar(sidecarScenarios.freshInstall());
}

export function editingSession(): AppScenario {
  return withPUC19(withSidecar(sidecarScenarios.fullyReady()));
}

export function downloadingSession(): AppScenario {
  return withSidecar(sidecarScenarios.downloadingTools(50));
}

export function errorSession(): AppScenario {
  return withSidecar(sidecarScenarios.toolsError());
}

export const AGENT_TRACE_CLI_WORKSPACE_ROOT = '/workspace/agent-trace-cli';

const AGENT_TRACE_VECTOR_FASTA = `>agent_trace_vector_synthetic circular=true note=EcoRI-BamHI_MCS_with_BsaI_flanks
TTGACATGATAAGTAAGGAGGAAAAACATATGGCTAGCGGTCTCAAGCTTGAATTCGCGGCCGCGGATCC
GAGACCGTCGACCTGCAGGCATGCAAGCTTATCGATACCGTCGACGAGCTCGTTTAAACGGCCGCGCC
TCTAGACTCGAGGTCGACGGTATCGATAAGCTTGCATGCCTGCAGGTCGACTCGAGTCTAGAGGATCC
GCGGCCGCGAATTCAAGCTTGAGACCGCTAGCCATATGTTTTTCCTCCTTACTTATCATGTCAA
`;

const AGENT_TRACE_INSERT_FASTA = `>stress_response_insert_synthetic note=CDS_with_internal_BsaI_site_to_force_Golden_Gate_warning
ATGGCTGCTGAAAACGTTTTCGACGATGCTGAAGAACTGGCTGGTAAACCGGGTCTCGGTGCTGAA
ATCGACGCTTTCGCTAAAGCTGGTGAACTGAAACCGGCTATCGCTGCTGCTAAATAA
`;

const AGENT_TRACE_MUTATION_CASE_FASTA = `>reference_cds_synthetic note=clean_90bp_ORF
ATGGCTGCTGAAAACGTTTTCGACGATGCTGAAGAACTGGCTGGTAAACCGGCTGCTGAAATCGACGCT
TTCGCTAAATAA
>candidate_cds_frameshift_synthetic note=single_base_deletion_after_codon_12
ATGGCTGCTGAAAACGTTTTCGACGATGCTGAAGACTGGCTGGTAAACCGGCTGCTGAAATCGACGCT
TTCGCTAAATAA
`;

const AGENT_TRACE_METADATA_JSON = `{
  "fixture": "agent-trace-cli-session",
  "purpose": "Exercise CLI activity streaming with real workspace reads, writes, shell commands, and biology reasoning.",
  "expected_findings": [
    "insert contains an internal BsaI recognition site (GGTCTC)",
    "vector contains EcoRI and BamHI sites near the synthetic MCS",
    "candidate_cds_frameshift_synthetic differs from reference_cds_synthetic and should be treated as a coding-risk case"
  ],
  "success_oracles": [
    "CLI activity stream shows command/tool rows without protocol lifecycle junk",
    "final answer gives public evidence and assumptions instead of private chain-of-thought",
    "files are written under outputs/ and can be opened from the workspace"
  ]
}
`;

export const AGENT_TRACE_CLI_PROMPTS_MD = `# Agent Trace CLI Test Kit

Use these prompts after applying the DevPanel preset named agentTraceCliSession.
Select either Claude Native CLI or Codex Native CLI in the chat route picker before sending.
Run the same prompts against both routes.

## Prompt 1 - workspace audit and sequence QC

You are in a DNAForge dev workspace. First verify the working directory and list the files with shell commands. Then read input/vector.fa, input/insert.fa, input/mutation_case.fa, and input/metadata.json. Use shell or Python to compute length, GC fraction, restriction-site hits for EcoRI, BamHI, BsaI, BsmBI, and whether each FASTA record length is divisible by 3. Write outputs/prompt-1-qc/metrics.tsv, outputs/prompt-1-qc/report.md, and outputs/prompt-1-qc/manifest.json. In the final answer, summarize the public evidence, the commands or scripts used, and the files created. Do not expose private chain-of-thought.

## Prompt 2 - cloning route decision

Using only the files in this workspace, compare Gibson assembly, restriction-ligation with EcoRI/BamHI, and Golden Gate with BsaI for inserting stress_response_insert_synthetic into agent_trace_vector_synthetic. Run whatever shell/Python checks you need against the actual sequences. Write outputs/prompt-2-cloning/decision_matrix.csv and outputs/prompt-2-cloning/strategy_report.md. The final answer should explain the recommended route, disqualifying evidence, assumptions, and what you would verify before ordering primers. Do not expose private chain-of-thought.

## Prompt 3 - stop behavior

Start a careful multi-step analysis: verify cwd, list input files, read all FASTA records, begin a codon-level comparison of reference_cds_synthetic versus candidate_cds_frameshift_synthetic, and create outputs/prompt-3-stop/. Pause between phases by doing real shell/Python work. I am going to press Stop after the first command/tool activity row appears. If stopped, there should be no late final biology conclusion after the stop acknowledgement.
`;

const AGENT_TRACE_CLI_PROMPT_MESSAGE = `Agent Trace CLI Test Kit

This preset created a real fixture workspace with:
- input/vector.fa
- input/insert.fa
- input/mutation_case.fa
- input/metadata.json
- prompts.md

Use the route picker in the chat composer to select Claude Native CLI or Codex Native CLI, then paste Prompt 1, Prompt 2, and Prompt 3 from prompts.md. The prompts are designed to force real cwd checks, file reads, shell/Python work, workspace writes, visible activity rows, and a public reasoning summary without private chain-of-thought.`;

export function aiExploreSession(): AppScenario {
  return withChatReady(
    withPUC19(withStandardWorkspace(withSidecar(sidecarScenarios.fullyReady())))
  );
}

const INLINE_ENTITY_CHIPS_CONVERSATION_ID_PREFIX = 'fixture-inline-entity-chips';
export const INLINE_ENTITY_CHIPS_WORKSPACE_ROOT = '/workspace/fixture-inline-chips';
export const INLINE_ENTITY_CHIPS_PACKAGE_ROOT = `${INLINE_ENTITY_CHIPS_WORKSPACE_ROOT}/pUC19`;
export const INLINE_ENTITY_CHIPS_PRODUCT_PATH = `${INLINE_ENTITY_CHIPS_PACKAGE_ROOT}/pUC19.gb`;
export const INLINE_ENTITY_CHIPS_META_PATH = `${INLINE_ENTITY_CHIPS_PACKAGE_ROOT}/.forge/plasmid.json`;

export function inlineEntityChipsSession(): AppScenario {
  const conversationId = `${INLINE_ENTITY_CHIPS_CONVERSATION_ID_PREFIX}-${crypto.randomUUID()}`;
  const pageId = `${INLINE_ENTITY_CHIPS_CONVERSATION_ID_PREFIX}-notebook`;
  const scenario = withWorkspaceFolder(
    withSidecar(sidecarScenarios.fullyReady()),
    INLINE_ENTITY_CHIPS_WORKSPACE_ROOT,
    [
      { name: 'pUC19/pUC19.gb', content: REAL_PUC19_GB },
      {
        name: 'pUC19/.forge/plasmid.json',
        content: sequencePackageFixtureDocument({
          id: 'fixture-inline-puc19',
          name: 'pUC19',
          productFile: 'pUC19.gb',
        }),
      },
    ]
  );
  return {
    ...scenario,
    dev: {
      scenarioId: 'fixture-inline-entity-chips',
    },
    canvas: {
      tabs: [
        {
          type: 'page',
          entityId: pageId,
          label: 'Entity chip comparison',
        },
        {
          type: 'chat',
          entityId: conversationId,
          label: 'Inline entity chips',
        },
      ],
      activeTabIndex: 1,
      layout: 'split-vertical',
    },
    pages: {
      pages: [
        {
          id: pageId,
          title: 'Entity chip comparison',
          content: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: 'Notebook reference' }],
              },
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Open ' },
                  {
                    type: 'mention',
                    attrs: {
                      id: 'fixture-inline-puc19',
                      label: 'pUC19.gb',
                      entityType: 'sequence',
                      entityId: 'fixture-inline-puc19',
                      path: null,
                      contentHash: null,
                      objectUuid: null,
                    },
                  },
                  { type: 'text', text: ' and ' },
                  {
                    type: 'mention',
                    attrs: {
                      id: 'primer-f2-forward',
                      label: 'F2 forward',
                      entityType: 'primer',
                      entityId: 'primer-f2-forward',
                      path: null,
                      contentHash: null,
                      objectUuid: null,
                    },
                  },
                  { type: 'text', text: ' beside neutral ' },
                  { type: 'text', marks: [{ type: 'code' }], text: 'inline code' },
                  { type: 'text', text: ' and a ' },
                  {
                    type: 'text',
                    marks: [{ type: 'link', attrs: { href: 'https://dnaforge.com' } }],
                    text: 'web link',
                  },
                  { type: 'text', text: '.' },
                ],
              },
            ],
          },
        },
      ],
    },
    chat: {
      conversationId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          id: `${conversationId}-user`,
          role: 'user',
          content: 'Show pUC19 and where it lives.',
          createdAt: 1,
        },
      ],
      streamedInlineReferenceText:
        'Compare `inline code`, a [web link](https://dnaforge.com), and the shared entity: open [pUC19](dnaforge-chat://entity/sequence/fixture-inline-chips/pUC19).\n\n```text\nATGC\n```',
    },
  };
}

export function aiMultiFileSession(): AppScenario {
  return withChatReady(
    withGFP(withPUC19(withStandardWorkspace(withSidecar(sidecarScenarios.fullyReady()))))
  );
}

export function agentTraceCliSession(): AppScenario {
  const scenario = withChatHistory(
    withChatTab(
      withWorkspaceFolder(
        withSidecar(sidecarScenarios.fullyReady()),
        AGENT_TRACE_CLI_WORKSPACE_ROOT,
        [
          { name: 'input/vector.fa', content: AGENT_TRACE_VECTOR_FASTA },
          { name: 'input/insert.fa', content: AGENT_TRACE_INSERT_FASTA },
          { name: 'input/mutation_case.fa', content: AGENT_TRACE_MUTATION_CASE_FASTA },
          { name: 'input/metadata.json', content: AGENT_TRACE_METADATA_JSON },
          { name: 'prompts.md', content: AGENT_TRACE_CLI_PROMPTS_MD },
        ]
      ),
      '8d51a3ef-64f3-4b4c-9efe-4d04da9f91cf'
    ),
    [
      {
        id: 'agent-trace-cli-instructions',
        role: 'assistant',
        content: AGENT_TRACE_CLI_PROMPT_MESSAGE,
        createdAt: 1_717_200_000_000,
      },
    ]
  );

  return {
    ...scenario,
    dev: {
      scenarioId: 'agent-trace-cli-session',
    },
    workspace: scenario.workspace
      ? {
          ...scenario.workspace,
          selectedPath: AGENT_TRACE_CLI_WORKSPACE_ROOT,
        }
      : scenario.workspace,
  };
}

export function sangerSession(fixtureId: SangerFixture['id']): AppScenario {
  const fixture = SANGER_FIXTURES.find((f) => f.id === fixtureId);
  if (!fixture) throw new Error(`Unknown Sanger fixture: ${fixtureId}`);
  return withSangerFixture(fixture);
}

export const sangerCleanFwdSession = () => sangerSession('clean-forward');
export const sangerCleanRcSession = () => sangerSession('clean-rc');
export const sangerRcWithIndelsSession = () => sangerSession('clean-rc-with-indels');
export const sangerHeterozygousSession = () => sangerSession('heterozygous');
export const sangerFailedSession = () => sangerSession('failed-low-quality');

export function sangerAttachedSession(
  fixtureId: SangerFixture['id'] = 'clean-forward'
): AppScenario {
  const fixture = SANGER_FIXTURES.find((f) => f.id === fixtureId);
  if (!fixture) throw new Error(`Unknown Sanger fixture: ${fixtureId}`);

  const base = withSangerFixture(fixture);
  const sceneWithRefActive: AppScenario = {
    ...base,
    canvas: {
      ...base.canvas!,
      activeTabIndex: 0,
    },
  };

  setTimeout(() => {
    void (async () => {
      try {
        const [{ attachReadToReference }, canvasMod] = await Promise.all([
          import('../../features/sequence/tracks/attach-read-to-reference'),
          import('../../features/canvas/store'),
        ]);

        const cs = canvasMod.useCanvasStore.getState();
        let referenceDocumentId: string | null = null;
        for (const panel of Object.values(cs.panels)) {
          const tab = panel.tabs.find(
            (t) => t.type === 'sequence' && t.entityId === fixture.refPath
          );
          if (tab) {
            referenceDocumentId = tab.entityId;
            cs.setTabViewState(panel.id, tab.id, { sequenceViewMode: 'tracks' });
            break;
          }
        }

        if (!referenceDocumentId) throw new Error('The reference sequence tab is unavailable.');
        await attachReadToReference(referenceDocumentId, fixture.refPath, fixture.ab1Path);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[sangerAttachedSession] attach failed:', err);
      }
    })();
  }, 0);

  return sceneWithRefActive;
}

export const sangerAttachedCleanFwdSession = () => sangerAttachedSession('clean-forward');
export const sangerAttachedCleanRcSession = () => sangerAttachedSession('clean-rc');
export const sangerAttachedRcWithIndelsSession = () =>
  sangerAttachedSession('clean-rc-with-indels');
export const sangerAttachedHeterozygousSession = () => sangerAttachedSession('heterozygous');
export const sangerAttachedFailedSession = () => sangerAttachedSession('failed-low-quality');
export const sangerAttachedOriginSpanningSession = () => sangerAttachedSession('origin-spanning');

export function sangerAttachedMultiReadSession(): AppScenario {
  const fixture = sangerFixture('clean-forward');
  const base = withSangerFixture(fixture);
  const sceneWithRefActive: AppScenario = {
    ...base,
    canvas: {
      ...base.canvas!,
      activeTabIndex: 0,
    },
  };

  setTimeout(() => {
    void (async () => {
      try {
        const [{ attachReadToReference }, canvasMod] = await Promise.all([
          import('../../features/sequence/tracks/attach-read-to-reference'),
          import('../../features/canvas/store'),
        ]);

        const cs = canvasMod.useCanvasStore.getState();
        let referenceDocumentId: string | null = null;
        for (const panel of Object.values(cs.panels)) {
          const tab = panel.tabs.find(
            (t) => t.type === 'sequence' && t.entityId === fixture.refPath
          );
          if (tab) {
            referenceDocumentId = tab.entityId;
            cs.setTabViewState(panel.id, tab.id, { sequenceViewMode: 'tracks' });
            break;
          }
        }

        if (!referenceDocumentId) throw new Error('The reference sequence tab is unavailable.');
        await attachReadToReference(referenceDocumentId, fixture.refPath, fixture.ab1Path);
        await attachReadToReference(referenceDocumentId, fixture.refPath, fixture.ab1Path, {
          readIdOverride: `${fixture.ab1Path}#dup`,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[sangerAttachedMultiReadSession] attach failed:', err);
      }
    })();
  }, 0);

  return sceneWithRefActive;
}

const HOMING_ENDO_TARGETS_FILE = 'homing-endo-targets-synthetic.gb';
const HOMING_ENDO_TARGETS_DOCUMENT_ID = 'fixture:sequence:homing-endo-targets';

function getHomingEndoTargetsPath(): string {
  const home = WP_ASSETS ? WP_ASSETS.replace(/\/[^/]+$/, '') : '/tmp/.waypoint-dev';
  return `${home}/.waypoint-dev-fixtures/${HOMING_ENDO_TARGETS_FILE}`;
}

export function cutSiteHomingEndoSession(): AppScenario {
  const seq = parseGenBankFull(HOMING_ENDO_TARGETS_GB);
  const path = getHomingEndoTargetsPath();
  const base: AppScenario = withSequenceFile(
    withSequenceTab(withSidecar(sidecarScenarios.fullyReady()), {
      documentId: HOMING_ENDO_TARGETS_DOCUMENT_ID,
      sourcePath: path,
      label: 'homing-endo-targets',
    }),
    {
      documentId: HOMING_ENDO_TARGETS_DOCUMENT_ID,
      sourcePath: path,
      sequence: seq,
      fileContent: HOMING_ENDO_TARGETS_GB,
    }
  );

  setTimeout(() => {
    try {
      window.localStorage.setItem(
        'waypoint-active-enzymes',
        JSON.stringify(['I-CeuI', 'I-SceI', 'PI-PspI', 'PI-SceI'])
      );
      window.localStorage.setItem('waypoint-enzyme-visible', 'true');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[cutSiteHomingEndoSession] could not set localStorage:', err);
    }

    void (async () => {
      try {
        const { platform } = await import('../../platform');
        const parent = path.replace(/\/[^/]+$/, '');
        await platform().fs.mkdir(parent, { recursive: true });
        await platform().fs.writeTextFile(path, HOMING_ENDO_TARGETS_GB);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[cutSiteHomingEndoSession] could not write fixture to disk:', err);
      }
    })();
  }, 0);

  return base;
}

const MG1655_THRL_FILE = 'mg1655-thrL-multi-xref-synthetic.gb';
const MG1655_THRL_DOCUMENT_ID = 'fixture:sequence:mg1655-thrl';

function getMg1655ThrlPath(): string {
  const home = WP_ASSETS ? WP_ASSETS.replace(/\/[^/]+$/, '') : '/tmp/.waypoint-dev';
  return `${home}/.waypoint-dev-fixtures/${MG1655_THRL_FILE}`;
}

export function structureThrLSession(): AppScenario {
  const parsed = parseGenBankFull(MG1655_THRL_MULTI_XREF_GB);
  const path = getMg1655ThrlPath();
  const seq = { ...parsed, id: MG1655_THRL_DOCUMENT_ID };
  const base: AppScenario = withSequenceFile(
    withSequenceTab(withSidecar(sidecarScenarios.fullyReady()), {
      documentId: MG1655_THRL_DOCUMENT_ID,
      sourcePath: path,
      label: 'mg1655 thrL',
    }),
    {
      documentId: MG1655_THRL_DOCUMENT_ID,
      sourcePath: path,
      sequence: seq,
      fileContent: MG1655_THRL_MULTI_XREF_GB,
    }
  );

  setTimeout(() => {
    void (async () => {
      try {
        const { platform } = await import('../../platform');
        const parent = path.replace(/\/[^/]+$/, '');
        await platform().fs.mkdir(parent, { recursive: true });
        await platform().fs.writeTextFile(path, MG1655_THRL_MULTI_XREF_GB);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[structureThrLSession] could not write fixture to disk:', err);
      }
    })();
  }, 0);

  return base;
}

export function demoSession(): AppScenario {
  const pDEMO035 = `${WP_ASSETS}/sequences/local/dna/pDEMO035.gb`;

  return withSequenceTab(
    {
      sidecar: sidecarScenarios.fullyReady(),
      workspace: {
        folders: [{ path: WP_ASSETS, name: 'Dev Assets' }],
        selectedPath: WP_ASSETS,
      },
    },
    {
      documentId: 'fixture:sequence:pdemo035',
      sourcePath: pDEMO035,
      label: 'pDEMO035',
    }
  );
}

const W3110_PATH = 'test-fixtures/genomes/ecoli-W3110/NC_007779.1.gb';
const BSUB_PATH =
  'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/genomes/bacillus-subtilis-168.gb';
const COMPLETE_MG1655_PATH = 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb';

export function completeMg1655Linear(): AppScenario {
  return {
    sidecar: sidecarScenarios.fullyReady(),
    openSequenceAt: {
      filePath: COMPLETE_MG1655_PATH,
      label: 'E. coli MG1655 — complete linear view',
      start: 1,
      end: 1_000,
      mapShape: 'linear',
    },
  };
}

export function is3TransposaseMinusOneSlip(): AppScenario {
  return {
    sidecar: sidecarScenarios.fullyReady(),
    openSequenceAt: {
      filePath: W3110_PATH,
      label: 'E. coli W3110 — IS3 transposase (-1 slip)',
      start: 314515,
      end: 315677,
    },
  };
}

export function nrdFBGroupIIntron(): AppScenario {
  return {
    sidecar: sidecarScenarios.fullyReady(),
    openSequenceAt: {
      filePath: BSUB_PATH,
      label: 'B. subtilis nrdFB — group I intron (control)',
      start: 2159981,
      end: 2161778,
    },
  };
}

export function prfBPlusOneSkip(): AppScenario {
  return {
    sidecar: sidecarScenarios.fullyReady(),
    openSequenceAt: {
      filePath: BSUB_PATH,
      label: 'B. subtilis prfB — +1 frameshift (base skipped)',
      start: 3627139,
      end: 3628240,
    },
  };
}

export const TABULAR_CSV_WORKSPACE_ROOT = '/workspace/tabular-csv';

export const TABULAR_CSV_FIXTURE =
  'sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n';

export function tabularCsvCrashRepro(): AppScenario {
  const scenario = withWorkspaceFolder(
    withSidecar(sidecarScenarios.fullyReady()),
    TABULAR_CSV_WORKSPACE_ROOT,
    [{ name: 'quoted-samples.csv', content: TABULAR_CSV_FIXTURE }]
  );

  const csvPath = `${TABULAR_CSV_WORKSPACE_ROOT}/quoted-samples.csv`;

  return {
    ...scenario,
    dev: { scenarioId: 'tabular-csv-crash-repro' },
    workspace: scenario.workspace
      ? { ...scenario.workspace, selectedPath: csvPath }
      : scenario.workspace,
    canvas: {
      tabs: [{ type: 'table', entityId: csvPath, label: 'quoted-samples.csv' }],
      activeTabIndex: 0,
    },
  };
}
