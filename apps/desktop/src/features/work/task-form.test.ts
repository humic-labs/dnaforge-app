import { expect, it } from 'vitest';
import { dateDraft, fieldDate } from './task-form';

it('opens a pinned old-rule clock time and preserves its instant until explicitly edited', () => {
  const saved = {
    kind: 'fixed' as const,
    value: {
      kind: 'timed' as const,
      local: '2026-03-08T02:30:00',
      zone: 'America/Los_Angeles',
      instant: Date.parse('2026-03-08T10:30:00Z'),
    },
  };
  const draft = dateDraft(saved);
  expect(draft.retained).toEqual(saved.value);
  expect(fieldDate(draft)).toEqual(saved);
  expect(() => fieldDate({ ...draft, retained: undefined })).toThrow('does not exist');
  expect(fieldDate({ ...draft, date: '2026-03-09' })).toMatchObject({
    value: {
      kind: 'timed',
      local: '2026-03-09T02:30:00',
      instant: Date.parse('2026-03-09T09:30:00Z'),
    },
  });
});
