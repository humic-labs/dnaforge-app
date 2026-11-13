import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ConfirmedEntityType,
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

export function VariantG({ onRequestClose }: ImportPickerVariantProps) {
  const [selectedType, setSelectedType] = useState<ConfirmedEntityType>(CONFIRMED_ENTITY_TYPES[0]);
  const [selectedAction, setSelectedAction] = useState<EntityAction>(ENTITY_ACTIONS[0]);
  const [projectAction, setProjectAction] = useState<ProjectImportAction | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const chooseType = (type: ConfirmedEntityType): void => {
    setSelectedType(type);
    setConfirmed(false);
    setProjectAction(null);
  };

  const chooseAction = (action: EntityAction): void => {
    setSelectedAction(action);
    setConfirmed(false);
    setProjectAction(null);
  };

  return (
    <PrototypeSurface
      label="Three-stage Conveyor import picker"
      className={`${PANEL_CLASS} h-[500px] w-[820px] overflow-hidden border-[#7893a2] bg-[#eaf1f4] text-[#163447] shadow-[8px_8px_0_rgba(22,52,71,0.16)]`}
      style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}
    >
      <header className="flex h-12 items-center justify-between border-b-2 border-[#163447] bg-[#dbe7ec] px-4">
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 bg-[#ec6a2c]" aria-hidden="true" />
          <h2 className="text-[16px] font-bold tracking-tight">Add</h2>
          <span className="h-px w-28 bg-[#7893a2]" aria-hidden="true" />
        </div>
        <ClosePickerButton onClick={onRequestClose} className="text-[#163447]" />
      </header>

      <div className="grid h-[315px] grid-cols-[250px_250px_1fr]">
        <section className="relative border-r-2 border-[#7893a2]" aria-labelledby="conveyor-type">
          <div className="flex h-11 items-center gap-2 border-b border-[#7893a2] bg-[#dbe7ec] px-4">
            <span className="grid h-6 w-6 place-items-center bg-[#163447] text-xs font-bold text-white">
              1
            </span>
            <h3 id="conveyor-type" className="text-sm font-bold">
              Type
            </h3>
            <span className="ml-auto text-xl text-[#ec6a2c]" aria-hidden="true">
              →
            </span>
          </div>
          <div className="divide-y divide-[#9eb2bd]">
            {CONFIRMED_ENTITY_TYPES.map((type) => {
              const selected = selectedType.id === type.id;
              return (
                <button
                  key={type.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => chooseType(type)}
                  className={`relative flex h-[84px] w-full items-center gap-4 px-4 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ec6a2c] ${
                    selected
                      ? 'bg-[#f4f8fa] text-[#163447]'
                      : 'bg-[#eaf1f4] text-[#405c6b] hover:bg-[#e1ebef]'
                  }`}
                >
                  <span
                    className={`absolute inset-y-0 left-0 w-1.5 ${
                      selected ? 'bg-[#ec6a2c]' : 'bg-transparent'
                    }`}
                    aria-hidden="true"
                  />
                  <EntityTypeGlyph type={type} className="h-10 w-10" />
                  <span className="text-[15px] font-bold">{type.label}</span>
                  <span className="ml-auto text-lg" aria-hidden="true">
                    {selected ? '■' : '□'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="relative border-r-2 border-[#7893a2]" aria-labelledby="conveyor-action">
          <div className="flex h-11 items-center gap-2 border-b border-[#7893a2] bg-[#dbe7ec] px-4">
            <span className="grid h-6 w-6 place-items-center bg-[#163447] text-xs font-bold text-white">
              2
            </span>
            <h3 id="conveyor-action" className="text-sm font-bold">
              Action
            </h3>
            <span className="ml-auto text-xl text-[#ec6a2c]" aria-hidden="true">
              →
            </span>
          </div>
          <div className="flex h-12 items-center gap-2 border-b border-[#9eb2bd] px-4">
            <EntityTypeGlyph type={selectedType} className="h-5 w-5" />
            <span className="text-xs font-bold">{selectedType.label}</span>
          </div>
          <div className="divide-y divide-[#9eb2bd]">
            {ENTITY_ACTIONS.map((action, index) => {
              const selected = selectedAction === action;
              return (
                <button
                  key={action}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => chooseAction(action)}
                  className={`flex h-[64px] w-full items-center gap-3 px-4 text-left text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ec6a2c] ${
                    selected
                      ? 'bg-[#163447] text-white'
                      : 'bg-[#eaf1f4] text-[#294c60] hover:bg-[#dbe7ec]'
                  }`}
                >
                  <span
                    className={`grid h-7 w-7 place-items-center border text-[11px] ${
                      selected
                        ? 'border-[#ec6a2c] bg-[#ec6a2c] text-white'
                        : 'border-[#7893a2] text-[#294c60]'
                    }`}
                  >
                    {index + 1}
                  </span>
                  {action}
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex min-w-0 flex-col" aria-labelledby="conveyor-ready">
          <div className="flex h-11 items-center gap-2 border-b border-[#7893a2] bg-[#dbe7ec] px-4">
            <span className="grid h-6 w-6 place-items-center bg-[#163447] text-xs font-bold text-white">
              3
            </span>
            <h3 id="conveyor-ready" className="text-sm font-bold">
              Ready
            </h3>
          </div>
          <div
            className="flex flex-1 flex-col items-center justify-center px-5 text-center"
            aria-live="polite"
          >
            <div className="grid h-[92px] w-[92px] place-items-center border-2 border-[#163447] bg-[#f4f8fa] shadow-[5px_5px_0_#ec6a2c]">
              <EntityTypeGlyph type={selectedType} className="h-12 w-12" />
            </div>
            <div className="mt-5 flex items-center gap-2 text-sm font-bold">
              <EntityTypeGlyph type={selectedType} className="h-4 w-4" />
              <span>{selectedType.label}</span>
            </div>
            <div className="mt-1 text-xs font-bold text-[#ec6a2c]">{selectedAction}</div>
            <button
              type="button"
              aria-pressed={confirmed}
              onClick={() => setConfirmed((current) => !current)}
              className={`mt-5 min-h-10 w-full border-2 border-[#163447] px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ec6a2c] focus-visible:ring-offset-2 ${
                confirmed ? 'bg-[#ec6a2c] text-white' : 'bg-[#163447] text-white hover:bg-[#214b64]'
              }`}
            >
              {confirmed ? 'Confirmed' : `Confirm ${selectedAction}`}
            </button>
          </div>
        </section>
      </div>

      <section
        className="h-[135px] border-t-4 border-[#163447] bg-[#dbe7ec]"
        aria-labelledby="conveyor-project-actions"
      >
        <div className="flex h-10 items-center px-4">
          <h3 id="conveyor-project-actions" className="text-[16px] font-bold tracking-tight">
            Project-scale actions
          </h3>
          <span className="ml-4 h-0.5 flex-1 bg-[#163447]" aria-hidden="true" />
          <span className="h-3 w-3 bg-[#ec6a2c]" aria-hidden="true" />
        </div>
        <div className="grid h-[91px] grid-cols-3 border-t border-[#7893a2]">
          {PROJECT_IMPORT_ACTIONS.map((action) => {
            const selected = projectAction === action;
            return (
              <button
                key={action}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setProjectAction(action);
                  setConfirmed(false);
                }}
                className={`relative flex items-center justify-center gap-3 border-l border-[#7893a2] px-4 text-left text-sm font-bold first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ec6a2c] ${
                  selected
                    ? 'bg-[#163447] text-white'
                    : 'bg-[#dbe7ec] text-[#163447] hover:bg-[#cbdbe2]'
                }`}
              >
                <span
                  className={`absolute inset-x-5 top-0 h-1 ${
                    selected ? 'bg-[#ec6a2c]' : 'bg-[#7893a2]'
                  }`}
                  aria-hidden="true"
                />
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
