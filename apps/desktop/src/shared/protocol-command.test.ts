import { expect, it } from 'vitest';
import {
  protocolDocumentAgentRequestSchema,
  protocolOperationCapabilities,
} from './protocol-command';
import { inventoryAgentSchema } from '../features/ai/tools/inventory';

it('keeps operation kind separate from package and scientific context kinds', () => {
  expect(
    protocolDocumentAgentRequestSchema.parse({
      operation: { kind: 'list-packages', packageKind: 'protocol-run', project: 'project' },
    })
  ).toEqual({
    operation: { kind: 'list-packages', packageKind: 'protocol-run', project: 'project' },
  });
  expect(
    inventoryAgentSchema.parse({
      operation: {
        kind: 'scientific-contexts-v2',
        contextKind: 'protocol-run',
        project: 'project',
        inventoryId: 'inventory',
      },
    })
  ).toMatchObject({ operation: { kind: 'scientific-contexts-v2', contextKind: 'protocol-run' } });
  expect(() =>
    inventoryAgentSchema.parse({
      operation: { kind: 'scientific-contexts-v2', project: 'project', inventoryId: 'inventory' },
    })
  ).toThrow();
});

it('requires an explicit saved source to start and rejects caller-created frozen source', () => {
  const request = {
    operation: {
      kind: 'start-run',
      project: 'project',
      requestId: 'stable-original',
      protocolId: 'project::protocol',
      expectedSourceSha256: `sha256:${'a'.repeat(64)}`,
      title: 'Run',
    },
  };
  expect(protocolDocumentAgentRequestSchema.parse(request)).toEqual(request);
  expect(() =>
    protocolDocumentAgentRequestSchema.parse({
      operation: { ...request.operation, initialProtocolText: '{"frozenProtocol":"caller"}' },
    })
  ).toThrow();
  expect(protocolOperationCapabilities('inspect-creation')).toEqual(['read-workspace']);
  expect(protocolOperationCapabilities('recover-creation')).toEqual([
    'read-workspace',
    'write-workspace',
    'create-entity',
  ]);
});
