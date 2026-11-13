// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  parseHostedResourceBindings,
  serializeHostedResourceBindings,
} from './hosted-resource-bindings';

describe('hosted resource bindings', () => {
  it('round-trips stable workspace resources independently from their content', () => {
    const serialized = serializeHostedResourceBindings({
      schema: 1,
      remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
      remoteVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
      resources: [
        {
          resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          path: 'sequences/sample.gbk',
          contentSha256: 'a'.repeat(64),
        },
      ],
    });

    expect(parseHostedResourceBindings(serialized).resources[0]).toEqual({
      resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      path: 'sequences/sample.gbk',
      contentSha256: 'a'.repeat(64),
    });
  });

  it('rejects duplicate resource identities and unsafe placements', () => {
    const base = {
      schema: 1,
      remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
      remoteVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
    };
    expect(() =>
      parseHostedResourceBindings(
        JSON.stringify({
          ...base,
          resources: [
            {
              resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              path: 'one.gbk',
              contentSha256: 'a'.repeat(64),
            },
            {
              resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              path: 'two.gbk',
              contentSha256: 'b'.repeat(64),
            },
          ],
        })
      )
    ).toThrow(/invalid/u);
    expect(() =>
      parseHostedResourceBindings(
        JSON.stringify({
          ...base,
          resources: [
            {
              resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              path: '../outside.gbk',
              contentSha256: 'a'.repeat(64),
            },
          ],
        })
      )
    ).toThrow(/invalid/u);
  });
});
