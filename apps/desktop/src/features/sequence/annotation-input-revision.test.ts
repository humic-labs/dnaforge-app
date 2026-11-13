// @vitest-environment node

import { describe, expect, it } from 'vitest';
import vectors from '../../../../../test-fixtures/contracts/annotation-input-revisions.json';
import { annotationInputRevision } from './annotation-input-revision';

describe('annotation input identity shared with the standalone Python tool', () => {
  it.each(vectors)('$name', async ({ request, revision }) => {
    expect(await annotationInputRevision(request)).toBe(revision);
  });
});
