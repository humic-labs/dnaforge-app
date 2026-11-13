import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

import { createInsertionRangeTracker } from '../entity-ref/insertion-range-tracker';
import type {
  EmbedDefinition,
  EmbedPreviewProps,
  EmbedRendererProps,
  PickerSize,
  PickerResult,
} from './types';
import type { SlashCommand } from '../editor/lib/commands';

class EmbedRegistry {
  private definitions = new Map<string, EmbedDefinition>();

  register(definition: EmbedDefinition): void {
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new Error(`[EmbedRegistry] Invalid version for ${definition.type}`);
    }
    if (this.definitions.has(definition.type)) {
      console.warn(`[EmbedRegistry] Overwriting existing embed type: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
  }

  registerAll(definitions: EmbedDefinition[]): void {
    definitions.forEach((def) => this.register(def));
  }

  get(type: string): EmbedDefinition | undefined {
    return this.definitions.get(type);
  }

  getAll(): EmbedDefinition[] {
    return Array.from(this.definitions.values());
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  getRenderer(
    type: string,
    version: number = 1
  ): React.ComponentType<EmbedRendererProps> | undefined {
    const definition = this.definitions.get(type);
    return definition?.version === version ? definition.Renderer : undefined;
  }

  getPicker(type: string): EmbedDefinition['picker'] | undefined {
    return this.definitions.get(type)?.picker;
  }

  getPickerSize(type: string): PickerSize {
    return this.definitions.get(type)?.picker?.size ?? 'md';
  }

  hasPicker(type: string): boolean {
    const def = this.definitions.get(type);
    return !!def?.picker;
  }

  capturesEditorFocus(type: string): boolean {
    return this.definitions.get(type)?.capturesEditorFocus ?? false;
  }

  getPickerTypes(): string[] {
    return Array.from(this.definitions.values())
      .filter((def) => def.picker)
      .map((def) => def.type);
  }

  getSlashCommands(): SlashCommand[] {
    return Array.from(this.definitions.values())
      .filter((def) => def.picker && !def.importOnly)
      .map((def) => ({
        name: def.type,
        label: def.label,
        description: `Insert ${def.label.toLowerCase()}`,
        icon: def.icon,
        keywords: def.keywords,
        category: 'embed' as const,
        flowName: def.type,
      }));
  }

  completePickerFlow(
    type: string,
    editor: Editor,
    data: Record<string, unknown>,
    startPos: number
  ): boolean | Promise<boolean> {
    const def = this.definitions.get(type);
    if (!def?.picker) {
      console.warn(`[EmbedRegistry] No picker for type: ${type}`);
      return false;
    }

    try {
      const produced = def.picker.onComplete(data);

      if (!isPromise(produced)) {
        return this.insertPickerResult(type, produced, editor, startPos);
      }

      return this.completePickerFlowAsync(type, produced, editor, startPos);
    } catch (error) {
      console.error(`[EmbedRegistry] Error completing picker flow for ${type}:`, error);
      return false;
    }
  }

  private async completePickerFlowAsync(
    type: string,
    pending: Promise<PickerResult>,
    editor: Editor,
    startPos: number
  ): Promise<boolean> {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(startPos);
    const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
      tracker.onTransaction(transaction.mapping);
    };
    editor.on('transaction', onTransaction);

    try {
      const result = await pending;

      if (editor.isDestroyed) {
        console.warn(`[EmbedRegistry] Editor destroyed before ${type} could be inserted`);
        return false;
      }

      const range = tracker.resolve(token);
      if (!range.ok) {
        console.warn(
          `[EmbedRegistry] Abandoned ${type} insertion: ${range.reason}. ` +
            'The text it was anchored to no longer exists.'
        );
        return false;
      }

      return this.insertPickerResult(type, result, editor, range.pos);
    } catch (error) {
      console.error(`[EmbedRegistry] Error completing picker flow for ${type}:`, error);
      return false;
    } finally {
      editor.off('transaction', onTransaction);
      tracker.release(token);
    }
  }

  private insertPickerResult(
    type: string,
    result: PickerResult,
    editor: Editor,
    pos: number
  ): boolean {
    let success: boolean;

    if (result.nodeType === 'mention') {
      success = editor
        .chain()
        .focus()
        .insertContentAt(pos, {
          type: 'mention',
          attrs: {
            entityType: result.entityType,
            entityId: result.entityId,
            label: result.label,
            path: result.path ?? null,
            contentHash: result.contentHash ?? null,
            objectUuid: result.objectUuid ?? null,
          },
        })
        .run();
    } else {
      const embedData = result.data ?? {};
      if (this.capturesEditorFocus(result.embedType)) {
        (embedData as Record<string, unknown>)._fresh = true;
      }

      success = editor
        .chain()
        .focus()
        .insertContentAt(pos, {
          type: 'embed',
          attrs: {
            type: result.embedType,
            version: this.definitions.get(result.embedType)?.version ?? 1,
            refId: result.refId,
            data: embedData,
          },
        })
        .run();

      if (success && this.capturesEditorFocus(result.embedType)) {
        console.log(`[EmbedRegistry] capturesEditorFocus embed inserted: ${result.embedType}`);
        console.log(
          `[EmbedRegistry] Block should be selected, input should get focus via InlineConfig`
        );
      }
    }

    if (!success) {
      console.error(`[EmbedRegistry] Failed to insert ${type} node`);
    }
    return success;
  }

  getPreview(type: string): React.ComponentType<EmbedPreviewProps> | undefined {
    return this.definitions.get(type)?.Preview;
  }

  cancelPickerFlow(type: string): void {
    const def = this.definitions.get(type);
    def?.picker?.onCancel?.();
  }

  clear(): void {
    this.definitions.clear();
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

export function createEmbedRegistry(): EmbedRegistry {
  return new EmbedRegistry();
}

export const embedRegistry = new EmbedRegistry();

export type { EmbedRegistry };
