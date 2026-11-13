import { describe, expect, it } from 'vitest';
import { realAssemblyPipelineAppScenario } from '../../test/scenarios/assembly-real-pipeline';
import { assertDesignCanBeFinalized } from './accepted-service';
import { FinalizationPreconditionError, isFinalizationFilesystemError } from './finalization-error';

describe(' finalization preconditions', () => {
  it('identifies the real non-ready draft guard as a recoverable precondition', () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-pcr');
    const design = Object.values(scenario.designs!.designs!)[0];
    try {
      assertDesignCanBeFinalized({ ...design, assemblyState: 'drafting' });
      expect.fail('A draft without validation must not be finalized');
    } catch (error) {
      expect(error).toBeInstanceOf(FinalizationPreconditionError);
      expect(error).toMatchObject({ reason: 'draft_required' });
      expect(isFinalizationFilesystemError(error)).toBe(false);
    }
  });

  it.each([
    new Error('Design version is stale'),
    new Error('Accepted assembly output already exists'),
    { code: 'STALE_DESIGN' },
    new Error('Unexpected EACCES in a user-controlled string'),
  ])('does not infer filesystem authority from arbitrary error text or codes', (error) => {
    expect(isFinalizationFilesystemError(error)).toBe(false);
  });

  it('recognizes errno retained in an Electron error message', () => {
    expect(isFinalizationFilesystemError(new Error('Error: EACCES: permission denied'))).toBe(true);
  });
});
