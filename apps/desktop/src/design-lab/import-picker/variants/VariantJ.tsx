import { useState } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type EntityAction,
} from '../model';
import { ClosePickerButton, EntityTypeGlyph, ProjectActionGlyph, SelectionNotice } from '../shared';

export function VariantJ({ onRequestClose }: { onRequestClose: () => void }) {
  const [selection, setSelection] = useState('');

  const chooseEntityAction = (entityType: string, action: EntityAction) => {
    setSelection(`${action} · ${entityType}`);
  };

  return (
    <section
      role="dialog"
      aria-label="Project command dock"
      className="absolute left-[264px] top-[37px] z-20 w-[890px] border-y-4 border-[#2a172b] bg-[#fff7ed] text-[#2a172b] shadow-2xl"
      style={{ fontFamily: 'Helvetica Neue, Helvetica, Arial, sans-serif' }}
    >
      <div className="flex h-12 items-center justify-between border-b border-[#2a172b]/25 px-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[17px] font-bold tracking-[-0.02em]">Add to project</span>
        </div>
        <ClosePickerButton onClick={onRequestClose} />
      </div>

      <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_250px]">
        {CONFIRMED_ENTITY_TYPES.map((entityType, index) => (
          <section
            key={entityType.id}
            className={`min-h-[285px] px-4 py-5 ${index > 0 ? 'border-l border-[#2a172b]/25' : ''}`}
          >
            <div className="mb-6 flex items-end justify-between">
              <EntityTypeGlyph type={entityType} className="h-12 w-12" />
              <span className="font-mono text-[10px] text-[#8a6179]">0{index + 1}</span>
            </div>
            <h2 className="mb-5 min-h-12 text-[20px] font-bold leading-tight tracking-[-0.03em]">
              {entityType.label}
            </h2>
            <div className="border-t-2 border-[#2a172b]">
              {ENTITY_ACTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  aria-pressed={selection === `${action} · ${entityType.label}`}
                  onClick={() => chooseEntityAction(entityType.label, action)}
                  className="flex h-10 w-full items-center justify-between border-b border-[#2a172b]/25 text-left text-[12px] font-semibold transition-colors hover:bg-[#2a172b] hover:px-2 hover:text-[#fff7ed] focus-visible:bg-[#2a172b] focus-visible:px-2 focus-visible:text-[#fff7ed] focus-visible:outline-none"
                >
                  <span>{action}</span>
                  <span aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        <aside className="min-h-[285px] border-l-4 border-[#2a172b] bg-[#f3b33d] p-4">
          <h2 className="mb-5 text-[21px] font-bold leading-[1.05] tracking-[-0.04em]">
            Project-scale actions
          </h2>
          <div className="border-t-2 border-[#2a172b]">
            {PROJECT_IMPORT_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => setSelection(action)}
                className="flex min-h-14 w-full items-center gap-3 border-b border-[#2a172b]/35 text-left text-[12px] font-bold hover:bg-[#2a172b] hover:px-2 hover:text-[#f3b33d] focus-visible:bg-[#2a172b] focus-visible:px-2 focus-visible:text-[#f3b33d] focus-visible:outline-none"
              >
                <ProjectActionGlyph action={action} className="h-5 w-5" />
                <span className="flex-1">{action}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
      <SelectionNotice className="flex h-9 items-center border-t border-[#2a172b]/25 px-4 text-[11px] font-medium text-[#7d5b71]">
        {selection || 'Choose a command'}
      </SelectionNotice>
    </section>
  );
}
