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
  PANEL_CLASS,
  ProjectActionGlyph,
  PrototypeSurface,
  SelectionNotice,
} from '../shared';

export function VariantC({ onRequestClose }: ImportPickerVariantProps) {
  const [selectedTypeId, setSelectedTypeId] = useState<ConfirmedEntityTypeId>('dna-sequences');
  const [selectedEntityAction, setSelectedEntityAction] = useState<EntityAction | null>(null);
  const [selectedProjectAction, setSelectedProjectAction] = useState<ProjectImportAction | null>(
    null
  );
  const selectedType =
    CONFIRMED_ENTITY_TYPES.find((entityType) => entityType.id === selectedTypeId) ??
    CONFIRMED_ENTITY_TYPES[0];

  return (
    <PrototypeSurface
      label="Split workbench Add picker"
      className={`${PANEL_CLASS} h-[540px] w-[720px] overflow-hidden !border-[#315282] !bg-[#dfe6f0] font-['Avenir_Next',Avenir,Arial,sans-serif] text-[#12213a]`}
    >
      <div className="grid h-[400px] grid-cols-[190px_1fr]">
        <nav className="bg-[#123f9a] text-white" aria-label="Entity types">
          <div className="flex h-[58px] items-center border-b border-white/25 px-5 text-xl font-semibold tracking-tight">
            Add
          </div>
          {CONFIRMED_ENTITY_TYPES.map((entityType, index) => {
            const active = entityType.id === selectedTypeId;

            return (
              <button
                key={entityType.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelectedTypeId(entityType.id);
                  setSelectedEntityAction(null);
                  setSelectedProjectAction(null);
                }}
                className={`relative flex h-[108px] w-full flex-col items-start justify-center gap-2 border-b border-white/20 px-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ${
                  active ? 'bg-[#f2f6fb] text-[#123f9a]' : 'text-white hover:bg-[#1a52bd]'
                }`}
              >
                <span className="absolute right-3 top-2 font-mono text-[10px] opacity-55">
                  0{index + 1}
                </span>
                <EntityTypeGlyph type={entityType} className="h-8 w-8" />
                <span className="text-[15px] font-semibold">{entityType.label}</span>
              </button>
            );
          })}
        </nav>

        <section className="relative bg-[#edf1f6]">
          <header className="flex h-[58px] items-center justify-end border-b border-[#9eacc0] px-4">
            <ClosePickerButton onClick={onRequestClose} className="text-[#315282]" />
          </header>

          <div className="px-7 pt-6">
            <div className="flex items-center gap-5 border-b-2 border-[#315282] pb-5">
              <div className="flex h-24 w-24 items-center justify-center border-2 border-[#315282] bg-[#d5deeb] text-[#123f9a]">
                <EntityTypeGlyph type={selectedType} className="h-16 w-16" />
              </div>
              <h2 className="max-w-[300px] text-[32px] font-semibold leading-none tracking-[-0.035em]">
                {selectedType.label}
              </h2>
            </div>

            <div className="mt-5 grid grid-cols-2 border-2 border-[#315282]">
              {ENTITY_ACTIONS.map((action, index) => {
                const active = selectedEntityAction === action;

                return (
                  <button
                    key={action}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedEntityAction(action);
                      setSelectedProjectAction(null);
                    }}
                    className={`flex h-[82px] flex-col items-start justify-between border-l border-[#315282] p-3 text-left first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#123f9a] ${
                      active
                        ? 'bg-[#123f9a] text-white'
                        : 'bg-[#f7f9fc] text-[#12213a] hover:bg-[#d5deeb]'
                    }`}
                  >
                    <span className="font-mono text-[10px] opacity-65">A{index + 1}</span>
                    <span className="text-sm font-semibold leading-tight">{action}</span>
                  </button>
                );
              })}
            </div>

            <SelectionNotice className="mt-4 flex h-9 items-center border-l-4 border-[#123f9a] bg-[#d5deeb] px-3 font-mono text-[11px] font-semibold text-[#315282]">
              Selected action: {selectedEntityAction ?? 'None'}
            </SelectionNotice>
          </div>
        </section>
      </div>

      <section className="h-[140px] border-t-4 border-[#54a8ff] bg-[#17253f] text-white">
        <h3 className="flex h-11 items-center px-5 text-lg font-semibold tracking-tight">
          Project-scale actions
        </h3>
        <div className="grid h-[92px] grid-cols-3 border-t border-white/25">
          {PROJECT_IMPORT_ACTIONS.map((action, index) => {
            const active = selectedProjectAction === action;

            return (
              <button
                key={action}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelectedProjectAction(action);
                  setSelectedEntityAction(null);
                }}
                className={`flex items-center gap-3 border-l border-white/25 px-4 text-left first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#54a8ff] ${
                  active ? 'bg-[#54a8ff] text-[#0f2038]' : 'text-white hover:bg-[#223b64]'
                }`}
              >
                <span className="font-mono text-[10px] opacity-60">P{index + 1}</span>
                <ProjectActionGlyph action={action} className="h-6 w-6 flex-none" />
                <span className="text-sm font-semibold leading-tight">{action}</span>
              </button>
            );
          })}
        </div>
      </section>
    </PrototypeSurface>
  );
}
