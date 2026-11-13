import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import {
  PRIMER_FILE_AUTHORITY_GUIDE_PATH,
  PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
  PRIMER_FILE_AUTHORITY_SEQUENCE_PATH,
  PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT,
  primerFileAuthorityWorkspace,
} from './primer-file-authority';

describe('primerFileAuthorityWorkspace', () => {
  it('defines a fresh Git-backed pUC19 workspace with an actionable proof guide', () => {
    const scenario = primerFileAuthorityWorkspace();

    expect(scenario.dev?.scenarioId).toMatch(/^primer-file-authority-/);
    expect(scenario.dev?.initializeGit).toBe(true);
    expect(scenario.workspace).toEqual({
      folders: [
        {
          path: PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT,
          name: 'Primer development',
        },
      ],
      selectedPath: PRIMER_FILE_AUTHORITY_SEQUENCE_PATH,
    });
    expect(scenario.canvas?.tabs).toEqual([
      {
        type: 'sequence',
        entityId: PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
        label: 'pUC19',
        sequenceDocument: {
          kind: 'catalog-sequence',
          entityId: PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
        },
      },
    ]);

    const source = scenario.files?.[PRIMER_FILE_AUTHORITY_SEQUENCE_PATH];
    expect(typeof source).toBe('string');
    expect(parseGenBankFull(source as string).sequence).toHaveLength(2686);
    expect(
      scenario.sequences?.[PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID]?.annotations.length
    ).toBeGreaterThan(0);
    expect(scenario.files?.[PRIMER_FILE_AUTHORITY_GUIDE_PATH]).toEqual(
      expect.stringContaining('## What success looks like')
    );
    expect(scenario.files?.[PRIMER_FILE_AUTHORITY_GUIDE_PATH]).toEqual(
      expect.stringContaining('The original `pUC19.gb` remains byte-for-byte unchanged')
    );
  });

  it('uses a new materialization directory on every apply', () => {
    expect(primerFileAuthorityWorkspace().dev?.scenarioId).not.toBe(
      primerFileAuthorityWorkspace().dev?.scenarioId
    );
  });
});
