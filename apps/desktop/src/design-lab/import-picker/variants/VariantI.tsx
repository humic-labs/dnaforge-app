import { useState } from 'react';
import { CONFIRMED_ENTITY_TYPES, PROJECT_IMPORT_ACTIONS, type ConfirmedEntityType } from '../model';
import { ClosePickerButton, EntityTypeGlyph, ProjectActionGlyph, SelectionNotice } from '../shared';

const MENU_ITEM =
  'flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-[13px] outline-none hover:bg-[#1769ff] hover:text-white focus-visible:bg-[#1769ff] focus-visible:text-white';

export function VariantI({ onRequestClose }: { onRequestClose: () => void }) {
  const [selectedType, setSelectedType] = useState<ConfirmedEntityType>(CONFIRMED_ENTITY_TYPES[0]);
  const [selection, setSelection] = useState(`Import · ${CONFIRMED_ENTITY_TYPES[0].label}`);

  const chooseType = (entityType: ConfirmedEntityType) => {
    setSelectedType(entityType);
    setSelection(`Import · ${entityType.label}`);
  };

  return (
    <section
      role="dialog"
      aria-label="Native cascade add picker"
      className="absolute left-[264px] top-[47px] z-20 flex items-start gap-1 text-[#202124]"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}
    >
      <div className="w-[270px] border border-black/20 bg-white/95 p-1 shadow-2xl backdrop-blur-xl">
        <div className="flex h-9 items-center justify-between border-b border-black/10 px-2">
          <span className="text-[13px] font-semibold">Add</span>
          <ClosePickerButton onClick={onRequestClose} />
        </div>
        <div className="py-1">
          {CONFIRMED_ENTITY_TYPES.map((entityType) => (
            <button
              key={entityType.id}
              type="button"
              aria-pressed={selectedType.id === entityType.id}
              onClick={() => chooseType(entityType)}
              className={`${MENU_ITEM} ${
                selectedType.id === entityType.id ? 'bg-[#1769ff] text-white' : ''
              }`}
            >
              <EntityTypeGlyph type={entityType} className="h-[18px] w-[18px]" />
              <span className="min-w-0 flex-1 truncate">{entityType.label}</span>
              <span aria-hidden="true" className="text-[11px] opacity-65">
                ›
              </span>
            </button>
          ))}
        </div>
        <div className="my-1 border-t border-black/15" />
        <div className="px-2 pb-1 pt-1.5 text-[13px] font-bold">Project-scale actions</div>
        {PROJECT_IMPORT_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => setSelection(action)}
            className={MENU_ITEM}
          >
            <ProjectActionGlyph action={action} className="h-4 w-4" />
            <span className="min-w-0 flex-1 truncate">{action}</span>
          </button>
        ))}
      </div>

      <div className="mt-8 w-[220px] border border-black/20 bg-white/95 p-1 shadow-2xl backdrop-blur-xl">
        <div className="flex h-10 items-center gap-2 border-b border-black/10 px-2 text-[13px] font-semibold">
          <EntityTypeGlyph type={selectedType} className="h-[18px] w-[18px]" />
          {selectedType.label}
        </div>
        <div className="py-1">
          <button
            type="button"
            onClick={() => {
              setSelection(`Create · ${selectedType.label}`);
            }}
            aria-pressed={selection === `Create · ${selectedType.label}`}
            className={MENU_ITEM}
          >
            <span className="w-4 text-center text-base">＋</span>
            <span className="flex-1">Create</span>
          </button>
          <button
            type="button"
            aria-pressed={selection === `Import · ${selectedType.label}`}
            onClick={() => setSelection(`Import · ${selectedType.label}`)}
            className={`${MENU_ITEM} ${
              selection === `Import · ${selectedType.label}` ? 'bg-[#1769ff] text-white' : ''
            }`}
          >
            <span className="w-4 text-center text-base">↓</span>
            <span className="flex-1">Import</span>
          </button>
          <SelectionNotice className="mt-1 border-t border-black/10 px-2 py-2 text-[11px] text-black/55">
            {selection}
          </SelectionNotice>
        </div>
      </div>
    </section>
  );
}
