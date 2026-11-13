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
import {
  ClosePickerButton,
  EntityTypeGlyph,
  ProjectActionGlyph,
  PrototypeSurface,
} from '../shared';

type Selection =
  | { kind: 'entity'; typeId: ConfirmedEntityTypeId; action: EntityAction }
  | { kind: 'project'; action: ProjectImportAction }
  | null;

const CREATE_ACTION = ENTITY_ACTIONS[0];

export function VariantE({ onRequestClose }: ImportPickerVariantProps) {
  const [selection, setSelection] = useState<Selection>(null);
  const importAction: EntityAction = ENTITY_ACTIONS[1];

  const entitySelected = (typeId: ConfirmedEntityTypeId, action: EntityAction): boolean =>
    selection?.kind === 'entity' && selection.typeId === typeId && selection.action === action;

  return (
    <PrototypeSurface
      label="Action Stripes"
      style={{ fontFamily: '"Arial Black", Arial, sans-serif' }}
      className="absolute left-[264px] top-[47px] z-20 min-h-[500px] w-[700px] border-2 border-[#0a0a08] bg-[#f4f1e8] text-[#0a0a08] shadow-[10px_10px_0_#0a0a08]"
    >
      <header className="flex h-12 items-center justify-between border-b-2 border-[#0a0a08] px-4">
        <span className="text-sm font-black tracking-[0.18em]">ADD</span>
        <ClosePickerButton onClick={onRequestClose} />
      </header>

      <section
        aria-label="Create"
        className="grid min-h-36 grid-cols-[190px_1fr] border-b-4 border-[#0a0a08]"
      >
        <h2 className="flex items-center border-r-4 border-[#0a0a08] bg-[#c8ff00] px-4 text-[34px] font-black leading-none tracking-[-0.06em]">
          CREATE
        </h2>
        <div className="grid grid-cols-3 divide-x-2 divide-[#0a0a08]">
          {CONFIRMED_ENTITY_TYPES.map((type) => {
            const selected = entitySelected(type.id, CREATE_ACTION);
            return (
              <button
                key={type.id}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  setSelection({ kind: 'entity', typeId: type.id, action: CREATE_ACTION })
                }
                className={`flex min-w-0 flex-col items-start justify-center gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#0a0a08] ${
                  selected ? 'bg-[#0a0a08] text-[#c8ff00]' : 'hover:bg-[#e4e0d5]'
                }`}
              >
                <EntityTypeGlyph type={type} className="h-7 w-7" />
                <span className="text-[15px] font-black leading-4">{type.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        aria-label="Import"
        className="grid min-h-44 grid-cols-[190px_1fr] border-b-4 border-[#0a0a08] bg-[#0a0a08] text-[#f4f1e8]"
      >
        <div className="flex flex-col justify-center border-r-4 border-[#f4f1e8] px-4 py-4">
          <h2 className="text-[34px] font-black leading-none tracking-[-0.06em]">IMPORT</h2>
        </div>
        <div className="grid grid-cols-3 divide-x-2 divide-[#f4f1e8]">
          {CONFIRMED_ENTITY_TYPES.map((type) => {
            const selected = entitySelected(type.id, importAction);
            return (
              <button
                key={type.id}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  setSelection({ kind: 'entity', typeId: type.id, action: importAction })
                }
                className={`flex min-w-0 flex-col items-start justify-center gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#c8ff00] ${
                  selected
                    ? 'bg-[#c8ff00] text-[#0a0a08]'
                    : 'bg-[#0a0a08] text-[#f4f1e8] hover:bg-[#1b1b16]'
                }`}
              >
                <EntityTypeGlyph type={type} className="h-7 w-7" />
                <span className="text-[15px] font-black leading-4">{type.label}</span>
                <span className="font-sans text-[10px] font-bold uppercase tracking-wider">
                  {importAction}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Project-scale actions" className="grid grid-cols-[190px_1fr]">
        <h2 className="flex items-center border-r-4 border-[#0a0a08] bg-[#c8ff00] px-4 text-lg font-black leading-5">
          Project-scale actions
        </h2>
        <div className="grid grid-cols-3 divide-x-2 divide-[#0a0a08]">
          {PROJECT_IMPORT_ACTIONS.map((action) => {
            const selected = selection?.kind === 'project' && selection.action === action;
            return (
              <button
                key={action}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelection({ kind: 'project', action })}
                className={`flex min-h-28 items-center gap-2 px-3 text-left text-xs font-black leading-4 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#0a0a08] ${
                  selected ? 'bg-[#0a0a08] text-[#c8ff00]' : 'hover:bg-[#e4e0d5]'
                }`}
              >
                <ProjectActionGlyph action={action} className="h-5 w-5" />
                <span>{action}</span>
              </button>
            );
          })}
        </div>
      </section>
    </PrototypeSurface>
  );
}
