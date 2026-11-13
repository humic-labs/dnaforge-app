import type {
  AssemblyMethod,
  DesignAnnotation,
  GoldenGateEnzyme,
  GoldenGateConfig,
  HomologyEncoding,
} from '../design/public/types';

export const ASSEMBLY_WORKBENCH_CONTRACT_VERSION = 5;
export const GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP = 24;
export const GOLDEN_GATE_OFFSET_LIMIT_MIN_BP = 4;
export const GOLDEN_GATE_OFFSET_LIMIT_MAX_BP = 200;

export function goldenGateOffsetLimitBp(config?: Pick<GoldenGateConfig, 'offsetLimitBp'> | null) {
  const raw = config?.offsetLimitBp;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP;
  return Math.max(
    GOLDEN_GATE_OFFSET_LIMIT_MIN_BP,
    Math.min(GOLDEN_GATE_OFFSET_LIMIT_MAX_BP, Math.round(raw))
  );
}

export interface AssemblyWorkbenchJunctionTarget {
  junctionId?: string;
  junctionIndex?: number;
}

export interface AssemblyWorkbenchPrimerTarget {
  primerId?: string;
  fragmentIndex?: number;
  direction?: 'forward' | 'reverse';
}

interface DesignMutationCommandFields {
  expectedDesignVersion?: number;
}

export type AssemblyWorkbenchCommand =
  | { type: 'selectJunction'; junctionId?: string | null; junctionIndex?: number | null }
  | ({
      type: 'setAssemblyMode';
      method: AssemblyMethod;
      enzyme?: GoldenGateEnzyme;
      draft?: boolean;
    } & DesignMutationCommandFields)
  | ({
      type: 'setGoldenGateEnzyme';
      enzyme: GoldenGateEnzyme;
      draft?: boolean;
    } & DesignMutationCommandFields)
  | ({
      type: 'setGoldenGateOffsetLimit';
      limit: number;
    } & DesignMutationCommandFields)
  | ({ type: 'setGoldenGateOffset'; offset: number } & DesignMutationCommandFields &
      AssemblyWorkbenchJunctionTarget)
  | ({
      type: 'setHomologyEncoding';
      encoding: HomologyEncoding;
      recomputePrimers?: boolean;
    } & DesignMutationCommandFields &
      AssemblyWorkbenchJunctionTarget)
  | ({
      type: 'setJunctionSpacer';
      sequence: string;
      name?: string | null;
    } & DesignMutationCommandFields &
      AssemblyWorkbenchJunctionTarget)
  | ({
      type: 'setSourceContributionBoundary';
      regionId: string;
      side: 'upstream' | 'downstream';
      sourcePosition: number;
    } & DesignMutationCommandFields)
  | ({ type: 'setPrimerPbsLength'; length: number } & DesignMutationCommandFields &
      AssemblyWorkbenchPrimerTarget)
  | ({ type: 'setPrimerOverhangLength'; length: number } & DesignMutationCommandFields &
      AssemblyWorkbenchPrimerTarget)
  | ({
      type: 'setPrimerContent';
      name?: string;
      pbsSequence?: string;
      overhangSequence?: string;
      pbsStart?: number;
      pbsEnd?: number;
      oligo?: { vendor: 'idt'; notation: string; orderType?: 'dna' | 'rna' };
      annealingLength?: number;
    } & DesignMutationCommandFields &
      AssemblyWorkbenchPrimerTarget)
  | ({ type: 'draftAssembly' } & DesignMutationCommandFields)
  | ({
      type: 'applyProposal';
      proposalId: string;
      command: AssemblyWorkbenchCommand;
    } & DesignMutationCommandFields)
  | ({
      type: 'autoOptimize';
      scope: 'selected-junction' | 'all';
      maxIterations?: number;
      candidateRank?: number;
    } & DesignMutationCommandFields);

export type AssemblyWorkbenchCommandType = AssemblyWorkbenchCommand['type'];

export const ASSEMBLY_WORKBENCH_COMMAND_TYPES = [
  'selectJunction',
  'setAssemblyMode',
  'setGoldenGateEnzyme',
  'setGoldenGateOffsetLimit',
  'setGoldenGateOffset',
  'setHomologyEncoding',
  'setJunctionSpacer',
  'setSourceContributionBoundary',
  'setPrimerPbsLength',
  'setPrimerOverhangLength',
  'setPrimerContent',
  'draftAssembly',
  'applyProposal',
  'autoOptimize',
] as const satisfies readonly AssemblyWorkbenchCommandType[];

export type AssemblyWorkbenchErrorCode =
  | 'stale-design-version'
  | 'unsupported-command'
  | 'unsupported-mode-command'
  | 'invalid-command-target'
  | 'invalid-command-value'
  | 'fixed-goldengate-junction'
  | 'optimizer-data-unavailable'
  | 'optimizer-search-limit'
  | 'missing-source-context'
  | 'source-window-too-small';

export interface AssemblyWorkbenchCommandError {
  code: AssemblyWorkbenchErrorCode;
  message: string;
  commandType: AssemblyWorkbenchCommandType;
  expectedDesignVersion?: number;
  actualDesignVersion?: number;
  targetId?: string;
}

export interface AssemblyWorkbenchCommandWarning {
  code: string;
  message: string;
  commandType: AssemblyWorkbenchCommandType;
  targetId?: string;
}

export interface AssemblyWorkbenchViewState {
  selectedJunctionId: string | null;
  selectedJunctionIndex: number | null;
}

export interface AssemblyWorkbenchSourceWindowContext {
  sequence: string;
  annotations?: DesignAnnotation[];
  sourceStart?: number;
  sourceEnd?: number;
  sourceLength?: number;
  circular?: boolean;
}

export interface AssemblyWorkbenchSourceContext {
  ready: boolean;
  regions?: Record<string, AssemblyWorkbenchSourceWindowContext>;
  sources?: Record<string, AssemblyWorkbenchSourceWindowContext>;
}

export interface AssemblyWorkbenchEditableField {
  id: string;
  kind:
    | 'sourceContributionBoundary'
    | 'junctionSpacer'
    | 'primerPbs'
    | 'primerTail'
    | 'homologyArm'
    | 'goldenGateOverhang'
    | 'rdResection';
  label: string;
  target: {
    junctionId?: string;
    junctionIndex?: number;
    regionId?: string;
    primerId?: string;
    fragmentIndex?: number;
    direction?: 'forward' | 'reverse';
    side?: 'left' | 'right' | 'upstream' | 'downstream';
  };
  value: number | string;
  units: 'bp' | 'sequence';
  range?: {
    min: number;
    max: number;
    step: number;
    largeStep: number;
  };
  anchors: Array<{
    rowId: string;
    rowKind: 'left-source' | 'right-source' | 'product';
    bioCol: number;
    role: 'boundary' | 'pbs-start' | 'pbs-end' | 'tail-start' | 'tail-end';
  }>;
  command: {
    type: AssemblyWorkbenchCommand['type'] | 'setEditableField';
    payload: Record<string, unknown>;
    valueKey?: string;
  };
  constraints: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }>;
  disabled?: boolean;
}

export interface AssemblyWorkbenchLivePrimerTemperature {
  primerId?: string;
  sourcePrimerId?: string;
  fragmentIndex?: number;
  direction: 'forward' | 'reverse';
  tm: number | null;
}

export interface AssemblyWorkbenchLiveHomologyTemperature {
  junctionIndex: number;
  tm: number | null;
}

export interface AssemblyWorkbenchLiveFieldPreview {
  value: number;
  homologyTm?: AssemblyWorkbenchLiveHomologyTemperature;
  primerTms?: AssemblyWorkbenchLivePrimerTemperature[];
}

export interface AssemblyWorkbenchCommandResult<Design> {
  status: 'applied' | 'rejected' | 'noop';
  nextDesign: Design;
  nextViewState: AssemblyWorkbenchViewState;
  errors: AssemblyWorkbenchCommandError[];
  warnings: AssemblyWorkbenchCommandWarning[];
  appliedCommands: AssemblyWorkbenchCommand[];
  projectionInvalidated: boolean;
}

export type AssemblyWorkbenchCommandSchema =
  | { type: 'object'; required: string[]; properties: Record<string, string> }
  | { type: 'none' };

export interface AssemblyWorkbenchCapability {
  command: AssemblyWorkbenchCommandType;
  mutates: 'design' | 'view' | 'both';
  supportedModes: AssemblyMethod[] | 'all';
  requiresExpectedDesignVersion: boolean;
  requiresSourceContext: boolean;
  schema: AssemblyWorkbenchCommandSchema;
  errorCodes: AssemblyWorkbenchErrorCode[];
}

const COMMON_DESIGN_ERRORS: AssemblyWorkbenchErrorCode[] = [
  'stale-design-version',
  'invalid-command-target',
  'invalid-command-value',
  'unsupported-mode-command',
];

export const ASSEMBLY_WORKBENCH_CAPABILITIES: AssemblyWorkbenchCapability[] = [
  {
    command: 'selectJunction',
    mutates: 'view',
    supportedModes: 'all',
    requiresExpectedDesignVersion: false,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: [],
      properties: { junctionId: 'string|null', junctionIndex: 'number|null' },
    },
    errorCodes: ['invalid-command-target'],
  },
  {
    command: 'setAssemblyMode',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['method', 'expectedDesignVersion'],
      properties: { method: 'AssemblyMethod', enzyme: 'GoldenGateEnzyme?', draft: 'boolean?' },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setGoldenGateEnzyme',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['enzyme', 'expectedDesignVersion'],
      properties: { enzyme: 'GoldenGateEnzyme', draft: 'boolean?' },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setGoldenGateOffset',
    mutates: 'design',
    supportedModes: ['goldengate'],
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['junctionId|junctionIndex', 'offset', 'expectedDesignVersion'],
      properties: { junctionId: 'string?', junctionIndex: 'number?', offset: 'number' },
    },
    errorCodes: [...COMMON_DESIGN_ERRORS, 'fixed-goldengate-junction'],
  },
  {
    command: 'setGoldenGateOffsetLimit',
    mutates: 'design',
    supportedModes: ['goldengate'],
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['limit', 'expectedDesignVersion'],
      properties: { limit: 'number' },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setHomologyEncoding',
    mutates: 'design',
    supportedModes: ['gibson', 'nebuilder'],
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['junctionId|junctionIndex', 'encoding', 'expectedDesignVersion'],
      properties: {
        junctionId: 'string?',
        junctionIndex: 'number?',
        encoding: 'HomologyEncoding',
        recomputePrimers: 'boolean?',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setJunctionSpacer',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['junctionId|junctionIndex', 'sequence', 'expectedDesignVersion'],
      properties: {
        junctionId: 'string?',
        junctionIndex: 'number?',
        sequence: 'string',
        name: 'string|null?',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setSourceContributionBoundary',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: true,
    schema: {
      type: 'object',
      required: ['regionId', 'side', 'sourcePosition', 'expectedDesignVersion'],
      properties: {
        regionId: 'string',
        side: "'upstream'|'downstream'",
        sourcePosition: 'number',
      },
    },
    errorCodes: [...COMMON_DESIGN_ERRORS, 'missing-source-context', 'source-window-too-small'],
  },
  {
    command: 'setPrimerPbsLength',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['primerId|fragmentIndex+direction', 'length', 'expectedDesignVersion'],
      properties: {
        primerId: 'string?',
        fragmentIndex: 'number?',
        direction: "'forward'|'reverse'?",
        length: 'number',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setPrimerOverhangLength',
    mutates: 'design',
    supportedModes: ['gibson', 'nebuilder'],
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['primerId|fragmentIndex+direction', 'length', 'expectedDesignVersion'],
      properties: {
        primerId: 'string?',
        fragmentIndex: 'number?',
        direction: "'forward'|'reverse'?",
        length: 'number',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'setPrimerContent',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['primerId|fragmentIndex+direction', 'expectedDesignVersion'],
      properties: {
        primerId: 'string?',
        fragmentIndex: 'number?',
        direction: "'forward'|'reverse'?",
        name: 'string?',
        pbsSequence: 'string?',
        overhangSequence: 'string?',
        pbsStart: 'number?',
        pbsEnd: 'number?',
        oligo: 'object?',
        annealingLength: 'number?',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'draftAssembly',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['expectedDesignVersion'],
      properties: { expectedDesignVersion: 'number' },
    },
    errorCodes: ['stale-design-version', 'invalid-command-value'],
  },
  {
    command: 'applyProposal',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['proposalId', 'command', 'expectedDesignVersion'],
      properties: { proposalId: 'string', command: 'AssemblyWorkbenchCommand' },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
  {
    command: 'autoOptimize',
    mutates: 'design',
    supportedModes: 'all',
    requiresExpectedDesignVersion: true,
    requiresSourceContext: false,
    schema: {
      type: 'object',
      required: ['scope', 'expectedDesignVersion'],
      properties: {
        scope: "'selected-junction'|'all'",
        maxIterations: 'number?',
        candidateRank: 'number?',
      },
    },
    errorCodes: COMMON_DESIGN_ERRORS,
  },
];
