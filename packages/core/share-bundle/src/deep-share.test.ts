import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDeepShareBundleV1,
  deepShareBundleHashInput,
  validateDeepShareBundleV1,
  type DeepShareBundleV1,
  type DeepShareBundleV1Input,
} from './deep-share';

function sha256Bytes(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validInput(overrides: Partial<DeepShareBundleV1Input> = {}): DeepShareBundleV1Input {
  const text = 'LOCUS       example\nORIGIN\n        1 atgc\n//\n';
  return {
    schema: 'dnaforge.deep-share/v1',
    appVersion: '0.8.0',
    createdAt: '2026-08-27T02:30:00.000Z',
    source: {
      workspaceId: 'workspace-1',
      workspaceName: 'Enzyme project',
      artifact: {
        id: 'artifact-root',
        type: 'sequence',
        name: 'Example plasmid',
      },
      pinnedVersionId: 'version-7',
      pinnedVersionNumber: 7,
      pinnedVersionContentSha256: '1'.repeat(64),
    },
    parent: null,
    manifest: {
      rootArtifactId: 'artifact-root',
      artifacts: [
        {
          id: 'artifact-root',
          type: 'sequence',
          name: 'Example plasmid',
          required: true,
        },
      ],
      relationships: [],
      files: [
        {
          fileId: 'file-root',
          ownerArtifactId: 'artifact-root',
          role: 'primary',
        },
      ],
      chats: [],
      omissions: [],
    },
    files: [
      {
        id: 'file-root',
        ownerArtifactId: 'artifact-root',
        relativePath: 'Example plasmid/Example plasmid.gb',
        name: 'Example plasmid.gb',
        role: 'primary',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(text, 'utf8'),
        sha256: sha256Bytes(text),
        content: { encoding: 'utf8', text },
      },
    ],
    chats: [],
    limits: {
      maxFileBytes: 32 * 1024 * 1024,
      maxBundleBytes: 256 * 1024 * 1024,
      maxFiles: 2000,
    },
    ...overrides,
  };
}

describe('DeepShareBundleV1', () => {
  it('creates and validates a minimal root-only bundle', () => {
    const bundle = createDeepShareBundleV1(validInput());

    expect(bundle.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(validateDeepShareBundleV1(bundle)).toEqual({ ok: true, bundle });
  });

  it('validates decoded binary bytes instead of base64 text', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const input = validInput({
      manifest: {
        ...validInput().manifest,
        files: [
          {
            fileId: 'file-root',
            ownerArtifactId: 'artifact-root',
            role: 'attachment',
          },
        ],
      },
      files: [
        {
          id: 'file-root',
          ownerArtifactId: 'artifact-root',
          relativePath: 'Example plasmid/assets/image.png',
          name: 'image.png',
          role: 'attachment',
          contentType: 'image/png',
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          content: { encoding: 'base64', data: bytes.toString('base64') },
        },
      ],
    });

    const bundle = createDeepShareBundleV1(input);
    expect(validateDeepShareBundleV1(bundle)).toMatchObject({ ok: true });

    const invalid = structuredClone(bundle);
    const content = invalid.files[0].content;
    if (content.encoding !== 'base64') throw new Error('Test fixture must use base64 content.');
    invalid.files[0].sizeBytes = Buffer.byteLength(content.data, 'utf8');
    expect(validateDeepShareBundleV1(invalid)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[0].sizeBytes does not match decoded content']),
    });
  });

  it('hashes unordered manifest collections canonically and ignores creation time', () => {
    const related = {
      id: 'artifact-primer',
      type: 'primer' as const,
      name: 'Primer A',
      required: false,
    };
    const first = createDeepShareBundleV1(
      validInput({
        manifest: {
          ...validInput().manifest,
          artifacts: [validInput().manifest.artifacts[0], related],
          relationships: [
            {
              sourceArtifactId: 'artifact-primer',
              relation: 'binds_to_sequence',
              targetArtifactId: 'artifact-root',
            },
          ],
        },
      })
    );
    const second = createDeepShareBundleV1({
      ...validInput({
        createdAt: '2026-08-28T04:00:00.000Z',
        manifest: {
          ...validInput().manifest,
          artifacts: [related, validInput().manifest.artifacts[0]],
          relationships: [
            {
              sourceArtifactId: 'artifact-primer',
              relation: 'binds_to_sequence',
              targetArtifactId: 'artifact-root',
            },
          ],
        },
      }),
    });

    expect(deepShareBundleHashInput(first)).toBe(deepShareBundleHashInput(second));
    expect(first.contentSha256).toBe(second.contentSha256);
  });

  it('rejects unsafe paths, duplicate identities, dangling references, and hash mismatches', () => {
    const bundle = createDeepShareBundleV1(validInput());
    const cases: Array<[DeepShareBundleV1, string]> = [
      [
        { ...bundle, files: [{ ...bundle.files[0], relativePath: '../secret.gb' }] },
        'files[0].relativePath is unsafe',
      ],
      [
        { ...bundle, files: [bundle.files[0], { ...bundle.files[0] }] },
        'files[1].id is duplicated',
      ],
      [
        {
          ...bundle,
          manifest: {
            ...bundle.manifest,
            relationships: [
              {
                sourceArtifactId: 'artifact-root',
                relation: 'derived_from',
                targetArtifactId: 'missing-artifact',
              },
            ],
          },
        },
        'manifest.relationships[0].targetArtifactId is not included',
      ],
      [{ ...bundle, contentSha256: 'f'.repeat(64) }, 'contentSha256 does not match bundle'],
    ];

    for (const [candidate, expectedError] of cases) {
      expect(validateDeepShareBundleV1(candidate)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expectedError]),
      });
    }
  });

  it('rejects fields that could restore provider, tool, route, or raw reference state', () => {
    const bundle = createDeepShareBundleV1({
      ...validInput(),
      manifest: {
        ...validInput().manifest,
        chats: [{ conversationId: 'conversation-1', title: 'Design discussion' }],
      },
      chats: [
        {
          id: 'conversation-1',
          title: 'Design discussion',
          createdAt: '2026-08-27T01:00:00.000Z',
          updatedAt: '2026-08-27T01:05:00.000Z',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Explain this construct.',
              createdAt: '2026-08-27T01:00:00.000Z',
              references: [
                {
                  artifactId: 'artifact-root',
                  artifactType: 'sequence',
                  label: 'Example plasmid',
                },
              ],
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'It contains the selected sequence.',
              createdAt: '2026-08-27T01:05:00.000Z',
              references: [],
            },
          ],
        },
      ],
    });
    const untrusted = structuredClone(bundle);
    Object.assign(untrusted.chats[0], {
      provider: 'PRIVATE_FIELD_CANARY_7F3A',
      routeSnapshot: { host: 'PRIVATE_FIELD_CANARY_7F3A' },
      toolCalls: [{ input: 'PRIVATE_FIELD_CANARY_7F3A' }],
    });

    expect(validateDeepShareBundleV1(untrusted)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'chats[0] contains unsupported fields: provider, routeSnapshot, toolCalls',
      ]),
    });
  });
});
