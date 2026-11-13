// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  NotebookContentExtensionError,
  createNotebookContentExtensionRegistry,
  type NotebookContentExtension,
  type NotebookRichBlockContract,
} from './notebook-content-extension';

function blockContract(
  overrides: Partial<NotebookRichBlockContract> = {}
): NotebookRichBlockContract {
  return {
    kind: 'rich-block',
    type: 'table',
    currentVersion: 1,
    migrations: [],
    parseData: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, data: value }
        : { ok: false, reason: 'data must be an object' },
    toMarkdown: ({ refId }) => `Table ${refId}`,
    ...overrides,
  };
}

describe('notebook content extension registry', () => {
  it('rejects duplicate logical types across one extension kind', () => {
    expect(() =>
      createNotebookContentExtensionRegistry([blockContract(), blockContract()])
    ).toThrowError(
      expect.objectContaining<Partial<NotebookContentExtensionError>>({
        code: 'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      })
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid current rich-block version: %s',
    (currentVersion) => {
      expect(() =>
        createNotebookContentExtensionRegistry([blockContract({ currentVersion })])
      ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_CONTENT_EXTENSION_INVALID' }));
    }
  );

  it('rejects a migration chain with a missing version step', () => {
    expect(() =>
      createNotebookContentExtensionRegistry([
        blockContract({
          currentVersion: 3,
          migrations: [{ from: 1, to: 3, migrate: (data) => data }],
        }),
      ])
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_CONTENT_EXTENSION_INVALID' }));
  });

  it('rejects a Markdown parser that cannot be reached from a registered AST type', () => {
    expect(() =>
      createNotebookContentExtensionRegistry([
        blockContract({ fromMarkdown: ({ refId }) => ({ refId, data: {} }) }),
      ])
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_CONTENT_EXTENSION_INVALID' }));
  });

  it('rejects two contracts that claim the same Markdown AST type', () => {
    expect(() =>
      createNotebookContentExtensionRegistry([
        blockContract({
          markdownNodeTypes: ['table'],
          fromMarkdown: ({ refId }) => ({ refId, data: {} }),
        }),
        blockContract({
          type: 'grid',
          markdownNodeTypes: ['table'],
          fromMarkdown: ({ refId }) => ({ refId, data: {} }),
        }),
      ])
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_CONTENT_EXTENSION_INVALID' }));
  });

  it('accepts camelCase Markdown AST node names used by the unified ecosystem', () => {
    const registry = createNotebookContentExtensionRegistry([
      blockContract({
        markdownNodeTypes: ['containerDirective'],
        fromMarkdown: ({ refId }) => ({ refId, data: {} }),
      }),
    ]);

    expect(registry.richBlockForMarkdownNode('containerDirective')?.type).toBe('table');
  });

  it('migrates old data one version at a time and validates the current result', () => {
    const visited: number[] = [];
    const registry = createNotebookContentExtensionRegistry([
      blockContract({
        currentVersion: 3,
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (data) => {
              visited.push(1);
              return { ...data, second: true };
            },
          },
          {
            from: 2,
            to: 3,
            migrate: (data) => {
              visited.push(2);
              return { ...data, third: true };
            },
          },
        ],
        parseData: (value) => {
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            'second' in value &&
            'third' in value
          ) {
            return { ok: true, data: value };
          }
          return { ok: false, reason: 'migration result is incomplete' };
        },
      }),
    ]);

    expect(registry.resolveRichBlock({ type: 'table', version: 1, data: {} })).toEqual({
      kind: 'supported',
      contract: expect.objectContaining({ type: 'table', currentVersion: 3 }),
      data: { second: true, third: true },
      sourceVersion: 1,
      version: 3,
    });
    expect(visited).toEqual([1, 2]);
  });

  it('fails closed when current-version data does not satisfy its contract', () => {
    const registry = createNotebookContentExtensionRegistry([blockContract()]);

    expect(() =>
      registry.resolveRichBlock({ type: 'table', version: 1, data: 'not-an-object' })
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_CONTENT_DATA_INVALID' }));
  });

  it('keeps unknown types opaque without pretending to validate their data schema', () => {
    const registry = createNotebookContentExtensionRegistry([blockContract()]);

    expect(
      registry.resolveRichBlock({ type: 'future-diagram', version: 4, data: { nodes: 3 } })
    ).toEqual({
      kind: 'unknown',
      type: 'future-diagram',
      version: 4,
      data: { nodes: 3 },
    });
  });

  it('keeps a newer known version opaque instead of running an older validator', () => {
    const registry = createNotebookContentExtensionRegistry([blockContract()]);

    expect(
      registry.resolveRichBlock({ type: 'table', version: 2, data: { futureShape: true } })
    ).toEqual({
      kind: 'future',
      type: 'table',
      version: 2,
      supportedVersion: 1,
      data: { futureShape: true },
    });
  });

  it('registers mark adapters independently from rich blocks', () => {
    const extensions: NotebookContentExtension[] = [
      blockContract(),
      {
        kind: 'mark',
        type: 'sample-emphasis',
        toMarkdown: ({ text }) => `^^${text}^^`,
      },
    ];
    const registry = createNotebookContentExtensionRegistry(extensions);

    expect(registry.mark('sample-emphasis')?.toMarkdown({ text: 'result', attrs: {} })).toBe(
      '^^result^^'
    );
  });

  it('accepts camelCase mark names used by TipTap extensions', () => {
    const registry = createNotebookContentExtensionRegistry([
      {
        kind: 'mark',
        type: 'textStyle',
        toMarkdown: ({ text }) => text,
      },
    ]);

    expect(registry.mark('textStyle')).toBeDefined();
  });
});
