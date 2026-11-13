import type { SequenceDesign } from '../design/public/types';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import type {
  AssemblyWorkbenchCommandResult,
  AssemblyWorkbenchEditableField,
  AssemblyWorkbenchSourceContext,
  AssemblyWorkbenchViewState,
} from './AssemblyWorkbenchContract';
import { createAssemblyWorkbenchSession } from './AssemblyWorkbenchSession';
import { resolveEditableFieldCommand } from './editable-field-command';

export interface AssemblyEditableFieldList {
  designId: string;
  designVersion: number;
  selectedJunctionIndex: number | null;
  fields: AssemblyWorkbenchEditableField[];
}

export function listAssemblyEditableFields(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState = createAssemblyWorkbenchViewState(design)
): AssemblyEditableFieldList {
  const session = createAssemblyWorkbenchSession(design, viewState);
  return {
    designId: session.designId,
    designVersion: session.designVersion,
    selectedJunctionIndex: session.selectedJunctionIndex,
    fields: session.editableFields,
  };
}

export function applyAssemblyEditableFieldValue(
  design: SequenceDesign,
  input: {
    fieldId: string;
    value: number | string;
    expectedDesignVersion?: number;
    sourceContext?: AssemblyWorkbenchSourceContext;
    viewState?: AssemblyWorkbenchViewState;
  }
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const viewState = input.viewState ?? createAssemblyWorkbenchViewState(design);
  const session = createAssemblyWorkbenchSession(design, viewState);
  const field = session.editableFields.find((item) => item.id === input.fieldId);
  if (!field) {
    throw new Error(`Unknown assembly editable field: ${input.fieldId}`);
  }
  const resolved = resolveEditableFieldCommand(field, input.value, {
    expectedDesignVersion: input.expectedDesignVersion ?? design.version,
    recomputePrimers: true,
  });
  if (resolved.status !== 'resolved') {
    throw new Error(resolved.message);
  }
  return applyAssemblyWorkbenchCommand({
    design,
    viewState,
    sourceContext: input.sourceContext ?? { ready: true },
    command: resolved.command,
  });
}
