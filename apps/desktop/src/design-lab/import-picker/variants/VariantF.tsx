import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ConfirmedEntityTypeId,
  type EntityAction,
  type ImportPickerVariantProps,
  type ProjectImportAction,
} from '../model';
import { EntityTypeGlyph, ProjectActionGlyph, PrototypeSurface } from '../shared';

type Selection =
  | { kind: 'entity'; typeId: ConfirmedEntityTypeId; action: EntityAction }
  | { kind: 'project'; action: ProjectImportAction }
  | null;

export function VariantF({ onRequestClose }: ImportPickerVariantProps) {
  const [expandedType, setExpandedType] = useState<ConfirmedEntityTypeId | null>('dna-sequences');
  const [selection, setSelection] = useState<Selection>(null);

  return (
    <PrototypeSurface
      label="Inline Tree Composer"
      className="absolute left-0 top-[47px] z-20 h-[calc(100%-47px)] w-[304px] overflow-y-auto border-r border-border bg-bg font-sans text-[12px] text-fg"
    >
      <div className="flex h-9 items-center border-b border-border px-3">
        <span className="mr-1.5 text-fg-muted" aria-hidden="true">
          ▾
        </span>
        <span className="font-semibold">Add</span>
        <button
          type="button"
          onClick={onRequestClose}
          className="ml-auto text-[11px] font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:underline"
        >
          Cancel
        </button>
      </div>

      <div className="py-1" role="tree" aria-label="Add branch">
        {CONFIRMED_ENTITY_TYPES.map((type) => {
          const expanded = expandedType === type.id;
          return (
            <div key={type.id} role="treeitem" aria-expanded={expanded}>
              <button
                type="button"
                onClick={() => setExpandedType((current) => (current === type.id ? null : type.id))}
                className={`flex h-8 w-full items-center gap-1.5 border-l-2 pl-5 pr-3 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                  expanded
                    ? 'border-accent bg-accent/10 text-fg'
                    : 'border-transparent text-fg hover:bg-bg-muted'
                }`}
              >
                <span className="w-3 text-[10px] text-fg-muted" aria-hidden="true">
                  {expanded ? '▾' : '▸'}
                </span>
                <EntityTypeGlyph type={type} className="h-4 w-4" />
                <span>{type.label}</span>
              </button>

              {expanded && (
                <div
                  role="group"
                  className="relative py-0.5 before:absolute before:bottom-1 before:left-[34px] before:top-0 before:w-px before:bg-border"
                >
                  {ENTITY_ACTIONS.map((action) => {
                    const selected =
                      selection?.kind === 'entity' &&
                      selection.typeId === type.id &&
                      selection.action === action;
                    return (
                      <button
                        key={action}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelection({ kind: 'entity', typeId: type.id, action })}
                        className={`relative flex h-7 w-full items-center border-l-2 pl-[52px] pr-3 text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent before:absolute before:left-[34px] before:top-1/2 before:h-px before:w-3 before:bg-border ${
                          selected
                            ? 'border-accent bg-accent/10 font-semibold text-accent'
                            : 'border-transparent text-fg-muted hover:bg-bg-muted hover:text-fg'
                        }`}
                      >
                        {action}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <section aria-label="Project-scale actions" className="mt-2 border-t-2 border-border pt-1">
        <h2 className="flex h-9 items-center px-5 text-[13px] font-bold text-fg">
          Project-scale actions
        </h2>
        {PROJECT_IMPORT_ACTIONS.map((action) => {
          const selected = selection?.kind === 'project' && selection.action === action;
          return (
            <button
              key={action}
              type="button"
              aria-pressed={selected}
              onClick={() => setSelection({ kind: 'project', action })}
              className={`flex min-h-8 w-full items-center gap-2 border-l-2 py-1 pl-8 pr-3 text-left text-[11px] font-medium leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                selected
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-transparent text-fg hover:bg-bg-muted'
              }`}
            >
              <ProjectActionGlyph action={action} className="h-4 w-4" />
              <span>{action}</span>
            </button>
          );
        })}
      </section>
    </PrototypeSurface>
  );
}
