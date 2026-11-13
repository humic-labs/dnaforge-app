import { realAssemblyPipelineAppScenario } from '../../../test/scenarios/assembly-real-pipeline';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/public/store';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import {
  assemblyListEditableFieldsOutputSchema,
  assemblySetEditableFieldOutputSchema,
} from '../../ai/public/tools/design-output-schemas';
import { handleAssemblyListEditableFields, handleAssemblySetEditableField } from './helpers';

describe('custom assembly MCP output contracts', () => {
  beforeEach(() => useDesignStore.setState({ designs: {}, activeDesignId: null }));

  it('lists real editable fields, applies one, and keeps an exact noop successful', async () => {
    const designId = useDesignStore.getState().createDesign('MCP contract', 'circular', 'gibson');
    for (const [index, sequence] of ['AAATTT', 'GGGCCC'].entries())
      useDesignStore.getState().addRegion(designId, {
        sourceSequenceId: `source-${index}`,
        sourceSequenceName: `Source ${index}`,
        sourceStart: 0,
        sourceEnd: sequence.length,
        sequence,
        annotations: [],
        sourceType: 'pcr',
      });
    const listed = await handleAssemblyListEditableFields({ designId });
    expect(listed.ok).toBe(true);
    assertMcpOutput(assemblyListEditableFieldsOutputSchema, listed);
    if (!listed.ok) throw new Error(listed.error);
    const field = listed.fields.find(
      (item) => item.kind === 'junctionSpacer' && item.target.junctionIndex === 0
    );
    expect(field).toBeDefined();
    const applied = await handleAssemblySetEditableField({
      designId,
      fieldId: field!.id,
      value: 'gcc',
      expectedDesignVersion: listed.designVersion,
    });
    expect(applied).toMatchObject({ ok: true, status: 'applied' });
    assertMcpOutput(assemblySetEditableFieldOutputSchema, applied);
    expect(useDesignStore.getState().designs[designId].spacers[0].sequence).toBe('gcc');
    const noop = await handleAssemblySetEditableField({
      designId,
      fieldId: field!.id,
      value: 'gcc',
    });
    expect(noop).toMatchObject({ ok: true, status: 'noop' });
    assertMcpOutput(assemblySetEditableFieldOutputSchema, noop);
  });

  it.each(['gibson-pcr-pcr', 'goldengate-pcr-pcr', 'goldengate-pcr-rd-pcr'] as const)(
    'validates real %s editable command templates',
    async (scenarioId) => {
      const scenario = realAssemblyPipelineAppScenario(scenarioId);
      useDesignStore.setState({
        designs: scenario.designs?.designs ?? {},
        activeDesignId: scenario.designs?.activeDesignId ?? null,
      });
      const result = await handleAssemblyListEditableFields({});
      expect(result.ok).toBe(true);
      assertMcpOutput(assemblyListEditableFieldsOutputSchema, result);
    }
  );

  it('reports an unavailable design without claiming a mutation', async () => {
    const result = await handleAssemblySetEditableField({
      designId: 'absent',
      fieldId: 'absent',
      value: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'ASSEMBLY_FIELD_EDIT_FAILED',
      stateChanged: false,
      partialEffects: [],
    });
  });
});
