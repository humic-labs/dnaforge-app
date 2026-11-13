// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmbedDefinition, PickerResult } from './types';
import { createEmbedRegistry } from './registry';

interface MockEditor {
  chain: () => MockChain;
}

interface MockChain {
  focus: () => MockChain;
  insertContentAt: (pos: number, content: unknown) => MockChain;
  run: () => boolean;
}

function createMockEditor(shouldSucceed = true): MockEditor {
  const chain: MockChain = {
    focus: () => chain,
    insertContentAt: () => chain,
    run: () => shouldSucceed,
  };
  return {
    chain: () => chain,
  };
}

const createTestDefinition = (overrides: Partial<EmbedDefinition> = {}): EmbedDefinition => ({
  type: 'test-embed',
  version: 1,
  label: 'Test Embed',
  icon: '🧪',
  keywords: ['test'],
  picker: {
    stages: [],
    size: 'md',
    onComplete: (data) => ({
      nodeType: 'embed',
      embedType: 'test-embed',
      refId: data.refId as string,
    }),
  },
  ...overrides,
});

const createMentionDefinition = (overrides: Partial<EmbedDefinition> = {}): EmbedDefinition => ({
  type: 'test-mention',
  version: 1,
  label: 'Test Mention',
  icon: '📝',
  keywords: ['mention'],
  picker: {
    stages: [],
    size: 'sm',
    onComplete: (data) => ({
      nodeType: 'mention',
      entityType: 'test',
      entityId: data.entityId as string,
      label: data.label as string,
    }),
  },
  ...overrides,
});

describe('EmbedRegistry', () => {
  let registry: ReturnType<typeof createEmbedRegistry>;

  beforeEach(() => {
    registry = createEmbedRegistry();
  });

  describe('register', () => {
    it('registers a new embed definition', () => {
      const def = createTestDefinition();
      registry.register(def);

      expect(registry.has('test-embed')).toBe(true);
      expect(registry.get('test-embed')).toBe(def);
    });

    it('overwrites existing definition with warning', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const def1 = createTestDefinition({ label: 'Original' });
      const def2 = createTestDefinition({ label: 'Updated' });

      registry.register(def1);
      registry.register(def2);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[EmbedRegistry] Overwriting existing embed type: test-embed'
      );
      expect(registry.get('test-embed')?.label).toBe('Updated');

      consoleSpy.mockRestore();
    });
  });

  describe('get and has', () => {
    it('returns undefined for unregistered type', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('returns definition for registered type', () => {
      const def = createTestDefinition();
      registry.register(def);

      expect(registry.get('test-embed')).toBe(def);
      expect(registry.has('test-embed')).toBe(true);
    });
  });

  describe('getAll', () => {
    it('returns empty array when no definitions registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('returns all registered definitions', () => {
      const def1 = createTestDefinition({ type: 'embed-1' });
      const def2 = createTestDefinition({ type: 'embed-2' });

      registry.register(def1);
      registry.register(def2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(def1);
      expect(all).toContain(def2);
    });
  });

  describe('hasPicker', () => {
    it('returns false for definition without picker', () => {
      const def = createTestDefinition({ picker: undefined });
      registry.register(def);

      expect(registry.hasPicker('test-embed')).toBe(false);
    });

    it('returns true for definition with picker', () => {
      const def = createTestDefinition();
      registry.register(def);

      expect(registry.hasPicker('test-embed')).toBe(true);
    });

    it('returns true for zero-stage picker', () => {
      const def = createTestDefinition({
        picker: {
          stages: [],
          onComplete: () => ({ nodeType: 'embed', embedType: 'test', refId: '123' }),
        },
      });
      registry.register(def);

      expect(registry.hasPicker('test-embed')).toBe(true);
    });
  });

  describe('getSlashCommands', () => {
    it('returns empty array when no definitions have pickers', () => {
      const def = createTestDefinition({ picker: undefined });
      registry.register(def);

      expect(registry.getSlashCommands()).toEqual([]);
    });

    it('generates slash commands from definitions with pickers', () => {
      const def = createTestDefinition();
      registry.register(def);

      const commands = registry.getSlashCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toEqual({
        name: 'test-embed',
        label: 'Test Embed',
        description: 'Insert test embed',
        icon: '🧪',
        keywords: ['test'],
        category: 'embed',
        flowName: 'test-embed',
      });
    });

    it('includes both block embed and mention commands', () => {
      registry.register(createTestDefinition());
      registry.register(createMentionDefinition());

      const commands = registry.getSlashCommands();
      expect(commands).toHaveLength(2);
    });
  });

  describe('completePickerFlow', () => {
    it('returns false for unregistered type', () => {
      const editor = createMockEditor();
      const result = registry.completePickerFlow('nonexistent', editor, {}, 0);

      expect(result).toBe(false);
    });

    it('returns false for type without picker', () => {
      const def = createTestDefinition({ picker: undefined });
      registry.register(def);

      const editor = createMockEditor();
      const result = registry.completePickerFlow('test-embed', editor, {}, 0);

      expect(result).toBe(false);
    });

    it('inserts embed node for block embed result', () => {
      const def = createTestDefinition({
        picker: {
          stages: [],
          onComplete: (data) => ({
            nodeType: 'embed',
            embedType: 'test-embed',
            refId: data.refId as string,
            data: { extra: 'info' },
          }),
        },
      });
      registry.register(def);

      const insertedContent: unknown[] = [];
      const editor: MockEditor = {
        chain: () => ({
          focus: function () {
            return this;
          },
          insertContentAt: function (_pos: number, content: unknown) {
            insertedContent.push(content);
            return this;
          },
          run: () => true,
        }),
      };

      const result = registry.completePickerFlow('test-embed', editor, { refId: 'abc123' }, 10);

      expect(result).toBe(true);
      expect(insertedContent).toHaveLength(1);
      expect(insertedContent[0]).toEqual({
        type: 'embed',
        attrs: {
          type: 'test-embed',
          version: 1,
          refId: 'abc123',
          data: { extra: 'info' },
        },
      });
    });

    it('inserts mention node for inline mention result', () => {
      const def = createMentionDefinition();
      registry.register(def);

      const insertedContent: unknown[] = [];
      const editor: MockEditor = {
        chain: () => ({
          focus: function () {
            return this;
          },
          insertContentAt: function (_pos: number, content: unknown) {
            insertedContent.push(content);
            return this;
          },
          run: () => true,
        }),
      };

      const result = registry.completePickerFlow(
        'test-mention',
        editor,
        { entityId: 'entity-456', label: 'Test Entity' },
        5
      );

      expect(result).toBe(true);
      expect(insertedContent).toHaveLength(1);
      expect(insertedContent[0]).toEqual({
        type: 'mention',
        attrs: {
          entityType: 'test',
          entityId: 'entity-456',
          label: 'Test Entity',
          path: null,
          contentHash: null,
          objectUuid: null,
        },
      });
    });

    it('returns false when editor insert fails', () => {
      const def = createTestDefinition();
      registry.register(def);

      const editor = createMockEditor(false);
      const result = registry.completePickerFlow('test-embed', editor, { refId: 'abc' }, 0);

      expect(result).toBe(false);
    });

    it('catches and handles errors in onComplete', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const def = createTestDefinition({
        picker: {
          stages: [],
          onComplete: () => {
            throw new Error('Validation failed');
          },
        },
      });
      registry.register(def);

      const editor = createMockEditor();
      const result = registry.completePickerFlow('test-embed', editor, {}, 0);

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[EmbedRegistry] Error completing picker flow for test-embed:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('handles missing required data gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const def = createTestDefinition({
        picker: {
          stages: [],
          onComplete: (data) => {
            if (!data.refId) {
              throw new Error('Missing required refId');
            }
            return { nodeType: 'embed', embedType: 'test', refId: data.refId as string };
          },
        },
      });
      registry.register(def);

      const editor = createMockEditor();
      const result = registry.completePickerFlow('test-embed', editor, {}, 0);

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('clear', () => {
    it('removes all registered definitions', () => {
      registry.register(createTestDefinition({ type: 'embed-1' }));
      registry.register(createTestDefinition({ type: 'embed-2' }));

      expect(registry.getAll()).toHaveLength(2);

      registry.clear();

      expect(registry.getAll()).toHaveLength(0);
      expect(registry.has('embed-1')).toBe(false);
      expect(registry.has('embed-2')).toBe(false);
    });
  });
});
