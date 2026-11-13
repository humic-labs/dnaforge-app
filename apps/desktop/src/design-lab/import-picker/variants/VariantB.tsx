import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ImportPickerVariantProps,
} from '../model';
import {
  ClosePickerButton,
  EntityTypeGlyph,
  PANEL_CLASS,
  ProjectActionGlyph,
  PrototypeSurface,
} from '../shared';

export function VariantB({ onRequestClose }: ImportPickerVariantProps) {
  const [selection, setSelection] = useState<string | null>(null);

  return (
    <PrototypeSurface
      label="Editorial ledger Add picker"
      className={`${PANEL_CLASS} h-[520px] w-[680px] overflow-hidden !border-[#33271f] !bg-[#f4eddf] font-[Georgia,'Times_New_Roman',serif] text-[#241c17] shadow-[8px_10px_0_rgba(55,39,28,0.18)]`}
    >
      <header className="flex h-[78px] items-end justify-between border-b-[3px] border-[#33271f] px-6 pb-3">
        <h2 className="text-[42px] font-bold leading-none tracking-[-0.045em]">Add</h2>
        <ClosePickerButton onClick={onRequestClose} className="mb-0.5 text-[#33271f]" />
      </header>

      <section aria-label="Entity action ledger" className="px-6 pt-3">
        <div className="grid h-8 grid-cols-[220px_repeat(2,1fr)] border-y border-[#6c5b4d] text-[11px] font-bold text-[#7f321f]">
          <div className="flex items-center px-2">Type</div>
          {ENTITY_ACTIONS.map((action) => (
            <div
              key={action}
              className="flex items-center justify-center border-l border-[#6c5b4d] px-2 text-center"
            >
              {action}
            </div>
          ))}
        </div>

        {CONFIRMED_ENTITY_TYPES.map((entityType) => (
          <div
            key={entityType.id}
            className="grid h-[74px] grid-cols-[220px_repeat(2,1fr)] border-b border-[#6c5b4d]"
          >
            <div className="flex items-center gap-4 px-2">
              <EntityTypeGlyph type={entityType} className="h-10 w-10 text-[#9d3f27]" />
              <span className="text-[21px] font-bold leading-none">{entityType.label}</span>
            </div>
            {ENTITY_ACTIONS.map((action) => {
              const actionKey = `${entityType.id}:${action}`;
              const active = selection === actionKey;

              return (
                <button
                  key={action}
                  type="button"
                  aria-label={`${action} ${entityType.label}`}
                  aria-pressed={active}
                  onClick={() => setSelection(actionKey)}
                  className={`relative border-l border-[#6c5b4d] px-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#9d3f27] ${
                    active
                      ? 'bg-[#9d3f27] text-[#fff8ea]'
                      : 'text-[#6c5b4d] hover:bg-[#e7d9c5] hover:text-[#241c17]'
                  }`}
                >
                  <span
                    className={`text-[18px] font-bold ${active ? 'opacity-100' : 'opacity-45'}`}
                  >
                    {active ? '✓' : '○'}
                  </span>
                  <span className="ml-1 text-[10px] font-bold">{active ? 'Chosen' : 'Select'}</span>
                </button>
              );
            })}
          </div>
        ))}
      </section>

      <section className="mx-6 mt-4 border-t-[5px] border-[#9d3f27]">
        <h3 className="flex h-12 items-end border-b border-[#6c5b4d] pb-2 text-[27px] font-bold tracking-[-0.025em]">
          Project-scale actions
        </h3>
        <div className="grid h-[97px] grid-cols-3">
          {PROJECT_IMPORT_ACTIONS.map((action) => {
            const actionKey = `project:${action}`;
            const active = selection === actionKey;

            return (
              <button
                key={action}
                type="button"
                aria-pressed={active}
                onClick={() => setSelection(actionKey)}
                className={`relative flex items-start gap-3 border-l border-[#6c5b4d] px-3 py-4 text-left first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#9d3f27] ${
                  active ? 'bg-[#9d3f27] text-[#fff8ea]' : 'text-[#241c17] hover:bg-[#e7d9c5]'
                }`}
              >
                <ProjectActionGlyph action={action} className="mt-0.5 h-6 w-6" />
                <span className="text-[16px] font-bold leading-[1.1]">{action}</span>
                {active && (
                  <span
                    className="absolute bottom-2 right-3 text-[18px] font-bold"
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </PrototypeSurface>
  );
}
