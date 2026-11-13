import { useEffect, useMemo, useState } from 'react';
import type { ImportPickerVariantDefinition } from './model';
import { ImportPickerPrototypeFrame } from './shared';
import { VariantA } from './variants/VariantA';
import { VariantB } from './variants/VariantB';
import { VariantC } from './variants/VariantC';
import { VariantD } from './variants/VariantD';
import { VariantE } from './variants/VariantE';
import { VariantF } from './variants/VariantF';
import { VariantG } from './variants/VariantG';
import { VariantH } from './variants/VariantH';
import { VariantI } from './variants/VariantI';
import { VariantJ } from './variants/VariantJ';

const VARIANTS: readonly ImportPickerVariantDefinition[] = [
  {
    id: 'A',
    name: 'Radial bloom',
    description: 'Type choices branch spatially from Add.',
    component: VariantA,
  },
  {
    id: 'B',
    name: 'Editorial ledger',
    description: 'A ruled, typographic index of types and actions.',
    component: VariantB,
  },
  {
    id: 'C',
    name: 'Split workbench',
    description: 'A type rail drives a focused action bench.',
    component: VariantC,
  },
  {
    id: 'D',
    name: 'Command deck',
    description: 'Search and keyboard commands drive the picker.',
    component: VariantD,
  },
  {
    id: 'E',
    name: 'Action stripes',
    description: 'Create and Import become the dominant structure.',
    component: VariantE,
  },
  {
    id: 'F',
    name: 'Inline tree',
    description: 'Add becomes a temporary branch in the Explorer.',
    component: VariantF,
  },
  {
    id: 'G',
    name: 'Conveyor',
    description: 'Type, action, and confirmation move left to right.',
    component: VariantG,
  },
  {
    id: 'H',
    name: 'Instrument dial',
    description: 'A spatial selector centers one biological type.',
    component: VariantH,
  },
  {
    id: 'I',
    name: 'Native cascades',
    description: 'Familiar nested menus keep every level compact.',
    component: VariantI,
  },
  {
    id: 'J',
    name: 'Command dock',
    description: 'A wide project shelf keeps every path visible.',
    component: VariantJ,
  },
];

function variantFromUrl(): string {
  return new URLSearchParams(window.location.search).get('variant')?.toUpperCase() ?? 'A';
}

export function ImportPickerComparisonPage() {
  const [activeId, setActiveId] = useState(variantFromUrl);
  const active = useMemo(
    () => VARIANTS.find((variant) => variant.id === activeId) ?? VARIANTS[0],
    [activeId]
  );
  const ActiveVariant = active.component;

  useEffect(() => {
    document.title = `Import picker ${active.id} · DNAForge`;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', active.id);
    window.history.replaceState(null, '', url);
  }, [active.id]);

  return (
    <div className="min-h-screen bg-bg p-5 text-fg" data-testid="import-picker-comparison">
      <header className="mx-auto mb-4 flex max-w-[1180px] items-start justify-between gap-6">
        <div className="pt-1">
          <h1 className="text-lg font-semibold">Import picker</h1>
          <p className="mt-0.5 text-xs text-fg-muted">
            {active.id}. {active.name} · {active.description}
          </p>
        </div>
        <nav
          className="grid w-[720px] grid-cols-5 border border-border bg-bg"
          aria-label="Picker variants"
        >
          {VARIANTS.map((variant) => (
            <button
              key={variant.id}
              type="button"
              aria-label={variant.id}
              aria-current={variant.id === active.id ? 'page' : undefined}
              title={`${variant.id}. ${variant.name}`}
              onClick={() => setActiveId(variant.id)}
              className={`flex h-11 items-center gap-2 border-b border-l border-border px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                variant.id === active.id
                  ? 'bg-fg text-bg'
                  : 'bg-bg text-fg-muted hover:bg-bg-muted hover:text-fg'
              }`}
            >
              <span className="text-[10px] font-bold">{variant.id}</span>
              <span className="text-[11px] font-medium leading-tight">{variant.name}</span>
            </button>
          ))}
        </nav>
      </header>
      <div className="mx-auto max-w-[1180px]">
        <ImportPickerPrototypeFrame>
          {({ onRequestClose }) => <ActiveVariant onRequestClose={onRequestClose} />}
        </ImportPickerPrototypeFrame>
      </div>
    </div>
  );
}
