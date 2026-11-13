import { parseGenBankFull } from '@waypoint/sequence-utils';
import PUC19_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import J23106_AB_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb?raw';
import B0034M_BC_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb?raw';
import E1010M_CD_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb?raw';
import B0015_DE_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb?raw';
import DVA_AE_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb?raw';
import CIDAR_KIT_DEFINITION from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json';
import PYTK009_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/pYTK009/pYTK009.gb?raw';
import PYTK033_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/pYTK033/pYTK033.gb?raw';
import PYTK051_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/pYTK051/pYTK051.gb?raw';
import PYTK096_GB from '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/pYTK096/pYTK096.gb?raw';
import YTK_KIT_DEFINITION from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json';
import {
  createAssemblyFixtureApi,
  normalizeFixture,
  type SequenceFixture,
} from '../../features/design/assembly-real-fixture-api';
import { computeDraftAssembly } from '../../features/design/algorithms/draft-assembly';
import { normalizeRichSequenceFragment } from '../../features/sequence-clipboard/rich-sequence-clipboard';
import { checkInternalSitesInPcrRegions } from '../../features/design/validation/golden-gate-overhangs';
import type { GoldenGateAssemblySchema } from '../../features/design/golden-gate-schema';
import type {
  AssemblyMethod,
  DesignRegion,
  DesignSpacer,
  GoldenGateEnzyme,
  RestrictionDigestOverhangType,
  ValidationError,
  SequenceDesign,
} from '../../features/design/types';
import {
  findMocloKitStage,
  mocloAssemblySchemaOptions,
  parseMocloKitDefinition,
  schemaForMocloStage,
} from '../../features/design/moclo-kit-definition';
import type { AppScenario } from './types';

const SAMPLE_WORKSPACE_RESOURCE_PREFIX =
  '../../../resources/sample-workspaces/standard-samples/workspace/';
const CIDAR_MOCLO_WORKSPACE_FILES = import.meta.glob<string>(
  [
    '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json',
    '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/**/*.gb',
    '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/**/.forge/plasmid.json',
  ],
  { eager: true, query: '?raw', import: 'default' }
);
const YTK_MOCLO_WORKSPACE_FILES = import.meta.glob<string>(
  [
    '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json',
    '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/**/*.gb',
    '../../../resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-ytk/**/.forge/plasmid.json',
  ],
  { eager: true, query: '?raw', import: 'default' }
);

export const REAL_ASSEMBLY_PIPELINE_DESIGN_ID = 'real-assembly-pipeline-design';
export const REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID = 'test-sequence:real-assembly-pipeline:pUC19';
export const REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH = '/workspace/real-fixtures/pUC19.gb';
const REAL_ASSEMBLY_PIPELINE_SEQUENCE_SOURCES: NonNullable<AppScenario['sequenceSources']> = {
  [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: {
    sourcePath: REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH,
    name: 'pUC19',
  },
};
export const CIDAR_MOCLO_RED_TU_DESIGN_ID = 'cidar-moclo-red-fluorescent-tu';
export const CIDAR_MOCLO_MIXED_ROUTE_RED_TU_DESIGN_ID =
  'cidar-moclo-mixed-route-red-fluorescent-tu';
export const YTK_MOCLO_FACTORY_DESIGN_ID = 'ytk-moclo-factory-expression-cassette';
export const YTK_MOCLO_FACTORY_RUN_ID = 'ytk-factory-run-example';

export const CIDAR_MOCLO_RED_TU_PATHS = {
  promoter: '/workspace/sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb',
  rbs: '/workspace/sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb',
  cds: '/workspace/sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb',
  terminator: '/workspace/sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb',
  destinationVector: '/workspace/sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb',
} as const;

export const CIDAR_MOCLO_RED_TU_PACKAGE_IDS = {
  promoter: 'sample-525cf33d',
  rbs: 'sample-7981ffa1',
  cds: 'sample-694681f1',
  terminator: 'sample-5427ea3f',
  destinationVector: 'sample-84ad4efb',
} as const;

export const YTK_MOCLO_FACTORY_PATHS = {
  promoter: '/workspace/sequences/kits/moclo-ytk/pYTK009/pYTK009.gb',
  codingSequence: '/workspace/sequences/kits/moclo-ytk/pYTK033/pYTK033.gb',
  terminator: '/workspace/sequences/kits/moclo-ytk/pYTK051/pYTK051.gb',
  cassetteVector: '/workspace/sequences/kits/moclo-ytk/pYTK096/pYTK096.gb',
  kitDefinition: '/workspace/.forge/moclo-kits/ytk.json',
} as const;

export const YTK_MOCLO_FACTORY_PACKAGE_IDS = {
  promoter: 'sample-4e461e72',
  codingSequence: 'sample-2df6bf0a',
  terminator: 'sample-6382d54e',
  cassetteVector: 'sample-7f1a3af6',
} as const;

const CIDAR_KIT_DEFINITION_RAW = JSON.stringify(CIDAR_KIT_DEFINITION);
const YTK_KIT_DEFINITION_RAW = JSON.stringify(YTK_KIT_DEFINITION);

export type RealAssemblyPipelineScenarioId =
  | 'gibson-pcr-pcr'
  | 'gibson-pcr-pcr-spacer'
  | 'gibson-pcr-rd-pcr'
  | 'gibson-pcr-rd-pcr-two-spacers'
  | 'gibson-rd-5prime-pcr'
  | 'gibson-rd-spacer-pcr'
  | 'gibson-rd-3prime-pcr'
  | 'gibson-rd-blunt-pcr'
  | 'gibson-rd-rd-invalid'
  | 'nebuilder-rd-spacer'
  | 'nebuilder-rd-rd-invalid'
  | 'goldengate-pcr-pcr'
  | 'goldengate-pcr-pcr-spacer'
  | 'goldengate-pcr-rd-pcr'
  | 'goldengate-rd-enzyme-mismatch-invalid'
  | 'goldengate-invalid-internal-site';

export interface RealAssemblyPipelineExpectation {
  method: AssemblyMethod;
  regionSourceTypes: Array<'pcr' | 'rd'>;
  spacerSequences: string[];
  primerPairIndices: number[];
  nonEmptyPrimerPairIndices: number[];
  homologyJunctionCount?: number;
  goldenGateJunctionCount?: number;
  goldenGateSourceTypes?: string[];
  valid: boolean;
  validationValid?: boolean;
  expectedConflictTypes?: string[];
  expectedInvalidJunctionErrors?: string[];
  expectedValidationErrorCodes?: string[];
  rdEndTypesByRegion?: Array<RestrictionDigestOverhangType | null>;
  gibsonTrimByRegion?: number[];
}

export interface RealAssemblyPipelineScenario {
  id: RealAssemblyPipelineScenarioId;
  label: string;
  description: string;
  buildDesign: () => SequenceDesign;
  expected: RealAssemblyPipelineExpectation;
}

export const realAssemblyPipelineFixtures = createRealAssemblyPipelineFixtures();

const api = createAssemblyFixtureApi(realAssemblyPipelineFixtures);

export const REAL_ASSEMBLY_PIPELINE_SCENARIOS: readonly RealAssemblyPipelineScenario[] = [
  {
    id: 'gibson-pcr-pcr',
    label: 'Real Gibson PCR/PCR',
    description: 'Two PCR fragments sliced from pUC19 with circular Gibson homology.',
    buildDesign: () =>
      makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 120, 420),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 900, 420),
        ],
        { assemblyMethod: 'gibson' }
      ),
    expected: {
      method: 'gibson',
      regionSourceTypes: ['pcr', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [0, 1],
      nonEmptyPrimerPairIndices: [0, 1],
      homologyJunctionCount: 2,
      valid: true,
    },
  },
  {
    id: 'gibson-pcr-pcr-spacer',
    label: 'Real Gibson PCR/PCR + spacer',
    description: 'Two pUC19 PCR fragments with a real pUC19-derived spacer at junction 0.',
    buildDesign: () => {
      const spacer = api.realSpacer(realAssemblyPipelineFixtures.puc19, 1820, 6, 0);
      return makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 180, 420),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1040, 420),
        ],
        { assemblyMethod: 'gibson', spacers: [spacer] }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['pcr', 'pcr'],
      spacerSequences: [api.realSpacer(realAssemblyPipelineFixtures.puc19, 1820, 6, 0).sequence],
      primerPairIndices: [0, 1],
      nonEmptyPrimerPairIndices: [0, 1],
      homologyJunctionCount: 2,
      valid: true,
    },
  },
  {
    id: 'gibson-pcr-rd-pcr',
    label: 'Real Gibson PCR/RD/PCR',
    description: 'PCR fragments flanking a real BsmBI restriction digest fragment from pUC19.',
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'BsmBI', 'puc19-bsmbi-rd', {
        minLength: 20,
        noWrap: true,
      });
      return makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 220, 360),
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1500, 360),
        ],
        { assemblyMethod: 'gibson' }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['pcr', 'rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [0, 2],
      nonEmptyPrimerPairIndices: [0, 2],
      homologyJunctionCount: 3,
      valid: true,
    },
  },
  {
    id: 'gibson-pcr-rd-pcr-two-spacers',
    label: 'Real Gibson PCR/RD/PCR + two spacers',
    description:
      'Three pUC19-derived fragments with two real pUC19 spacers, covering spacer index shifts.',
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'BsmBI', 'puc19-bsmbi-rd', {
        minLength: 20,
        noWrap: true,
      });
      const spacer0 = api.realSpacer(realAssemblyPipelineFixtures.puc19, 1912, 5, 0);
      const spacer2 = api.realSpacer(realAssemblyPipelineFixtures.puc19, 2184, 7, 2);
      return makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 240, 360),
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1540, 360),
        ],
        { assemblyMethod: 'gibson', spacers: [spacer0, spacer2] }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['pcr', 'rd', 'pcr'],
      spacerSequences: [
        api.realSpacer(realAssemblyPipelineFixtures.puc19, 1912, 5, 0).sequence,
        api.realSpacer(realAssemblyPipelineFixtures.puc19, 2184, 7, 2).sequence,
      ],
      primerPairIndices: [0, 2],
      nonEmptyPrimerPairIndices: [0, 2],
      homologyJunctionCount: 3,
      valid: true,
    },
  },
  {
    id: 'gibson-rd-5prime-pcr',
    label: "Real Gibson EcoRI 5' RD/PCR",
    description:
      "A one-cut EcoRI RD fragment exercises Gibson's automatic upstream 5' scar chewback.",
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'EcoRI', 'puc19-ecori-rd');
      return makeDesign(
        [
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1500, 420),
        ],
        { assemblyMethod: 'gibson' }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [1],
      nonEmptyPrimerPairIndices: [1],
      homologyJunctionCount: 2,
      rdEndTypesByRegion: ['5_prime', null],
      gibsonTrimByRegion: [5, 0],
      valid: true,
    },
  },
  {
    id: 'gibson-rd-spacer-pcr',
    label: 'Real Gibson RD + spacer + PCR',
    description:
      'A resected real BsmBI RD fragment joined to a PCR product through a real pUC19 spacer.',
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'BsmBI', 'puc19-bsmbi-rd', {
        minLength: 20,
        noWrap: true,
      });
      const spacer = api.realSpacer(realAssemblyPipelineFixtures.puc19, 2020, 5, 0);
      return makeDesign(
        [
          api.resectRd(rd.region, 3, 5),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1600, 420),
        ],
        { assemblyMethod: 'gibson', spacers: [spacer] }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [api.realSpacer(realAssemblyPipelineFixtures.puc19, 2020, 5, 0).sequence],
      primerPairIndices: [1],
      nonEmptyPrimerPairIndices: [1],
      homologyJunctionCount: 2,
      valid: true,
    },
  },
  {
    id: 'gibson-rd-3prime-pcr',
    label: "Real Gibson PstI 3' RD/PCR",
    description:
      "A one-cut PstI RD fragment exercises Gibson's retained 3' overhang scar behavior.",
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'PstI', 'puc19-psti-rd');
      return makeDesign(
        [
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1540, 420),
        ],
        { assemblyMethod: 'gibson' }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [1],
      nonEmptyPrimerPairIndices: [1],
      homologyJunctionCount: 2,
      rdEndTypesByRegion: ['3_prime', null],
      gibsonTrimByRegion: [0, 0],
      valid: true,
    },
  },
  {
    id: 'gibson-rd-blunt-pcr',
    label: 'Real Gibson SmaI blunt RD/PCR',
    description:
      'A one-cut SmaI blunt RD fragment verifies Gibson does not apply sticky-end chewback.',
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'SmaI', 'puc19-smai-rd');
      return makeDesign(
        [
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1580, 420),
        ],
        { assemblyMethod: 'gibson' }
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [1],
      nonEmptyPrimerPairIndices: [1],
      homologyJunctionCount: 2,
      rdEndTypesByRegion: ['blunt', null],
      gibsonTrimByRegion: [0, 0],
      valid: true,
    },
  },
  {
    id: 'gibson-rd-rd-invalid',
    label: 'Real Gibson invalid RD/RD adjacency',
    description: 'Two pUC19 one-cut RD parts side by side should fail homology preflight.',
    buildDesign: () => {
      const left = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'EcoRI', 'puc19-ecori-rd');
      const right = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'PstI', 'puc19-psti-rd');
      return withHomologyRdRdValidationError(
        makeDesign([left.region, right.region], { assemblyMethod: 'gibson' })
      );
    },
    expected: {
      method: 'gibson',
      regionSourceTypes: ['rd', 'rd'],
      spacerSequences: [],
      primerPairIndices: [],
      nonEmptyPrimerPairIndices: [],
      homologyJunctionCount: 0,
      valid: false,
      expectedValidationErrorCodes: ['gibson_rd_rd_junction'],
    },
  },
  {
    id: 'nebuilder-rd-spacer',
    label: 'Real NEBuilder RD + spacer',
    description:
      'A resected real BsmBI RD fragment joined to a PCR product with a real pUC19 spacer.',
    buildDesign: () => {
      const rd = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'BsmBI', 'puc19-bsmbi-rd', {
        minLength: 20,
        noWrap: true,
      });
      const spacer = api.realSpacer(realAssemblyPipelineFixtures.puc19, 2020, 5, 0);
      return makeDesign(
        [
          api.resectRd(rd.region, 3, 5),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1600, 420),
        ],
        { assemblyMethod: 'nebuilder', spacers: [spacer] }
      );
    },
    expected: {
      method: 'nebuilder',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [api.realSpacer(realAssemblyPipelineFixtures.puc19, 2020, 5, 0).sequence],
      primerPairIndices: [1],
      nonEmptyPrimerPairIndices: [1],
      homologyJunctionCount: 2,
      valid: true,
    },
  },
  {
    id: 'nebuilder-rd-rd-invalid',
    label: 'Real NEBuilder invalid RD/RD adjacency',
    description: 'Two pUC19 one-cut RD parts side by side should fail NEBuilder preflight.',
    buildDesign: () => {
      const left = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'EcoRI', 'puc19-ecori-rd');
      const right = api.rdRegion(realAssemblyPipelineFixtures.puc19, 'SmaI', 'puc19-smai-rd');
      return withHomologyRdRdValidationError(
        makeDesign([left.region, right.region], { assemblyMethod: 'nebuilder' })
      );
    },
    expected: {
      method: 'nebuilder',
      regionSourceTypes: ['rd', 'rd'],
      spacerSequences: [],
      primerPairIndices: [],
      nonEmptyPrimerPairIndices: [],
      homologyJunctionCount: 0,
      valid: false,
      expectedValidationErrorCodes: ['gibson_rd_rd_junction'],
    },
  },
  {
    id: 'goldengate-pcr-pcr',
    label: 'Real Golden Gate PCR/PCR',
    description: 'Two pUC19 PCR products with PCR-designed BsmBI overhangs.',
    buildDesign: () =>
      makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 280, 380),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1500, 380),
        ],
        { assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsmBI' }
      ),
    expected: {
      method: 'goldengate',
      regionSourceTypes: ['pcr', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [0, 1],
      nonEmptyPrimerPairIndices: [0, 1],
      goldenGateJunctionCount: 2,
      goldenGateSourceTypes: ['pcr-designed', 'pcr-designed'],
      valid: true,
    },
  },
  {
    id: 'goldengate-pcr-pcr-spacer',
    label: 'Real Golden Gate PCR/PCR + spacer',
    description: 'Two pUC19 PCR products with PCR-designed BsmBI overhangs and a real spacer.',
    buildDesign: () => {
      const spacer = api.realSpacer(realAssemblyPipelineFixtures.puc19, 2108, 6, 0);
      return makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 320, 380),
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1560, 380),
        ],
        { assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsmBI', spacers: [spacer] }
      );
    },
    expected: {
      method: 'goldengate',
      regionSourceTypes: ['pcr', 'pcr'],
      spacerSequences: [api.realSpacer(realAssemblyPipelineFixtures.puc19, 2108, 6, 0).sequence],
      primerPairIndices: [0, 1],
      nonEmptyPrimerPairIndices: [0, 1],
      goldenGateJunctionCount: 2,
      goldenGateSourceTypes: ['pcr-designed', 'pcr-designed'],
      valid: true,
    },
  },
  {
    id: 'goldengate-pcr-rd-pcr',
    label: 'Real Golden Gate PCR/RD/PCR fixed-overhang warning',
    description:
      'pUC19 PCR products flanking a real BsmBI RD fragment whose fixed overhang is unsafe.',
    buildDesign: () => {
      const rd = api.goldenGateRdRegion(
        realAssemblyPipelineFixtures.puc19,
        'BsmBI',
        'puc19-bsmbi-rd',
        { minLength: 20 }
      );
      return makeDesign(
        [
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-left', 280, 380),
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1500, 380),
        ],
        { assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsmBI' }
      );
    },
    expected: {
      method: 'goldengate',
      regionSourceTypes: ['pcr', 'rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [0, 1, 2],
      nonEmptyPrimerPairIndices: [0, 2],
      goldenGateJunctionCount: 3,
      goldenGateSourceTypes: ['pcr-matched-rd', 'pcr-matched-rd', 'pcr-designed'],
      valid: false,
      validationValid: true,
      expectedInvalidJunctionErrors: [
        'Palindromic overhang: CGCG (risk of self-ligation)',
        'Fixed RD overhang TCCC does not match assembled product window GAAA',
      ],
    },
  },
  {
    id: 'goldengate-rd-enzyme-mismatch-invalid',
    label: 'Real Golden Gate BsmBI RD under BsaI invalid',
    description: 'A real BsmBI RD fragment must not be accepted into a BsaI Golden Gate assembly.',
    buildDesign: () => {
      const rd = api.goldenGateRdRegion(
        realAssemblyPipelineFixtures.puc19,
        'BsmBI',
        'puc19-bsmbi-rd',
        { minLength: 20 }
      );
      return makeDesign(
        [
          rd.region,
          api.pcrRegion(realAssemblyPipelineFixtures.puc19, 'puc19-pcr-right', 1500, 380),
        ],
        { assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsaI' }
      );
    },
    expected: {
      method: 'goldengate',
      regionSourceTypes: ['rd', 'pcr'],
      spacerSequences: [],
      primerPairIndices: [],
      nonEmptyPrimerPairIndices: [],
      valid: false,
      expectedConflictTypes: ['rd-enzyme-mismatch', 'rd-cut-site-mismatch'],
    },
  },
  {
    id: 'goldengate-invalid-internal-site',
    label: 'Real Golden Gate internal-site warning',
    description: 'A pUC19 PCR region intentionally spanning a real BsmBI site.',
    buildDesign: () =>
      makeDesign(
        [
          api.pcrRegionAroundFirstSite(
            realAssemblyPipelineFixtures.puc19,
            'BsmBI',
            'puc19-site',
            180
          ),
        ],
        { assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsmBI' }
      ),
    expected: {
      method: 'goldengate',
      regionSourceTypes: ['pcr'],
      spacerSequences: [],
      primerPairIndices: [],
      nonEmptyPrimerPairIndices: [],
      goldenGateJunctionCount: 0,
      goldenGateSourceTypes: [],
      valid: false,
      expectedConflictTypes: ['internal-site'],
    },
  },
] as const;

export function realAssemblyPipelineScenarioById(
  id: RealAssemblyPipelineScenarioId
): RealAssemblyPipelineScenario {
  const scenario = REAL_ASSEMBLY_PIPELINE_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown real assembly pipeline scenario: ${id}`);
  return scenario;
}

export function buildRealAssemblyPipelineDesign(
  id: RealAssemblyPipelineScenarioId,
  options: { drafted?: boolean } = {}
): SequenceDesign {
  const scenario = realAssemblyPipelineScenarioById(id);
  const design = withStableDesignId(scenario.buildDesign(), id);
  if (options.drafted === false || !scenario.expected.valid) return design;

  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

export function realAssemblyPipelineAppScenario(
  id: RealAssemblyPipelineScenarioId,
  options: { drafted?: boolean } = {}
): AppScenario {
  const design = buildRealAssemblyPipelineDesign(id, options);
  return {
    canvas: {
      tabs: [
        { type: 'design', entityId: design.id, label: realAssemblyPipelineScenarioById(id).label },
      ],
    },
    sequences: {
      [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequenceFixtureToAnnotatedSequence(
        realAssemblyPipelineFixtures.puc19
      ),
    },
    sequenceSources: REAL_ASSEMBLY_PIPELINE_SEQUENCE_SOURCES,
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
    files: {
      [REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH]: PUC19_GB,
    },
  };
}

export const realAssemblyGibsonPcrPcr = () => realAssemblyPipelineAppScenario('gibson-pcr-pcr');
export const realAssemblyGibsonPcrPcrSpacer = () =>
  realAssemblyPipelineAppScenario('gibson-pcr-pcr-spacer');
export const realAssemblyGibsonPcrPcrSpacerFinalization = (): AppScenario => {
  const runId = crypto.randomUUID();
  const scenario = realAssemblyPipelineAppScenario('gibson-pcr-pcr-spacer');
  const seededDesign = Object.values(scenario.designs?.designs ?? {})[0];
  if (!seededDesign) throw new Error('Finalization scenario is missing its assembly design.');
  const design = { ...seededDesign, id: `${seededDesign.id}:${runId}` };
  return {
    ...scenario,
    canvas: {
      ...scenario.canvas,
      tabs: [{ type: 'design', entityId: design.id, label: design.name }],
    },
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
    dev: {
      scenarioId: `real-assembly-gibson-pcr-pcr-spacer-finalization-${runId}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize finalization scenario',
      materializeDesignArtifacts: true,
    },
    workspace: {
      folders: [{ path: '/workspace/real-fixtures', name: 'real-fixtures' }],
      selectedPath: REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH,
    },
  };
};
export const realAssemblyGibsonPcrRdPcr = () =>
  realAssemblyPipelineAppScenario('gibson-pcr-rd-pcr');
export const realAssemblyGibsonPcrRdPcrTwoSpacers = () =>
  realAssemblyPipelineAppScenario('gibson-pcr-rd-pcr-two-spacers');
export const realAssemblyGibsonRd5PrimePcr = () =>
  realAssemblyPipelineAppScenario('gibson-rd-5prime-pcr');
export const realAssemblyGibsonRdSpacerPcr = () =>
  realAssemblyPipelineAppScenario('gibson-rd-spacer-pcr');
export const realAssemblyGibsonRd3PrimePcr = () =>
  realAssemblyPipelineAppScenario('gibson-rd-3prime-pcr');
export const realAssemblyGibsonRdBluntPcr = () =>
  realAssemblyPipelineAppScenario('gibson-rd-blunt-pcr');
export const realAssemblyGibsonRdRdInvalid = () =>
  realAssemblyPipelineAppScenario('gibson-rd-rd-invalid');
export const realAssemblyNebuilderRdSpacer = () =>
  realAssemblyPipelineAppScenario('nebuilder-rd-spacer');
export const realAssemblyNebuilderRdRdInvalid = () =>
  realAssemblyPipelineAppScenario('nebuilder-rd-rd-invalid');
export const realAssemblyGoldenGatePcrPcr = () =>
  realAssemblyPipelineAppScenario('goldengate-pcr-pcr');
function assemblyCrossoverShowcase(
  scenarioId: 'assembly-ui-cleanup-showcase' | 'assembly-crossover-editing-showcase'
): AppScenario {
  const scenario = realAssemblyPipelineAppScenario('goldengate-pcr-pcr');
  const design = scenario.designs?.designs[scenario.designs.activeDesignId ?? ''];
  const originalLeft = design?.regions[0];
  const originalRight = design?.regions[1];
  if (!scenario.designs || !design || !originalLeft || !originalRight) {
    throw new Error('Assembly UI cleanup scenario requires a real source region.');
  }

  const fragmentLength = originalLeft.sequence.length;
  let crossoverRegions: DesignRegion[] | null = null;
  const regionSpecs =
    scenarioId === 'assembly-ui-cleanup-showcase'
      ? [
          { id: originalLeft.id, length: fragmentLength },
          { id: originalRight.id, length: fragmentLength },
        ]
      : [
          { id: originalLeft.id, length: 240 },
          { id: 'puc19-crossover-inner-left', length: 320 },
          { id: 'puc19-crossover-inner-right', length: 440 },
          { id: originalRight.id, length: 600 },
        ];
  const crossoverLength = regionSpecs.reduce((total, region) => total + region.length, 0);
  for (
    let start = 0;
    start + crossoverLength <= realAssemblyPipelineFixtures.puc19.parsed.sequence.length;
    start += 1
  ) {
    const fullWindow = api.pcrRegion(
      realAssemblyPipelineFixtures.puc19,
      'puc19-crossover-window',
      start,
      crossoverLength
    );
    if (checkInternalSitesInPcrRegions([fullWindow], 'BsmBI').length > 0) continue;

    let regionStart = start;
    crossoverRegions = regionSpecs.map((region) => {
      const crossoverRegion = api.pcrRegion(
        realAssemblyPipelineFixtures.puc19,
        region.id,
        regionStart,
        region.length
      );
      regionStart += region.length;
      return crossoverRegion;
    });
    break;
  }
  if (!crossoverRegions) {
    throw new Error('Assembly UI cleanup scenario requires a BsmBI-clean pUC19 window.');
  }

  const [crossoverLeft] = crossoverRegions;
  const crossoverDesignBase: SequenceDesign = {
    ...design,
    regions: crossoverRegions,
  };
  const crossoverDraft = computeDraftAssembly(crossoverDesignBase);
  const crossoverDesign: SequenceDesign = {
    ...crossoverDesignBase,
    designPrimers: crossoverDraft.designPrimers,
    goldenGateJunctions: crossoverDraft.goldenGateJunctions,
  };

  return {
    ...scenario,
    dev: { scenarioId },
    designs: {
      ...scenario.designs,
      designs: {
        ...scenario.designs.designs,
        [design.id]: crossoverDesign,
      },
      lastCopied: normalizeRichSequenceFragment({
        sequence: crossoverLeft.sequence,
        sourceSequence:
          crossoverLeft.sourceSequence ?? realAssemblyPipelineFixtures.puc19.parsed.sequence,
        sourceId: crossoverLeft.sourceSequenceId,
        sourceName: 'pUC19 PCR fragment',
        start: crossoverLeft.sourceStart,
        end: crossoverLeft.sourceEnd,
        annotations: [],
        sourceAnnotations: crossoverLeft.sourceAnnotations,
        sourceIsCircular: crossoverLeft.sourceIsCircular,
        sourceType: 'pcr',
      }),
    },
  };
}
export function assemblyUiCleanupShowcase(): AppScenario {
  return assemblyCrossoverShowcase('assembly-ui-cleanup-showcase');
}
export function assemblyCrossoverEditingShowcase(): AppScenario {
  return assemblyCrossoverShowcase('assembly-crossover-editing-showcase');
}

const CIDAR_MOCLO_RED_TU_FIXTURES = {
  promoter: mocloFixture(
    CIDAR_MOCLO_RED_TU_PACKAGE_IDS.promoter,
    'J23106_AB',
    J23106_AB_GB,
    CIDAR_MOCLO_RED_TU_PATHS.promoter
  ),
  rbs: mocloFixture(
    CIDAR_MOCLO_RED_TU_PACKAGE_IDS.rbs,
    'B0034m_BC',
    B0034M_BC_GB,
    CIDAR_MOCLO_RED_TU_PATHS.rbs
  ),
  cds: mocloFixture(
    CIDAR_MOCLO_RED_TU_PACKAGE_IDS.cds,
    'E1010m_CD',
    E1010M_CD_GB,
    CIDAR_MOCLO_RED_TU_PATHS.cds
  ),
  terminator: mocloFixture(
    CIDAR_MOCLO_RED_TU_PACKAGE_IDS.terminator,
    'B0015_DE',
    B0015_DE_GB,
    CIDAR_MOCLO_RED_TU_PATHS.terminator
  ),
  destinationVector: mocloFixture(
    CIDAR_MOCLO_RED_TU_PACKAGE_IDS.destinationVector,
    'DVA_AE',
    DVA_AE_GB,
    CIDAR_MOCLO_RED_TU_PATHS.destinationVector
  ),
} satisfies Record<keyof typeof CIDAR_MOCLO_RED_TU_PACKAGE_IDS, SequenceFixture>;

const cidarMocloApi = createAssemblyFixtureApi(CIDAR_MOCLO_RED_TU_FIXTURES);

export function cidarMocloRedFluorescentTu(): AppScenario {
  const definition = parseMocloKitDefinition(CIDAR_KIT_DEFINITION_RAW);
  const schemaOption = mocloAssemblySchemaOptions(definition).find(
    ({ schema }) => schema.id === 'moclo-cidar:transcription-unit'
  );
  if (!schemaOption) throw new Error('The CIDAR fixture is missing its transcription-unit schema.');
  const schema = schemaOption.schema;
  const regions = linkRegionsToSchema(
    [
      cidarMocloRegion(CIDAR_MOCLO_RED_TU_FIXTURES.promoter, 'cidar-j23106-ab'),
      cidarMocloRegion(CIDAR_MOCLO_RED_TU_FIXTURES.rbs, 'cidar-b0034m-bc'),
      cidarMocloRegion(CIDAR_MOCLO_RED_TU_FIXTURES.cds, 'cidar-e1010m-cd'),
      cidarMocloRegion(CIDAR_MOCLO_RED_TU_FIXTURES.terminator, 'cidar-b0015-de'),
      cidarMocloRegion(
        CIDAR_MOCLO_RED_TU_FIXTURES.destinationVector,
        'cidar-dva-ae-backbone',
        'backbone'
      ),
    ],
    schema
  );

  const baseDesign = cidarMocloApi.design(regions, {
    assemblyMethod: 'goldengate',
    goldenGateEnzyme: 'BsaI',
  });
  const draft = computeDraftAssembly(baseDesign);
  const design: SequenceDesign = {
    ...baseDesign,
    id: CIDAR_MOCLO_RED_TU_DESIGN_ID,
    name: 'CIDAR MoClo — red fluorescent transcription unit',
    backboneSequenceId: CIDAR_MOCLO_RED_TU_PACKAGE_IDS.destinationVector,
    goldenGateSchema: schema,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers.filter(
      (pair) => pair.forward.sequence.length > 0 || pair.reverse.sequence.length > 0
    ),
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };

  return {
    canvas: {
      tabs: [{ type: 'design', entityId: design.id, label: design.name }],
    },
    sequences: Object.fromEntries(
      Object.values(CIDAR_MOCLO_RED_TU_FIXTURES).map((fixture) => [
        fixture.id,
        sequenceFixtureToAnnotatedSequence(fixture),
      ])
    ),
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
    files: mocloPackageFiles(CIDAR_MOCLO_WORKSPACE_FILES),
    workspace: {
      folders: [{ path: '/workspace', name: 'CIDAR MoClo' }],
      selectedPath: '/workspace',
    },
    dev: { scenarioId: 'cidar-moclo-red-fluorescent-tu' },
  };
}

function mocloPackageFiles(resources: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(resources).map(([resourcePath, content]) => {
      if (!resourcePath.startsWith(SAMPLE_WORKSPACE_RESOURCE_PREFIX)) {
        throw new Error(`MoClo resource is outside the sample workspace: ${resourcePath}`);
      }
      return [`/workspace/${resourcePath.slice(SAMPLE_WORKSPACE_RESOURCE_PREFIX.length)}`, content];
    })
  );
}

const YTK_MOCLO_FACTORY_FIXTURES = {
  promoter: mocloFixture(
    YTK_MOCLO_FACTORY_PACKAGE_IDS.promoter,
    'pYTK009',
    PYTK009_GB,
    YTK_MOCLO_FACTORY_PATHS.promoter
  ),
  codingSequence: mocloFixture(
    YTK_MOCLO_FACTORY_PACKAGE_IDS.codingSequence,
    'pYTK033',
    PYTK033_GB,
    YTK_MOCLO_FACTORY_PATHS.codingSequence
  ),
  terminator: mocloFixture(
    YTK_MOCLO_FACTORY_PACKAGE_IDS.terminator,
    'pYTK051',
    PYTK051_GB,
    YTK_MOCLO_FACTORY_PATHS.terminator
  ),
  cassetteVector: mocloFixture(
    YTK_MOCLO_FACTORY_PACKAGE_IDS.cassetteVector,
    'pYTK096',
    PYTK096_GB,
    YTK_MOCLO_FACTORY_PATHS.cassetteVector
  ),
} satisfies Record<keyof typeof YTK_MOCLO_FACTORY_PACKAGE_IDS, SequenceFixture>;

const ytkMocloApi = createAssemblyFixtureApi(YTK_MOCLO_FACTORY_FIXTURES);

export function ytkMocloFactoryExpressionCassette(): AppScenario {
  const definition = parseMocloKitDefinition(YTK_KIT_DEFINITION_RAW);
  const recipe = definition.recipes.find((candidate) => candidate.id === 'ytk-multigene-device');
  if (!recipe) throw new Error('The YTK factory fixture is missing its hierarchical recipe.');
  const stage = findMocloKitStage(definition, recipe.id, 'expression-cassette');
  const schema = schemaForMocloStage(definition, stage);
  const regions = linkRegionsToSchema(
    [
      ytkMocloRegion(YTK_MOCLO_FACTORY_FIXTURES.promoter, 'ytk-type-2-promoter'),
      ytkMocloRegion(YTK_MOCLO_FACTORY_FIXTURES.codingSequence, 'ytk-type-3-cds'),
      ytkMocloRegion(YTK_MOCLO_FACTORY_FIXTURES.terminator, 'ytk-type-4-terminator'),
      ytkMocloRegion(YTK_MOCLO_FACTORY_FIXTURES.cassetteVector, 'ytk-cassette-vector'),
    ],
    schema
  );
  const baseDesign = ytkMocloApi.design(regions, {
    assemblyMethod: 'goldengate',
    goldenGateEnzyme: stage.enzyme,
  });
  const draft = computeDraftAssembly(baseDesign);
  const design: SequenceDesign = {
    ...baseDesign,
    id: YTK_MOCLO_FACTORY_DESIGN_ID,
    name: 'YTK MoClo factory — Venus expression cassette',
    backboneSequenceId: YTK_MOCLO_FACTORY_PACKAGE_IDS.cassetteVector,
    goldenGateSchema: schema,
    mocloFactory: {
      runId: YTK_MOCLO_FACTORY_RUN_ID,
      kitId: definition.id,
      kitRevision: definition.revision,
      recipeId: recipe.id,
      stageId: stage.id,
      stageInputs: [{ slotId: 'cassette-vector-output', sourceStageId: 'cassette-vector' }],
    },
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers.filter(
      (pair) => pair.forward.sequence.length > 0 || pair.reverse.sequence.length > 0
    ),
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };

  return {
    canvas: {
      tabs: [{ type: 'design', entityId: design.id, label: design.name }],
    },
    sequences: Object.fromEntries(
      Object.values(YTK_MOCLO_FACTORY_FIXTURES).map((fixture) => [
        fixture.id,
        sequenceFixtureToAnnotatedSequence(fixture),
      ])
    ),
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
    files: mocloPackageFiles(YTK_MOCLO_WORKSPACE_FILES),
    workspace: {
      folders: [{ path: '/workspace', name: 'YTK MoClo factory' }],
      selectedPath: '/workspace',
    },
    dev: { scenarioId: 'ytk-moclo-factory-expression-cassette', initializeGit: true },
  };
}

function asPcrProducedRegion(region: DesignRegion): DesignRegion {
  const pcrRegion: DesignRegion = { ...region, sourceType: 'pcr' };
  delete pcrRegion.ggType;
  delete pcrRegion.rdOverhangs;
  delete pcrRegion.rdSourceEnzyme;
  delete pcrRegion.rdSourceEnzymeName;
  delete pcrRegion.rdEnds;
  delete pcrRegion.rdSiblingOverhangs;
  return pcrRegion;
}

export function cidarMocloMixedRouteRedFluorescentTu(): AppScenario {
  const digestScenario = cidarMocloRedFluorescentTu();
  const digestDesign = digestScenario.designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
  if (!digestScenario.designs || !digestDesign) {
    throw new Error('Mixed-route CIDAR scenario requires the real digest design.');
  }

  const regions = digestDesign.regions.map((region, index) =>
    index === 0 || index === 2 ? asPcrProducedRegion(region) : region
  );
  const baseDesign: SequenceDesign = {
    ...digestDesign,
    id: CIDAR_MOCLO_MIXED_ROUTE_RED_TU_DESIGN_ID,
    name: 'CIDAR MoClo — mixed PCR and digest routes',
    regions,
    designPrimers: [],
    goldenGateJunctions: [],
  };
  const draft = computeDraftAssembly(baseDesign);
  const design: SequenceDesign = {
    ...baseDesign,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    version: baseDesign.version + 1,
  };

  return {
    ...digestScenario,
    canvas: {
      tabs: [{ type: 'design', entityId: design.id, label: design.name }],
    },
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
  };
}

export const realAssemblyGoldenGatePcrPcrSpacer = () =>
  realAssemblyPipelineAppScenario('goldengate-pcr-pcr-spacer');
export const realAssemblyGoldenGatePcrRdPcr = () =>
  realAssemblyPipelineAppScenario('goldengate-pcr-rd-pcr');
export const realAssemblyGoldenGateRdEnzymeMismatchInvalid = () =>
  realAssemblyPipelineAppScenario('goldengate-rd-enzyme-mismatch-invalid');
export const realAssemblyGoldenGateInternalSite = () =>
  realAssemblyPipelineAppScenario('goldengate-invalid-internal-site');

export function realAssemblyManyTabsAppScenario(count = 8): AppScenario {
  const pool = REAL_ASSEMBLY_PIPELINE_SCENARIOS.filter((scenario) => scenario.expected.valid).map(
    (scenario) => scenario.id
  );
  const ids = pool.slice(0, Math.max(1, Math.min(count, pool.length)));
  const designs = ids.map((id) => buildRealAssemblyPipelineDesign(id));
  const middle = Math.floor(designs.length / 2);

  return {
    canvas: {
      tabs: designs.map((design, i) => ({
        type: 'design' as const,
        entityId: design.id,
        label: `${i + 1}. ${realAssemblyPipelineScenarioById(ids[i]).label}`,
      })),
      activeTabIndex: middle,
    },
    sequences: {
      [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequenceFixtureToAnnotatedSequence(
        realAssemblyPipelineFixtures.puc19
      ),
    },
    sequenceSources: REAL_ASSEMBLY_PIPELINE_SEQUENCE_SOURCES,
    designs: {
      designs: Object.fromEntries(designs.map((design) => [design.id, design])),
      activeDesignId: designs[middle].id,
    },
    files: {
      [REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH]: PUC19_GB,
    },
  };
}

export const realAssemblyManyTabs = () => realAssemblyManyTabsAppScenario(8);
export const realAssemblyManyTabsStress = () => realAssemblyManyTabsAppScenario(11);

export const realAssemblyPipelineDevScenarios = {
  realAssemblyManyTabs,
  realAssemblyManyTabsStress,
  realAssemblyGibsonPcrPcr,
  realAssemblyGibsonPcrPcrSpacer,
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
  realAssemblyGoldenGatePcrPcr,
  realAssemblyGoldenGatePcrPcrSpacer,
  realAssemblyGoldenGatePcrRdPcr,
  realAssemblyGoldenGateRdEnzymeMismatchInvalid,
  realAssemblyGoldenGateInternalSite,
};

function createRealAssemblyPipelineFixtures(): { puc19: SequenceFixture } {
  const parsed = parseGenBankFull(PUC19_GB);
  return {
    puc19: normalizeFixture({
      id: REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
      label: 'pUC19',
      source: 'test-fixtures/sequences/circular/pUC19.gb',
      parsed,
    }),
  };
}

function mocloFixture(
  id: string,
  label: string,
  genBank: string,
  sourcePath: string = id
): SequenceFixture {
  return normalizeFixture({
    id,
    label,
    source: sourcePath.replace(/^\/workspace\//, ''),
    parsed: parseGenBankFull(genBank),
  });
}

function ytkMocloRegion(fixture: SequenceFixture, id: string): DesignRegion {
  const region = ytkMocloApi.goldenGateRdRegion(fixture, 'BsaI', id, {
    ggType: 'insert',
  }).region;
  return { ...region, sourceSequenceName: fixture.label };
}

function cidarMocloRegion(
  fixture: SequenceFixture,
  id: string,
  ggType: 'insert' | 'backbone' = 'insert'
): DesignRegion {
  const region = cidarMocloApi.goldenGateRdRegion(fixture, 'BsaI', id, { ggType }).region;
  return { ...region, sourceSequenceName: fixture.label };
}

function linkRegionsToSchema(
  regions: readonly DesignRegion[],
  schema: GoldenGateAssemblySchema
): DesignRegion[] {
  if (regions.length !== schema.slots.length) {
    throw new Error(`Schema “${schema.id}” does not match its fixture part count.`);
  }
  return regions.map((region, index) => ({ ...region, schemaSlotId: schema.slots[index].id }));
}

function makeDesign(
  regions: DesignRegion[],
  options: {
    assemblyMethod: AssemblyMethod;
    spacers?: DesignSpacer[];
    goldenGateEnzyme?: GoldenGateEnzyme;
  }
): SequenceDesign {
  return api.design(regions, options);
}

function withHomologyRdRdValidationError(design: SequenceDesign): SequenceDesign {
  const validationError: ValidationError = {
    code: 'gibson_rd_rd_junction',
    severity: 'error',
    message:
      'Homology assembly cannot place two restriction digest fragments next to each other unless ' +
      'their physical ends already contain the required homology. Put a PCR fragment between them for now.',
    field: 'regions[0]',
    fragmentIndex: 0,
  };

  return {
    ...design,
    validationErrors: [validationError],
    assemblyState: 'drafting',
    status: 'draft',
    homologyRegions: [],
    designPrimers: [],
  };
}

function withStableDesignId(
  design: SequenceDesign,
  scenarioId: RealAssemblyPipelineScenarioId
): SequenceDesign {
  return {
    ...design,
    id: `${REAL_ASSEMBLY_PIPELINE_DESIGN_ID}:${scenarioId}`,
    name: realAssemblyPipelineScenarioById(scenarioId).label,
  };
}

function sequenceFixtureToAnnotatedSequence(fixture: SequenceFixture) {
  return {
    ...fixture.parsed,
    id: fixture.id,
    name: fixture.label,
    circular: true,
  };
}

export const CDS_EXTENSION_DOCUMENT_ID = 'test-sequence:cds-extension:pUC19-clipped-ampr';
const CDS_EXTENSION_SEQUENCE_PATH = '/workspace/real-fixtures/pUC19-clipped-ampr.gb';

const CLIPPED_AMPR_START = 1314;
const CLIPPED_AMPR_END = 2111;

function clippedAmprGenBank(): string {
  const before = 'CDS             join(1284..1352,1353..2144)';
  const after = `CDS             ${CLIPPED_AMPR_START}..${CLIPPED_AMPR_END}`;
  if (!PUC19_GB.includes(before)) {
    throw new Error('pUC19 fixture no longer has the AmpR CDS this scenario clips.');
  }
  return PUC19_GB.replace(before, after).replace('/label=AmpR\n', '/label=AmpR (clipped)\n');
}

export function cdsExtensionIncompleteCdsScenario(): AppScenario {
  const fixture = normalizeFixture(realAssemblyPipelineFixtures.puc19);
  const parsed = sequenceFixtureToAnnotatedSequence(fixture);
  const annotations = (parsed.annotations ?? []).map((annotation) => {
    if (annotation.type !== 'CDS' || annotation.name !== 'AmpR') return annotation;
    return {
      ...annotation,
      name: 'AmpR (clipped)',
      start: CLIPPED_AMPR_START,
      end: CLIPPED_AMPR_END,
      segments: undefined,
      qualifiers: { ...(annotation.qualifiers ?? {}), codon_start: ['1'] },
    };
  });

  return {
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: CDS_EXTENSION_DOCUMENT_ID,
          label: 'pUC19 — AmpR clipped',
          sequenceDocument: { kind: 'catalog-sequence', entityId: CDS_EXTENSION_DOCUMENT_ID },
        },
      ],
    },
    sequences: {
      [CDS_EXTENSION_DOCUMENT_ID]: { ...parsed, id: CDS_EXTENSION_DOCUMENT_ID, annotations },
    },
    sequenceSources: {
      [CDS_EXTENSION_DOCUMENT_ID]: {
        sourcePath: CDS_EXTENSION_SEQUENCE_PATH,
        name: 'pUC19 — AmpR clipped',
      },
    },
    files: { [CDS_EXTENSION_SEQUENCE_PATH]: clippedAmprGenBank() },
    dev: { scenarioId: 'cds-extension-incomplete-cds' },
  };
}

export const CDS_EXTENSION_ORIGIN_DOCUMENT_ID = 'test-sequence:cds-extension:pUC19-origin-span';
const CDS_EXTENSION_ORIGIN_PATH = '/workspace/real-fixtures/pUC19-origin-span.gb';

const ORIGIN_CDS_START = 2569;
const ORIGIN_CDS_END = 2686;

function originSpanningGenBank(): string {
  const marker = '     CDS             615..938\n';
  if (!PUC19_GB.includes(marker)) {
    throw new Error('pUC19 fixture no longer has the lacZ CDS this scenario anchors on.');
  }
  const feature =
    `     CDS             ${ORIGIN_CDS_START}..${ORIGIN_CDS_END}\n` +
    '                     /codon_start=1\n' +
    '                     /label=origin runner\n' +
    '                     /note=": frame finishes past the origin"\n';
  return PUC19_GB.replace(marker, feature + marker);
}

export function cdsExtensionOriginSpanScenario(): AppScenario {
  const fixture = normalizeFixture(realAssemblyPipelineFixtures.puc19);
  const parsed = sequenceFixtureToAnnotatedSequence(fixture);
  const annotations = [
    ...(parsed.annotations ?? []),
    {
      name: 'origin runner',
      type: 'CDS',
      start: ORIGIN_CDS_START,
      end: ORIGIN_CDS_END,
      direction: 1 as const,
      color: '#8B5CF6',
      qualifiers: { codon_start: ['1'] },
    },
  ];

  return {
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: CDS_EXTENSION_ORIGIN_DOCUMENT_ID,
          label: 'pUC19 — origin runner',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: CDS_EXTENSION_ORIGIN_DOCUMENT_ID,
          },
        },
      ],
    },
    sequences: {
      [CDS_EXTENSION_ORIGIN_DOCUMENT_ID]: {
        ...parsed,
        id: CDS_EXTENSION_ORIGIN_DOCUMENT_ID,
        circular: true,
        annotations,
      },
    },
    sequenceSources: {
      [CDS_EXTENSION_ORIGIN_DOCUMENT_ID]: {
        sourcePath: CDS_EXTENSION_ORIGIN_PATH,
        name: 'pUC19 — origin runner',
      },
    },
    files: { [CDS_EXTENSION_ORIGIN_PATH]: originSpanningGenBank() },
    dev: { scenarioId: 'cds-extension-origin-span' },
  };
}

function syntheticCircularGenBank(
  name: string,
  sequence: string,
  cds: {
    start: number;
    end: number;
    label: string;
    note: string;
  }
): string {
  const lines: string[] = [];
  lines.push(
    `LOCUS       ${name.padEnd(16)}${String(sequence.length).padStart(7)} bp    DNA     circular SYN`
  );
  lines.push(`DEFINITION  ${cds.note}`);
  lines.push('FEATURES             Location/Qualifiers');
  lines.push(`     CDS             ${cds.start}..${cds.end}`);
  lines.push('                     /codon_start=1');
  lines.push(`                     /label=${cds.label}`);
  lines.push(`                     /note="${cds.note}"`);
  lines.push('ORIGIN');
  for (let offset = 0; offset < sequence.length; offset += 60) {
    const chunk = sequence.slice(offset, offset + 60);
    const groups: string[] = [];
    for (let i = 0; i < chunk.length; i += 10) groups.push(chunk.slice(i, i + 10));
    lines.push(`${String(offset + 1).padStart(9)} ${groups.join(' ')}`.toLowerCase());
  }
  lines.push('//');
  return lines.join('\n') + '\n';
}

function codonMolecule(codonCount: number, placements: Array<[number, string]>): string {
  const codons = new Array<string>(codonCount).fill('CCC');
  for (const [slot, triplet] of placements) codons[slot] = triplet;
  return codons.join('');
}

function cdsExtensionSyntheticScenario(options: {
  documentId: string;
  path: string;
  label: string;
  sequence: string;
  cdsStart: number;
  cdsEnd: number;
  note: string;
  scenarioId: string;
}): AppScenario {
  const genbank = syntheticCircularGenBank(options.label, options.sequence, {
    start: options.cdsStart,
    end: options.cdsEnd,
    label: options.label,
    note: options.note,
  });
  return {
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: options.documentId,
          label: options.label,
          sequenceDocument: { kind: 'catalog-sequence', entityId: options.documentId },
        },
      ],
    },
    sequences: {
      [options.documentId]: {
        id: options.documentId,
        name: options.label,
        sequence: options.sequence,
        length: options.sequence.length,
        circular: true,
        annotations: [
          {
            name: options.label,
            type: 'CDS',
            start: options.cdsStart,
            end: options.cdsEnd,
            direction: 1 as const,
            color: '#8B5CF6',
            qualifiers: { codon_start: ['1'] },
          },
        ],
      },
    },
    sequenceSources: {
      [options.documentId]: { sourcePath: options.path, name: options.label },
    },
    files: { [options.path]: genbank },
    dev: { scenarioId: options.scenarioId },
  };
}

export const CDS_EXTENSION_STOP_JUST_PAST_DOCUMENT_ID =
  'test-sequence:cds-extension:stop-just-past-origin';

export function cdsExtensionStopJustPastOriginScenario(): AppScenario {
  const sequence = codonMolecule(100, [[2, 'TAA']]);
  return cdsExtensionSyntheticScenario({
    documentId: CDS_EXTENSION_STOP_JUST_PAST_DOCUMENT_ID,
    path: '/workspace/real-fixtures/stop-just-past-origin.gb',
    label: 'stop just past origin',
    sequence,
    cdsStart: 151,
    cdsEnd: 300,
    note: ': frame resumes at base 1 and stops at 7..9, clear of the join',
    scenarioId: 'cds-extension-stop-just-past-origin',
  });
}

export const CDS_EXTENSION_STOP_FAR_PAST_DOCUMENT_ID =
  'test-sequence:cds-extension:stop-far-past-origin';

export function cdsExtensionStopFarPastOriginScenario(): AppScenario {
  const sequence = codonMolecule(300, [[100, 'TAA']]);
  return cdsExtensionSyntheticScenario({
    documentId: CDS_EXTENSION_STOP_FAR_PAST_DOCUMENT_ID,
    path: '/workspace/real-fixtures/stop-far-past-origin.gb',
    label: 'stop far past origin',
    sequence,
    cdsStart: 400,
    cdsEnd: 900,
    note: ': frame runs 100 codons past the origin before stopping at 301..303',
    scenarioId: 'cds-extension-stop-far-past-origin',
  });
}

export function assemblyCutGeneAcrossJunctionScenario(): AppScenario {
  const fixture = realAssemblyPipelineFixtures.puc19;
  const source = fixture.parsed.sequence;
  const sourceAnnotations = fixture.parsed.annotations.map((annotation) => ({
    name: annotation.name,
    type: annotation.type,
    start: Math.max(0, annotation.start - 1),
    end: annotation.end,
    strand:
      annotation.direction === 1
        ? ('forward' as const)
        : annotation.direction === -1
          ? ('reverse' as const)
          : ('none' as const),
    color: annotation.color,
  }));

  const leftStart = 1199;
  const leftEnd = 1800;
  const rightStart = 2299;
  const rightEnd = 2600;

  const clippedAnnotations = (sourceStart: number, sourceEnd: number) =>
    sourceAnnotations
      .filter((a) => a.end > sourceStart && a.start < sourceEnd)
      .map((a) => ({
        ...a,
        start: Math.max(0, a.start - sourceStart),
        end: Math.min(sourceEnd, a.end) - sourceStart,
      }))
      .filter((a) => a.end > a.start);

  const region = (
    id: string,
    colorIndex: number,
    sourceStart: number,
    sourceEnd: number
  ): DesignRegion => ({
    id,
    colorIndex,
    sourceSequenceId: REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
    sourceSequenceName: 'pUC19',
    sourceStart,
    sourceEnd,
    sequence: source.slice(sourceStart, sourceEnd),
    annotations: clippedAnnotations(sourceStart, sourceEnd),
    sourceSequence: source,
    sourceAnnotations,
    sourceIsCircular: true,
    sourceType: 'pcr',
  });

  const base: SequenceDesign = {
    id: 'assembly-cut-gene-across-junction',
    name: 'AmpR cut across junction',
    topology: 'circular',
    regions: [
      region('ampr-first-half', 0, leftStart, leftEnd),
      region('downstream-backbone', 1, rightStart, rightEnd),
    ],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
    updatedAt: new Date('2026-09-15T00:00:00.000Z'),
  } as SequenceDesign;

  const draft = computeDraftAssembly(base);
  const design: SequenceDesign = {
    ...base,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };

  return {
    canvas: {
      tabs: [{ type: 'design', entityId: design.id, label: design.name }],
    },
    sequences: {
      [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequenceFixtureToAnnotatedSequence(fixture),
    },
    sequenceSources: REAL_ASSEMBLY_PIPELINE_SEQUENCE_SOURCES,
    designs: {
      designs: { [design.id]: design },
      activeDesignId: design.id,
    },
    files: {
      [REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH]: PUC19_GB,
    },
  };
}
