// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { ProjectionKind } from './benchling-migration';
import {
  BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
  parseMigrationRenderValidationRequest,
} from './benchling-migration-render-validation';

describe('Benchling migration render-validation request', () => {
  it.each([
    { destinationPath: 'sequence.gb' },
    { surface: 'sequence' },
    { catalogRecord: { kind: 'unknown', name: 'Record', fields: {} } },
  ])('rejects an inconsistent catalog target: %j', (override) => {
    expect(() =>
      parseMigrationRenderValidationRequest({
        version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
        requestId: '6af8fba6-4f8c-4b87-8d43-e82418fc16b7',
        runId: 'run-1',
        workspaceId: 'workspace-1',
        workspaceRoot: '/workspace',
        items: [
          {
            sourceObjectId: 'source-1',
            destinationObjectId: 'destination-1',
            projection: 'native',
            converterId: 'native-v2',
            surface: 'lims_registry',
            catalogRecord: { kind: 'strain', name: 'Record', fields: {} },
            ...override,
          },
        ],
      })
    ).toThrow();
  });

  it.each([
    'native',
    'portable_file',
    'adapter_staging',
    'fallback',
    'artifact',
  ] satisfies ProjectionKind[])('accepts the supported %s projection', (projection) => {
    const request = parseMigrationRenderValidationRequest({
      version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
      requestId: '6af8fba6-4f8c-4b87-8d43-e82418fc16b7',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace',
      items: [
        {
          sourceObjectId: 'source-1',
          destinationObjectId: 'destination-1',
          destinationPath: 'Benchling Imports/source-1.html',
          projection,
          converterId: 'converter-1',
          surface: projection === 'fallback' ? 'artifact' : 'html',
        },
      ],
    });

    expect(request.items[0].projection).toBe(projection);
  });
});
