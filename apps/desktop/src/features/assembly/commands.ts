import type {
  AssemblyMethod,
  DesignAnnotation,
  DesignRegion,
  GoldenGateEnzyme,
  HomologyEncoding,
} from '../design/public/types';
import { badInput, err, ok, type RefusalReason, type Result } from './refusals';

export type EnzymeStrategy =
  | { method: 'gibson' }
  | { method: 'nebuilder' }
  | { method: 'goldengate'; enzyme?: GoldenGateEnzyme };

export type AssemblyCommandBase = {
  designId: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type SetBackboneCommand = AssemblyCommandBase & {
  type: 'setBackbone';
  sequenceId: string;
};

export type AddFragmentCommand = AssemblyCommandBase & {
  type: 'addFragment';
  sequenceId: string;
  slot?: number;
  region?: Omit<DesignRegion, 'id'>;
};

export type RemoveFragmentCommand = AssemblyCommandBase & {
  type: 'removeFragment';
  fragmentId: string;
};

export type ReorderFragmentsCommand = AssemblyCommandBase & {
  type: 'reorderFragments';
  order: readonly string[];
};

export type SetEnzymeStrategyCommand = AssemblyCommandBase & {
  type: 'setEnzymeStrategy';
  strategy: EnzymeStrategy;
};

export type UpdateHomologyEncodingCommand = AssemblyCommandBase & {
  type: 'updateHomologyEncoding';
  junctionIndex: number;
  encoding: HomologyEncoding;
  recomputePrimers?: boolean;
};

export type ValidateCommand = AssemblyCommandBase & {
  type: 'validate';
};

export type RunCommand = AssemblyCommandBase & {
  type: 'run';
};

export type ResetCommand = AssemblyCommandBase & {
  type: 'reset';
};

export type AssemblyCommand =
  | SetBackboneCommand
  | AddFragmentCommand
  | RemoveFragmentCommand
  | ReorderFragmentsCommand
  | SetEnzymeStrategyCommand
  | UpdateHomologyEncodingCommand
  | ValidateCommand
  | RunCommand
  | ResetCommand;

export type AssemblyCommandType = AssemblyCommand['type'];

export const ASSEMBLY_COMMAND_TYPES = [
  'setBackbone',
  'addFragment',
  'removeFragment',
  'reorderFragments',
  'setEnzymeStrategy',
  'updateHomologyEncoding',
  'validate',
  'run',
  'reset',
] as const satisfies readonly AssemblyCommandType[];

export const ASSEMBLY_METHODS = [
  'gibson',
  'nebuilder',
  'goldengate',
] as const satisfies readonly AssemblyMethod[];

export const GOLDEN_GATE_ENZYMES = [
  'BsaI',
  'BbsI',
  'BsmBI',
  'SapI',
] as const satisfies readonly GoldenGateEnzyme[];

export const assemblyCommands = {
  setBackbone: (
    designId: string,
    sequenceId: string,
    options: Omit<AssemblyCommandBase, 'designId'> = {}
  ): SetBackboneCommand => ({ ...options, type: 'setBackbone', designId, sequenceId }),
  addFragment: (
    designId: string,
    sequenceId: string,
    options: Omit<AddFragmentCommand, 'type' | 'designId' | 'sequenceId'> = {}
  ): AddFragmentCommand => ({ ...options, type: 'addFragment', designId, sequenceId }),
  removeFragment: (
    designId: string,
    fragmentId: string,
    options: Omit<AssemblyCommandBase, 'designId'> = {}
  ): RemoveFragmentCommand => ({ ...options, type: 'removeFragment', designId, fragmentId }),
  reorderFragments: (
    designId: string,
    order: readonly string[],
    options: Omit<AssemblyCommandBase, 'designId'> = {}
  ): ReorderFragmentsCommand => ({ ...options, type: 'reorderFragments', designId, order }),
  setEnzymeStrategy: (
    designId: string,
    strategy: EnzymeStrategy,
    options: Omit<AssemblyCommandBase, 'designId'> = {}
  ): SetEnzymeStrategyCommand => ({ ...options, type: 'setEnzymeStrategy', designId, strategy }),
  updateHomologyEncoding: (
    designId: string,
    junctionIndex: number,
    encoding: HomologyEncoding,
    options: Omit<
      UpdateHomologyEncodingCommand,
      'type' | 'designId' | 'junctionIndex' | 'encoding'
    > = {}
  ): UpdateHomologyEncodingCommand => ({
    ...options,
    type: 'updateHomologyEncoding',
    designId,
    junctionIndex,
    encoding,
  }),
  validate: (
    designId: string,
    options: Omit<AssemblyCommandBase, 'designId'> = {}
  ): ValidateCommand => ({ ...options, type: 'validate', designId }),
  run: (designId: string, options: Omit<AssemblyCommandBase, 'designId'> = {}): RunCommand => ({
    ...options,
    type: 'run',
    designId,
  }),
  reset: (designId: string, options: Omit<AssemblyCommandBase, 'designId'> = {}): ResetCommand => ({
    ...options,
    type: 'reset',
    designId,
  }),
};

export function isEditorCommand(command: AssemblyCommand): boolean {
  return (
    command.type === 'setBackbone' ||
    command.type === 'addFragment' ||
    command.type === 'removeFragment' ||
    command.type === 'reorderFragments' ||
    command.type === 'setEnzymeStrategy' ||
    command.type === 'updateHomologyEncoding'
  );
}

export function isLifecycleCommand(
  command: AssemblyCommand
): command is ValidateCommand | RunCommand {
  return command.type === 'validate' || command.type === 'run';
}

export function parseAssemblyCommand(input: unknown): Result<AssemblyCommand, RefusalReason> {
  if (!isRecord(input)) {
    return err(badInput('Command must be an object.'));
  }

  const type = input.type;
  if (typeof type !== 'string' || !isAssemblyCommandType(type)) {
    return err(badInput('Unknown assembly command.', 'type', ASSEMBLY_COMMAND_TYPES));
  }

  const base = parseBase(input);
  if (!base.ok) return base;

  switch (type) {
    case 'setBackbone': {
      const sequenceId = readString(input, 'sequenceId');
      if (!sequenceId.ok) return sequenceId;
      return ok({ ...base.value, type, sequenceId: sequenceId.value });
    }
    case 'addFragment': {
      const sequenceId = readString(input, 'sequenceId');
      if (!sequenceId.ok) return sequenceId;
      const slot = input.slot;
      if (slot !== undefined && (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0)) {
        return err(badInput('slot must be a non-negative integer.', 'slot'));
      }
      const region = parseDesignRegion(input.region);
      if (!region.ok) return region;
      return ok({
        ...base.value,
        type,
        sequenceId: sequenceId.value,
        slot,
        region: region.value,
      });
    }
    case 'removeFragment': {
      const fragmentId = readString(input, 'fragmentId');
      if (!fragmentId.ok) return fragmentId;
      return ok({ ...base.value, type, fragmentId: fragmentId.value });
    }
    case 'reorderFragments': {
      if (!Array.isArray(input.order) || input.order.some((id) => typeof id !== 'string')) {
        return err(badInput('order must be an array of fragment ids.', 'order'));
      }
      return ok({ ...base.value, type, order: input.order });
    }
    case 'setEnzymeStrategy': {
      const strategy = parseEnzymeStrategy(input.strategy);
      if (!strategy.ok) return strategy;
      return ok({ ...base.value, type, strategy: strategy.value });
    }
    case 'updateHomologyEncoding': {
      const junctionIndex = input.junctionIndex;
      if (
        typeof junctionIndex !== 'number' ||
        !Number.isInteger(junctionIndex) ||
        junctionIndex < 0
      ) {
        return err(badInput('junctionIndex must be a non-negative integer.', 'junctionIndex'));
      }
      const encoding = parseHomologyEncoding(input.encoding);
      if (!encoding.ok) return encoding;
      const recomputePrimers = input.recomputePrimers;
      if (recomputePrimers !== undefined && typeof recomputePrimers !== 'boolean') {
        return err(badInput('recomputePrimers must be a boolean.', 'recomputePrimers'));
      }
      return ok({
        ...base.value,
        type,
        junctionIndex,
        encoding: encoding.value,
        recomputePrimers,
      });
    }
    case 'validate':
    case 'run':
    case 'reset':
      return ok({ ...base.value, type });
  }
}

function parseHomologyEncoding(input: unknown): Result<HomologyEncoding, RefusalReason> {
  if (!isRecord(input)) {
    return err(badInput('encoding must be an object.', 'encoding'));
  }

  const onLeft = input.onLeft;
  const onRight = input.onRight;
  if (typeof onLeft !== 'number' || !Number.isInteger(onLeft) || onLeft < 0 || onLeft > 60) {
    return err(badInput('encoding.onLeft must be an integer between 0 and 60.', 'encoding.onLeft'));
  }
  if (typeof onRight !== 'number' || !Number.isInteger(onRight) || onRight < 0 || onRight > 60) {
    return err(
      badInput('encoding.onRight must be an integer between 0 and 60.', 'encoding.onRight')
    );
  }
  if (onLeft + onRight <= 0) {
    return err(badInput('homology encoding must include at least one base.', 'encoding'));
  }

  return ok({ onLeft, onRight });
}

function parseBase(input: Record<string, unknown>): Result<AssemblyCommandBase, RefusalReason> {
  const designId = readString(input, 'designId');
  if (!designId.ok) return designId;

  const expectedVersion = input.expectedVersion;
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 0)
  ) {
    return err(badInput('expectedVersion must be a non-negative integer.', 'expectedVersion'));
  }

  if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== 'string') {
    return err(badInput('idempotencyKey must be a string.', 'idempotencyKey'));
  }

  return ok({
    designId: designId.value,
    expectedVersion,
    idempotencyKey: input.idempotencyKey as string | undefined,
  });
}

function parseEnzymeStrategy(input: unknown): Result<EnzymeStrategy, RefusalReason> {
  if (typeof input === 'string') {
    if (input === 'gibson') return ok({ method: 'gibson' });
    if (input === 'nebuilder') return ok({ method: 'nebuilder' });
    if (input === 'goldengate') return ok({ method: 'goldengate', enzyme: 'BsaI' });
    return err(badInput('Unknown assembly method.', 'strategy', ASSEMBLY_METHODS));
  }

  if (!isRecord(input)) {
    return err(badInput('strategy must be an assembly method or strategy object.', 'strategy'));
  }

  if (input.method !== 'gibson' && input.method !== 'nebuilder' && input.method !== 'goldengate') {
    return err(badInput('Unknown assembly method.', 'strategy.method', ASSEMBLY_METHODS));
  }

  if (input.method === 'gibson' || input.method === 'nebuilder') {
    return ok({ method: input.method });
  }

  const enzyme = input.enzyme ?? 'BsaI';
  if (typeof enzyme !== 'string' || !GOLDEN_GATE_ENZYMES.includes(enzyme as GoldenGateEnzyme)) {
    return err(badInput('Unknown Golden Gate enzyme.', 'strategy.enzyme', GOLDEN_GATE_ENZYMES));
  }

  return ok({ method: 'goldengate', enzyme: enzyme as GoldenGateEnzyme });
}

function readString(input: Record<string, unknown>, field: string): Result<string, RefusalReason> {
  return readStringField(input, field, field);
}

function readStringField(
  input: Record<string, unknown>,
  key: string,
  field: string
): Result<string, RefusalReason> {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return err(badInput(`${field} must be a non-empty string.`, field));
  }
  return ok(value);
}

function readNonNegativeInteger(
  input: Record<string, unknown>,
  field: string
): Result<number, RefusalReason> {
  return readNonNegativeIntegerField(input, field, field);
}

function readNonNegativeIntegerField(
  input: Record<string, unknown>,
  key: string,
  field: string
): Result<number, RefusalReason> {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return err(badInput(`${field} must be a non-negative integer.`, field));
  }
  return ok(value);
}

function parseDesignRegion(
  input: unknown
): Result<Omit<DesignRegion, 'id'> | undefined, RefusalReason> {
  if (input === undefined) return ok(undefined);
  if (!isRecord(input)) {
    return err(badInput('region must be an object.', 'region'));
  }

  const sourceSequenceId = readString(input, 'sourceSequenceId');
  if (!sourceSequenceId.ok) return sourceSequenceId;
  const sourceSequenceName = readString(input, 'sourceSequenceName');
  if (!sourceSequenceName.ok) return sourceSequenceName;
  const sourceStart = readNonNegativeInteger(input, 'sourceStart');
  if (!sourceStart.ok) return sourceStart;
  const sourceEnd = readNonNegativeInteger(input, 'sourceEnd');
  if (!sourceEnd.ok) return sourceEnd;
  if (sourceEnd.value < sourceStart.value) {
    return err(badInput('sourceEnd must be greater than or equal to sourceStart.', 'sourceEnd'));
  }
  const sequence = readString(input, 'sequence');
  if (!sequence.ok) return sequence;

  if (!Array.isArray(input.annotations)) {
    return err(badInput('annotations must be an array.', 'annotations'));
  }
  const annotations: DesignAnnotation[] = [];
  for (const [index, annotation] of input.annotations.entries()) {
    const parsed = parseDesignAnnotation(annotation, index);
    if (!parsed.ok) return parsed;
    annotations.push(parsed.value);
  }

  if (input.sourceType !== undefined && input.sourceType !== 'pcr' && input.sourceType !== 'rd') {
    return err(badInput('sourceType must be pcr or rd.', 'sourceType', ['pcr', 'rd']));
  }

  return ok({
    sourceSequenceId: sourceSequenceId.value,
    sourceSequenceName: sourceSequenceName.value,
    sourceStart: sourceStart.value,
    sourceEnd: sourceEnd.value,
    sequence: sequence.value,
    annotations,
    ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
  });
}

function parseDesignAnnotation(
  input: unknown,
  index: number
): Result<DesignAnnotation, RefusalReason> {
  if (!isRecord(input)) {
    return err(badInput('annotation must be an object.', `annotations[${index}]`));
  }
  const name = readStringField(input, 'name', `annotations[${index}].name`);
  if (!name.ok) return name;
  const type = readStringField(input, 'type', `annotations[${index}].type`);
  if (!type.ok) return type;
  const start = readNonNegativeIntegerField(input, 'start', `annotations[${index}].start`);
  if (!start.ok) return start;
  const end = readNonNegativeIntegerField(input, 'end', `annotations[${index}].end`);
  if (!end.ok) return end;
  if (end.value < start.value) {
    return err(
      badInput(
        'annotation end must be greater than or equal to annotation start.',
        `annotations[${index}].end`
      )
    );
  }
  if (input.strand !== 'forward' && input.strand !== 'reverse' && input.strand !== 'none') {
    return err(
      badInput(
        'annotation strand must be forward, reverse, or none.',
        `annotations[${index}].strand`,
        ['forward', 'reverse', 'none']
      )
    );
  }
  if (input.color !== undefined && typeof input.color !== 'string') {
    return err(badInput('annotation color must be a string.', `annotations[${index}].color`));
  }
  return ok({
    name: name.value,
    type: type.value,
    start: start.value,
    end: end.value,
    strand: input.strand,
    ...(input.color === undefined ? {} : { color: input.color }),
  });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isAssemblyCommandType(type: string): type is AssemblyCommandType {
  return ASSEMBLY_COMMAND_TYPES.includes(type as AssemblyCommandType);
}
