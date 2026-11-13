import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeDraftAssembly } from '../../features/design/algorithms/draft-assembly';
import type { DesignAnnotation, DesignRegion, SequenceDesign } from '../../features/design/types';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';

import README_MD from '../../../../../test-fixtures/demo-workspace/assembly-demo/README.md?raw';
import PEGFP_N1_GB from '../../../../../test-fixtures/demo-workspace/assembly-demo/plasmids/pEGFP-N1.gb?raw';
import PTRE_GB from '../../../../../test-fixtures/demo-workspace/assembly-demo/plasmids/pTRE.gb?raw';
import PUC19_DSRED_GB from '../../../../../test-fixtures/demo-workspace/assembly-demo/plasmids/pUC19-DsRed.gb?raw';
import PACYC177_GB from '../../../../../test-fixtures/demo-workspace/assembly-demo/plasmids/pACYC177.gb?raw';
import PUC19_GB from '../../../../../test-fixtures/demo-workspace/assembly-demo/plasmids/pUC19.gb?raw';

declare const __DEV_WP_ASSETS_PATH__: string;
const WP_ASSETS = __DEV_WP_ASSETS_PATH__ || import.meta.env.VITE_WP_ASSETS_PATH || '';

function demoRoot(): string {
  const home = WP_ASSETS ? WP_ASSETS.replace(/\/[^/]+$/, '') : '/tmp/.waypoint-dev';
  return `${home}/.waypoint-dev-fixtures/assembly-demo`;
}

interface PlasmidFile {
  rel: string;
  gb: string;
}

const PLASMIDS: readonly PlasmidFile[] = [
  { rel: 'plasmids/pEGFP-N1.gb', gb: PEGFP_N1_GB },
  { rel: 'plasmids/pTRE.gb', gb: PTRE_GB },
  { rel: 'plasmids/pUC19-DsRed.gb', gb: PUC19_DSRED_GB },
  { rel: 'plasmids/pACYC177.gb', gb: PACYC177_GB },
  { rel: 'plasmids/pUC19.gb', gb: PUC19_GB },
] as const;

export interface AssemblyDemoPart {
  part: string;
  rel: string;
  start: number;
  end: number;
  role: string;
}

export const ASSEMBLY_DEMO_PARTS: readonly AssemblyDemoPart[] = [
  {
    part: 'CMV promoter',
    rel: 'plasmids/pEGFP-N1.gb',
    start: 1,
    end: 678,
    role: 'constitutive promoter',
  },
  {
    part: 'TRE promoter',
    rel: 'plasmids/pTRE.gb',
    start: 1,
    end: 438,
    role: 'dox-inducible promoter',
  },
  { part: 'EGFP', rel: 'plasmids/pEGFP-N1.gb', start: 679, end: 1398, role: 'green reporter' },
  {
    part: 'DsRed (FP583)',
    rel: 'plasmids/pUC19-DsRed.gb',
    start: 3365,
    end: 4042,
    role: 'red reporter',
  },
  { part: 'SV40 polyA', rel: 'plasmids/pEGFP-N1.gb', start: 1416, end: 1638, role: 'terminator' },
  {
    part: 'SV40 polyA (red vector)',
    rel: 'plasmids/pUC19-DsRed.gb',
    start: 4043,
    end: 4265,
    role: 'terminator',
  },
  {
    part: 'p15A + KanR backbone',
    rel: 'plasmids/pACYC177.gb',
    start: 766,
    end: 3025,
    role: 'backbone',
  },
] as const;

export interface AssemblyDemoWorkspace {
  root: string;
  sequences: Record<string, AnnotatedSequence>;
  files: Record<string, string>;
  paths: Record<string, string>;
  documentIds: Record<string, string>;
  readmePath: string;
}

export function buildAssemblyDemoWorkspace(rootOverride?: string): AssemblyDemoWorkspace {
  const root = rootOverride ?? demoRoot();
  const sequences: Record<string, AnnotatedSequence> = {};
  const files: Record<string, string> = {};
  const paths: Record<string, string> = {};
  const documentIds: Record<string, string> = {};

  for (const p of PLASMIDS) {
    const path = `${root}/${p.rel}`;
    const documentId = `fixture:sequence:assembly-demo:${p.rel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    const parsed = parseGenBankFull(p.gb);
    sequences[documentId] = {
      ...parsed,
      id: documentId,
      sequence: parsed.sequence.toUpperCase(),
      length: parsed.sequence.length,
    };
    files[path] = p.gb;
    paths[p.rel] = path;
    documentIds[p.rel] = documentId;
  }

  const readmePath = `${root}/README.md`;
  files[readmePath] = README_MD;

  return { root, sequences, files, paths, documentIds, readmePath };
}

function rangeAnnotations(
  seq: AnnotatedSequence,
  start1: number,
  end1: number
): DesignAnnotation[] {
  return seq.annotations
    .filter((a) => a.start >= start1 && a.end <= end1)
    .map((a) => ({
      name: a.name,
      type: a.type,
      start: a.start - start1,
      end: a.end - start1 + 1,
      strand: a.direction === 1 ? 'forward' : a.direction === -1 ? 'reverse' : 'none',
      color: a.color,
    }));
}

export function regionFromPlasmid(
  workspace: AssemblyDemoWorkspace,
  rel: string,
  start1: number,
  end1: number,
  label: string,
  colorIndex: number
): DesignRegion {
  const documentId = workspace.documentIds[rel];
  const seq = workspace.sequences[documentId];
  if (!seq) throw new Error(`unknown plasmid ${rel}`);
  const sliced = seq.sequence.slice(start1 - 1, end1);
  return {
    id: `region-${colorIndex}`,
    colorIndex,
    sourceSequenceId: documentId,
    sourceSequenceName: seq.name || rel,
    sourceStart: start1 - 1,
    sourceEnd: end1,
    sequence: sliced,
    annotations: rangeAnnotations(seq, start1, end1),
    sourceSequence: seq.sequence,
    sourceIsCircular: true,
    sourceType: 'pcr',
  };
}

export function buildSampleAssembly(
  partNames: readonly string[],
  name: string,
  rootOverride?: string
): { design: SequenceDesign; workspace: AssemblyDemoWorkspace } {
  const workspace = buildAssemblyDemoWorkspace(rootOverride);
  const regions = partNames.map((pn, i) => {
    const p = ASSEMBLY_DEMO_PARTS.find((x) => x.part === pn);
    if (!p) throw new Error(`unknown part ${pn}`);
    return regionFromPlasmid(workspace, p.rel, p.start, p.end, p.part, i);
  });
  const now = new Date('2026-06-18T00:00:00.000Z');
  const base: SequenceDesign = {
    id: `assembly-demo-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    topology: 'circular',
    regions,
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: regions[regions.length - 1]?.sourceSequenceId ?? null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: undefined,
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
  const draft = computeDraftAssembly(base);
  return {
    workspace,
    design: {
      ...base,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready',
      status: 'computed',
      version: 1,
    },
  };
}

export function assemblyDemoWorkspace(): AppScenario {
  const ws = buildAssemblyDemoWorkspace();
  const documentId = ws.documentIds['plasmids/pEGFP-N1.gb'];

  const scenario: AppScenario = {
    dev: { scenarioId: 'assembly-demo' },
    sidecar: sidecarScenarios.fullyReady(),
    workspace: {
      folders: [{ path: ws.root, name: 'assembly-demo' }],
      selectedPath: ws.readmePath,
    },
    sequences: ws.sequences,
    sequenceSources: Object.fromEntries(
      Object.entries(ws.documentIds).map(([relativePath, sequenceDocumentId]) => [
        sequenceDocumentId,
        {
          sourcePath: ws.paths[relativePath],
          name: ws.sequences[sequenceDocumentId]?.name ?? relativePath,
        },
      ])
    ),
    files: ws.files,
    assets: WP_ASSETS
      ? [
          {
            wpAssetsPath: 'MG1655_ecoli.gb',
            mountPath: `${ws.root}/genomes/E_coli_MG1655_host.gb`,
            optional: true,
          },
        ]
      : undefined,
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: documentId,
          label: 'pEGFP-N1',
          sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
        },
        { type: 'chat', entityId: crypto.randomUUID(), label: 'Chat' },
      ],
      activeTabIndex: 0,
      layout: 'split-vertical',
    },
  };

  return scenario;
}
