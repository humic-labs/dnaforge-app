import { applyGoldenGateSchemaCommand } from './golden-gate-schema-command';
import type { MocloFactoryStageSelection } from './moclo-kit-definition';
import type { MocloFactoryDesignContext, SequenceDesign } from './types';

export interface MocloFactoryStageCommandInput {
  design: SequenceDesign;
  selection: MocloFactoryStageSelection;
  runId: string;
  expectedVersion: number;
  now?: Date;
}

export type MocloFactoryStageCommandResult =
  | { status: 'applied'; nextDesign: SequenceDesign }
  | { status: 'no-op'; currentDesign: SequenceDesign }
  | Exclude<
      ReturnType<typeof applyGoldenGateSchemaCommand>,
      { status: 'applied' } | { status: 'no-op' }
    >;

function factoryContext(
  selection: MocloFactoryStageSelection,
  runId: string
): MocloFactoryDesignContext {
  return {
    runId,
    kitId: selection.kitId,
    kitRevision: selection.kitRevision,
    recipeId: selection.recipeId,
    stageId: selection.stageId,
    stageInputs: selection.stageInputs.map((input) => ({ ...input })),
  };
}

function sameContext(
  left: MocloFactoryDesignContext | undefined,
  right: MocloFactoryDesignContext
): boolean {
  return (
    left?.runId === right.runId &&
    left.kitId === right.kitId &&
    left.kitRevision === right.kitRevision &&
    left.recipeId === right.recipeId &&
    left.stageId === right.stageId &&
    JSON.stringify(left.stageInputs) === JSON.stringify(right.stageInputs)
  );
}

export function applyMocloFactoryStageCommand({
  design,
  selection,
  runId,
  expectedVersion,
  now = new Date(),
}: MocloFactoryStageCommandInput): MocloFactoryStageCommandResult {
  const nextContext = factoryContext(selection, runId);
  const schemaResult = applyGoldenGateSchemaCommand({
    design,
    schema: selection.schema,
    expectedVersion,
    now,
  });
  if (schemaResult.status === 'rejected') return schemaResult;

  if (schemaResult.status === 'no-op') {
    if (sameContext(design.mocloFactory, nextContext)) {
      return { status: 'no-op', currentDesign: design };
    }
    return {
      status: 'applied',
      nextDesign: {
        ...design,
        mocloFactory: nextContext,
        version: design.version + 1,
        updatedAt: now,
      },
    };
  }

  return {
    status: 'applied',
    nextDesign: { ...schemaResult.nextDesign, mocloFactory: nextContext },
  };
}
