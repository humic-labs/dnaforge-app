import { describe, expect, it } from 'vitest';
import { decodeInlineReferenceUrl } from './inline-reference-codec';
import {
  projectResourceReferenceFromHref,
  projectResourceReferenceHref,
  type ProjectResourceReference,
} from './project-resource-reference';

const projectId = '6a06aec1-382d-4a2f-8d2f-d08c98850cb6';
const resources: ProjectResourceReference[] = [
  {
    kind: 'entity',
    projectId,
    entityId: 'track-view-e70e921e8d925c7b4654d05542c9556ea4a84260e53e1543228c9592fad0584b',
  },
  { kind: 'path', projectId, path: 'analyses/evo2-klf17/selection.json', resourceKind: 'file' },
  { kind: 'path', projectId, path: 'analyses/Evo2 pilot — klf17', resourceKind: 'directory' },
];

describe(' portable resource links shared by notebooks and chat', () => {
  it.each(resources)(
    'round-trips the canonical %j through the common inline decoder',
    (reference) => {
      const href = projectResourceReferenceHref(reference);
      expect(href).toMatch(/^dnaforge-chat:\/\/project-resource\//u);
      expect(projectResourceReferenceFromHref(href)).toEqual(reference);
      expect(decodeInlineReferenceUrl(href)).toMatchObject({
        ok: true,
        declaration: { kind: 'project-resource', resource: reference },
      });
    }
  );
  it.each(resources)('retains the previously saved entity-scheme alias for %j', (reference) => {
    const alias = projectResourceReferenceHref(reference).replace(/^dnaforge-chat:/u, 'entity:');
    expect(projectResourceReferenceFromHref(alias)).toEqual(reference);
  });
});
