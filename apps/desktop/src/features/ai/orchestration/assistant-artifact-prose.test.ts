import { expect, it } from 'vitest';
import { sanitizeAssistantArtifactMetadata } from './assistant-artifact-prose';

const ordinaryId = 'ba97bef0-658a-4472-b335-0420bc25ac6e';
const artifactId = 'e8dd4c82-1d86-4149-9946-487c41d00ad7';

it('keeps an ordinary identifier in a saved answer', () => {
  const answer = `Saved answer ${ordinaryId}`;
  expect(sanitizeAssistantArtifactMetadata(answer)).toBe(answer);
});

it('removes confirmed artifact ids while preserving other identifiers', () => {
  const answer = `Saved result ${artifactId}. Sample ${ordinaryId}.`;
  const cleaned = sanitizeAssistantArtifactMetadata(answer, new Set([artifactId]));
  expect(cleaned).not.toContain(artifactId);
  expect(cleaned).toContain(ordinaryId);
});
