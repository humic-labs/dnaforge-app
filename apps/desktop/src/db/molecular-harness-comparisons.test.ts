import { beforeEach, describe, expect, it } from 'vitest';
import { initializeTestSchema } from '../test/initializeTestSchema';
import {
  listMolecularHarnessComparisonRecords,
  saveMolecularHarnessComparisonRecord,
} from './molecular-harness-comparisons';

const comparison = {
  version: 2 as const,
  cases: [
    {
      id: 'groel',
      title: 'GroEL–GroES',
      question: 'What changes when GroES caps one GroEL ring?',
      fixtureIds: ['1AON'],
      outcomes: [
        {
          id: 'burette-groel',
          label: 'Burette story',
          provenance: 'native-code' as const,
          sourceUrl: 'https://github.com/SergeiNikolenko/Burette',
          runEvidence: 'story-create and story-validate at commit 683e616',
          referenceId: '26d6d169-a620-45f2-8600-e74f1c99ef80',
          testResult: {
            status: 'rendered' as const,
            observation:
              'Story reopened with three steps; the static structure does not demonstrate motion.',
            checkedAt: 1,
            structureCount: 1,
            representationCount: 5,
            error: null,
          },
        },
      ],
    },
  ],
};

describe('molecular harness comparison records', () => {
  beforeEach(async () => {
    await initializeTestSchema();
  });

  it('retains independent database runs with their question, provenance, view, and observed result', async () => {
    const first = await saveMolecularHarnessComparisonRecord('First run', comparison);
    const second = await saveMolecularHarnessComparisonRecord('Second run', comparison);
    expect(first.id).not.toBe(second.id);

    const records = await listMolecularHarnessComparisonRecords();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toContain(first.id);
    expect(records.map((record) => record.id)).toContain(second.id);
    expect(
      records.find((record) => record.id === first.id)?.comparison.cases[0].outcomes[0]
    ).toMatchObject({
      referenceId: '26d6d169-a620-45f2-8600-e74f1c99ef80',
      runEvidence: 'story-create and story-validate at commit 683e616',
      testResult: { status: 'rendered', structureCount: 1, representationCount: 5 },
    });
  });
});
