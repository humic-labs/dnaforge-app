import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ConfirmedEntityTypeId,
  type ImportPickerVariantProps,
} from '../model';
import {
  ClosePickerButton,
  EntityTypeGlyph,
  PANEL_CLASS,
  ProjectActionGlyph,
  PrototypeSurface,
} from '../shared';

const NODE_GEOMETRY: Record<
  ConfirmedEntityTypeId,
  { buttonClass: string; centerX: number; centerY: number }
> = {
  'dna-sequences': { buttonClass: 'left-[44px] top-[54px]', centerX: 104, centerY: 114 },
  primers: { buttonClass: 'left-[240px] top-[16px]', centerX: 300, centerY: 76 },
  strains: { buttonClass: 'right-[44px] top-[54px]', centerX: 496, centerY: 114 },
};

export function VariantA({ onRequestClose }: ImportPickerVariantProps) {
  const [selectedTypeId, setSelectedTypeId] = useState<ConfirmedEntityTypeId>('dna-sequences');
  const [selection, setSelection] = useState<string | null>(null);
  const selectedType =
    CONFIRMED_ENTITY_TYPES.find((entityType) => entityType.id === selectedTypeId) ??
    CONFIRMED_ENTITY_TYPES[0];

  return (
    <PrototypeSurface
      label="Radial Add picker"
      className={`${PANEL_CLASS} h-[520px] w-[600px] overflow-hidden !border-[#1d4938] !bg-[#07130f] font-['Trebuchet_MS',Arial,sans-serif] text-[#e8fff5]`}
    >
      <header className="flex h-16 items-center justify-between border-b border-[#1d4938] px-6">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-[#6ee7b7] shadow-[0_0_18px_rgba(110,231,183,0.8)]" />
          <h2 className="text-2xl font-semibold tracking-tight">Add</h2>
        </div>
        <ClosePickerButton onClick={onRequestClose} className="text-[#b7dcca]" />
      </header>

      <div className="relative h-[316px] overflow-hidden" aria-label="Entity type orbit">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 600 316"
        >
          <circle cx="300" cy="190" r="108" fill="none" stroke="#123a2b" strokeWidth="1" />
          {CONFIRMED_ENTITY_TYPES.map((entityType) => {
            const geometry = NODE_GEOMETRY[entityType.id];
            const active = selectedTypeId === entityType.id;

            return (
              <line
                key={entityType.id}
                x1="300"
                y1="190"
                x2={geometry.centerX}
                y2={geometry.centerY}
                stroke={active ? '#6ee7b7' : '#245a46'}
                strokeWidth={active ? '3' : '1.5'}
              />
            );
          })}
        </svg>

        {CONFIRMED_ENTITY_TYPES.map((entityType) => {
          const active = selectedTypeId === entityType.id;
          const geometry = NODE_GEOMETRY[entityType.id];

          return (
            <button
              key={entityType.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setSelectedTypeId(entityType.id);
                setSelection(null);
              }}
              className={`absolute z-10 flex h-[120px] w-[120px] flex-col items-center justify-center gap-2 rounded-full border text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a7f3d0] ${geometry.buttonClass} ${
                active
                  ? 'border-[#6ee7b7] bg-[#123a2b] text-white shadow-[0_0_28px_rgba(52,211,153,0.28)]'
                  : 'border-[#2c624d] bg-[#0b2018] text-[#b7dcca] hover:border-[#6ee7b7] hover:text-white'
              }`}
            >
              <EntityTypeGlyph type={entityType} className="h-9 w-9" />
              <span className="max-w-[94px] text-sm font-semibold leading-tight">
                {entityType.label}
              </span>
            </button>
          );
        })}

        <div className="absolute left-1/2 top-[150px] z-10 flex h-20 w-20 -translate-x-1/2 items-center justify-center rounded-full border-2 border-[#6ee7b7] bg-[#0e2d21] text-xs font-bold tracking-[0.14em] text-[#a7f3d0]">
          TYPE
        </div>

        <div className="absolute inset-x-8 bottom-2 z-20 grid h-[66px] grid-cols-[154px_repeat(2,1fr)] border-y border-[#2c624d] bg-[#091a14]/95">
          <div className="flex items-center gap-2 px-3 text-sm font-semibold text-[#a7f3d0]">
            <EntityTypeGlyph type={selectedType} className="h-6 w-6" />
            <span>{selectedType.label}</span>
          </div>
          {ENTITY_ACTIONS.map((action) => {
            const actionKey = `${selectedType.id}:${action}`;
            const active = selection === actionKey;

            return (
              <button
                key={action}
                type="button"
                aria-pressed={active}
                onClick={() => setSelection(actionKey)}
                className={`border-l border-[#2c624d] px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a7f3d0] ${
                  active ? 'bg-[#6ee7b7] text-[#07130f]' : 'text-[#d5f5e6] hover:bg-[#123a2b]'
                }`}
              >
                {action}
              </button>
            );
          })}
        </div>
      </div>

      <section className="h-[140px] border-t-2 border-[#6ee7b7] bg-[#0b2018]">
        <h3 className="flex h-10 items-center px-5 text-base font-semibold text-white">
          Project-scale actions
        </h3>
        <div className="grid h-[98px] grid-cols-3 border-t border-[#2c624d]">
          {PROJECT_IMPORT_ACTIONS.map((action) => {
            const actionKey = `project:${action}`;
            const active = selection === actionKey;

            return (
              <button
                key={action}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelection(actionKey);
                }}
                className={`flex flex-col items-start justify-center gap-2 border-l border-[#2c624d] px-4 text-left first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a7f3d0] ${
                  active ? 'bg-[#6ee7b7] text-[#07130f]' : 'text-[#d5f5e6] hover:bg-[#123a2b]'
                }`}
              >
                <ProjectActionGlyph action={action} className="h-5 w-5" />
                <span className="text-sm font-semibold leading-tight">{action}</span>
              </button>
            );
          })}
        </div>
      </section>
    </PrototypeSurface>
  );
}
