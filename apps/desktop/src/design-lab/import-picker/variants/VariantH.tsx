import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ConfirmedEntityType,
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
} from '../shared';

const TYPE_POSITION: Record<ConfirmedEntityTypeId, string> = {
  'dna-sequences': 'left-[48px] top-[86px]',
  primers: 'left-1/2 top-[16px] -translate-x-1/2',
  strains: 'right-[48px] top-[86px]',
};

const ACTION_POSITION: Record<EntityAction, string> = {
  Create: 'left-[178px] top-[274px]',
  Import: 'right-[178px] top-[274px]',
};

const ACTION_ANGLE: Record<EntityAction, number> = {
  Create: -28,
  Import: 28,
};

export function VariantH({ onRequestClose }: ImportPickerVariantProps) {
  const [selectedType, setSelectedType] = useState<ConfirmedEntityType>(CONFIRMED_ENTITY_TYPES[0]);
  const [selectedAction, setSelectedAction] = useState<EntityAction>(ENTITY_ACTIONS[0]);
  const [projectAction, setProjectAction] = useState<ProjectImportAction | null>(null);

  const chooseType = (type: ConfirmedEntityType): void => {
    setSelectedType(type);
    setProjectAction(null);
  };

  const chooseAction = (action: EntityAction): void => {
    setSelectedAction(action);
    setProjectAction(null);
  };

  return (
    <PrototypeSurface
      label="Instrument Dial import picker"
      className={`${PANEL_CLASS} h-[560px] w-[650px] overflow-hidden border-2 border-[#332f2a] bg-[#f2ead9] text-[#332f2a] shadow-[10px_10px_0_rgba(51,47,42,0.2)]`}
      style={{ fontFamily: 'Futura, "Trebuchet MS", sans-serif' }}
    >
      <header className="flex h-[52px] items-center justify-between border-b-2 border-[#332f2a] bg-[#e6d8c0] px-5">
        <div className="flex items-center gap-3">
          <span className="h-5 w-1 bg-[#d75a4a]" aria-hidden="true" />
          <h2 className="text-[17px] font-bold tracking-wide">Add</h2>
        </div>
        <ClosePickerButton onClick={onRequestClose} className="text-[#332f2a]" />
      </header>

      <section
        className="relative h-[352px] overflow-hidden"
        aria-label="Type and action instrument"
      >
        <div
          className="absolute left-[132px] right-[132px] top-[126px] h-px bg-[#7b7063]"
          aria-hidden="true"
        />
        <div
          className="absolute left-1/2 top-[88px] h-[190px] w-px -translate-x-1/2 bg-[#7b7063]"
          aria-hidden="true"
        />
        <div
          className="absolute left-[202px] top-[212px] h-px w-[246px] -rotate-[12deg] bg-[#7b7063]"
          aria-hidden="true"
        />
        <div
          className="absolute left-[202px] top-[212px] h-px w-[246px] rotate-[12deg] bg-[#7b7063]"
          aria-hidden="true"
        />

        {CONFIRMED_ENTITY_TYPES.map((type) => {
          const selected = selectedType.id === type.id;
          return (
            <button
              key={type.id}
              type="button"
              aria-pressed={selected}
              onClick={() => chooseType(type)}
              className={`absolute z-10 flex h-[92px] w-[92px] flex-col items-center justify-center rounded-full border-[3px] text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d75a4a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f2ead9] ${TYPE_POSITION[type.id]} ${
                selected
                  ? 'border-[#d75a4a] bg-[#332f2a] text-[#fff8eb] shadow-[0_0_0_5px_#f2ead9,0_0_0_7px_#d75a4a]'
                  : 'border-[#332f2a] bg-[#f8f0df] text-[#332f2a] hover:bg-[#e6d8c0]'
              }`}
            >
              <EntityTypeGlyph type={type} className="h-7 w-7" />
              <span className="mt-1 max-w-[76px] text-[10px] font-bold leading-tight">
                {type.label}
              </span>
            </button>
          );
        })}

        <div
          className="absolute left-1/2 top-[94px] z-0 flex h-[172px] w-[172px] -translate-x-1/2 flex-col items-center justify-center rounded-full border-[6px] border-[#332f2a] bg-[#efe2cb] shadow-[inset_0_0_0_3px_#d75a4a,inset_0_0_0_9px_#f2ead9]"
          aria-live="polite"
        >
          <span
            className="absolute left-1/2 top-[14px] h-[72px] w-1 -translate-x-1/2 bg-[#d75a4a] transition-transform duration-200"
            style={{
              transform: `translateX(-50%) rotate(${ACTION_ANGLE[selectedAction]}deg)`,
              transformOrigin: '50% 72px',
            }}
            aria-hidden="true"
          />
          <span
            className="absolute left-1/2 top-[80px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-[#332f2a] bg-[#d75a4a]"
            aria-hidden="true"
          />
          <div className="mt-11 flex flex-col items-center">
            <EntityTypeGlyph type={selectedType} className="h-8 w-8" />
            <span className="mt-1 text-[11px] font-bold">{selectedType.label}</span>
            <span className="mt-0.5 text-[10px] font-bold text-[#b9473b]">{selectedAction}</span>
          </div>
        </div>

        {ENTITY_ACTIONS.map((action) => {
          const selected = selectedAction === action;
          return (
            <button
              key={action}
              type="button"
              aria-label={`${action} ${selectedType.singularLabel}`}
              aria-pressed={selected}
              onClick={() => chooseAction(action)}
              className={`absolute z-10 flex h-[76px] w-[76px] items-center justify-center rounded-full border-[3px] px-2 text-center text-[10px] font-bold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d75a4a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f2ead9] ${ACTION_POSITION[action]} ${
                selected
                  ? 'border-[#332f2a] bg-[#d75a4a] text-white shadow-[0_0_0_5px_#f2ead9,0_0_0_7px_#332f2a]'
                  : 'border-[#7b7063] bg-[#f8f0df] text-[#332f2a] hover:border-[#d75a4a] hover:bg-[#e6d8c0]'
              }`}
            >
              {action}
            </button>
          );
        })}
      </section>

      <section
        className="grid h-[156px] grid-cols-[178px_repeat(3,minmax(0,1fr))] border-t-[6px] border-[#332f2a] bg-[#e6d8c0]"
        aria-labelledby="dial-project-actions"
      >
        <div className="relative flex items-center border-r-2 border-[#332f2a] px-5">
          <span className="absolute inset-y-4 left-0 w-2 bg-[#d75a4a]" aria-hidden="true" />
          <h3 id="dial-project-actions" className="text-[16px] font-bold leading-tight">
            Project-scale actions
          </h3>
        </div>
        {PROJECT_IMPORT_ACTIONS.map((action) => {
          const selected = projectAction === action;
          return (
            <button
              key={action}
              type="button"
              aria-pressed={selected}
              onClick={() => setProjectAction(action)}
              className={`relative flex flex-col items-center justify-center gap-3 border-r border-[#7b7063] px-3 text-center text-[11px] font-bold last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#d75a4a] ${
                selected
                  ? 'bg-[#332f2a] text-[#fff8eb]'
                  : 'bg-[#e6d8c0] text-[#332f2a] hover:bg-[#dac9ae]'
              }`}
            >
              <span
                className={`absolute inset-x-0 top-0 h-2 ${
                  selected ? 'bg-[#d75a4a]' : 'bg-transparent'
                }`}
                aria-hidden="true"
              />
              <ProjectActionGlyph action={action} className="h-6 w-6" />
              <span>{action}</span>
            </button>
          );
        })}
      </section>
    </PrototypeSurface>
  );
}
