import { describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { DBEntityReference } from '../../../db/entity-references';

const { references } = vi.hoisted(() => ({ references: vi.fn() }));
vi.mock('../../../db/entity-references', () => ({ getEntityReferencesByIds: references }));

import { buildSequenceRegionDescriptor } from '../selection-descriptor/sequence-region';
import { buildAgentSdkContinuationPrompt, buildAgentSdkPrompt } from '../prompts/cli-prompt';
import { expandReferencesFromIds, serializeReferenceDescriptorFence } from './reference-context';

function largeReference(): DBEntityReference {
  const sequence: AnnotatedSequence = {
    id: 'catalog-sequence:ecoli',
    name: 'ecoli-large-selection',
    sequence: 'ACGT'.repeat(300_000),
    length: 1_200_000,
    circular: false,
    annotations: Array.from({ length: 1143 }, (_, index) => ({
      type: 'CDS',
      name: `gene-${index}`,
      start: index * 1000 + 1,
      end: index * 1000 + 900,
      direction: 1 as const,
      qualifiers: { gene: [`gene-${index}`], product: [`protein-${index}`] },
    })),
  };
  const descriptor = buildSequenceRegionDescriptor(
    {
      kind: 'sequence_region',
      documentId: 'catalog-sequence:ecoli',
      range: { start: 1, end: sequence.length },
    },
    sequence,
    7
  );
  expect(descriptor.measured.readingFrames).toHaveLength(1143);
  return {
    id: '1596d8e5-be19-40ed-9ab9-d0a1266fadef',
    entity_type: 'sequence_region',
    display_label: descriptor.label,
    locator: 'catalog-sequence:ecoli',
    deep_link_params: JSON.stringify({ start: 1, end: sequence.length }),
    data: JSON.stringify(descriptor),
    source: 'user',
    status: 'created',
    created_at: 1,
    updated_at: 1,
  };
}

interface SelectionEnvelope {
  reference: { refId: string };
  descriptor: {
    locator: { documentId: string; refId: string };
    measured: unknown;
    bases: string;
    fetch: { tools: string[] };
  };
}

function decodeFence(value: string): SelectionEnvelope {
  const match = value.match(/<wp-sel-[^>]+>([\s\S]*?)<\/wp-sel-[^>]+>/);
  expect(match).not.toBeNull();
  return JSON.parse(
    match![1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

describe('large sequence reference prompt contract', () => {
  it('bounds the prompt descriptor while preserving the persisted selection and exact identity', () => {
    const ref = largeReference();
    const original = ref.data;
    const fence = serializeReferenceDescriptorFence(ref, ref.locator, 'testnonce')!;
    expect(new TextEncoder().encode(fence).byteLength).toBeLessThan(8 * 1024);
    const envelope = decodeFence(fence);
    expect(envelope.reference.refId).toBe(ref.id);
    expect(envelope.descriptor.locator).toMatchObject({
      documentId: ref.locator,
      refId: ref.id,
    });
    expect(envelope.descriptor.measured).toMatchObject({
      start: 1,
      end: 1_200_000,
      length: 1_200_000,
      parentLength: 1_200_000,
      wraps: false,
      topology: 'linear',
    });
    expect(envelope.descriptor.bases).toBe('not_included');
    expect(envelope.descriptor.fetch.tools).toContain('selection_gc_profile');
    expect(fence).not.toContain('ACGT'.repeat(100));
    expect(ref.data).toBe(original);
    expect(JSON.parse(ref.data!).measured.readingFrames).toHaveLength(1143);
  });

  it.each([
    ['seed', buildAgentSdkPrompt],
    ['continuation', buildAgentSdkContinuationPrompt],
  ] as const)('sends a persisted large selection through the %s CLI path', async (_, build) => {
    const ref = largeReference();
    references.mockResolvedValue([ref]);
    const content = await expandReferencesFromIds('What genes are in this selection?', [ref.id]);
    const prompt = build(
      [],
      [{ id: 'question', role: 'user', content, createdAt: 1 }],
      'native-cli',
      true,
      [ref],
      'auto',
      'codex-sdk'
    );
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(60 * 1024);
    expect(prompt).toContain('What genes are in this selection?');
    expect(prompt).toContain(`waypoint://selection/${ref.id}`);
    expect(prompt).toContain('selection_gc_profile');
    expect(prompt).not.toContain('gene-1142');
  });
});
