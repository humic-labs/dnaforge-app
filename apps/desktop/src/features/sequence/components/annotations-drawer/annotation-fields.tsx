import { MenuRow, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '../../../../components/PortalMenu';
import { Select } from '../../../../components/ui/controls';
import React, { useState, useMemo, useEffect, useRef, useId } from 'react';
import { ANNOTATION_COLOR_PALETTES, type Annotation } from '@waypoint/sequence-utils';
import { ANNOTATION_TYPES } from './helpers';

export function DirectionIndicator({
  direction,
  color,
}: {
  direction: number | undefined;
  color: string;
}) {
  const c = color || '#718096';
  if (direction === 1) {
    return (
      <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
        <line x1="0" y1="4" x2="9" y2="4" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <polyline
          points="7,1 10,4 7,7"
          fill="none"
          stroke={c}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (direction === -1) {
    return (
      <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
        <line x1="3" y1="4" x2="12" y2="4" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <polyline
          points="5,1 2,4 5,7"
          fill="none"
          stroke={c}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
      <rect x="0" y="2.5" width="12" height="3" rx="1.5" fill={c} />
    </svg>
  );
}

export function TypeCombobox({
  value,
  onChange,
  allAnnotations,
}: {
  value: string;
  onChange: (value: string) => void;
  allAnnotations: Annotation[];
}) {
  const [inputValue, setInputValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const suggestions = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ann of allAnnotations) {
      counts[ann.type] = (counts[ann.type] || 0) + 1;
    }
    const allTypes = new Set([...Object.keys(counts), ...ANNOTATION_TYPES.map((t) => t.value)]);
    return [...allTypes].sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  }, [allAnnotations]);

  const filtered = useMemo(() => {
    if (!inputValue) return suggestions;
    const lower = inputValue.toLowerCase();
    return suggestions.filter((t) => t.toLowerCase().includes(lower));
  }, [suggestions, inputValue]);

  const listId = useId();
  const menu = useMenu({
    items: filtered.map((type) => ({ id: type, textValue: type, closeOnActivate: false })),
    selectedId: value,
    onActivate: (type) => {
      menu.close('handoff');
      setInputValue(type);
      onChange(type);
    },
  });

  return (
    <div className="relative">
      <input
        ref={inputRef}
        data-testid="edit-type-input"
        type="text"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(e.target.value);
          if (!menu.isOpen) menu.openMenu();
        }}
        role="combobox"
        aria-expanded={menu.isOpen}
        aria-controls={listId}
        aria-activedescendant={
          menu.activeId === null ? undefined : `${listId}-${encodeURIComponent(menu.activeId)}`
        }
        onKeyDown={menu.handleKeyDown}
        onFocus={() => {
          if (!menu.isOpen) menu.openMenu();
        }}
        onBlur={() => menu.close('outside-pointer')}
        className="w-full px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <PortalMenu
        id={listId}
        open={menu.isOpen && filtered.length > 0}
        menu={menu}
        anchorRef={inputRef}
        onRequestClose={menu.close}
        role="listbox"
        aria-label="Annotation types"
        preferredSide="bottom"
        horizontalAlign="start"
      >
        {filtered.map((type) => (
          <MenuRow
            key={type}
            id={`${listId}-${encodeURIComponent(type)}`}
            role="option"
            aria-selected={type === value}
            selected={type === value}
            active={type === menu.activeId}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => menu.point(type)}
            onClick={() => menu.activate(type)}
          >
            {type}
          </MenuRow>
        ))}
      </PortalMenu>
    </div>
  );
}

export function StrandToggle({
  value,
  onChange,
}: {
  value: 1 | -1 | 0;
  onChange: (v: 1 | -1 | 0) => void;
}) {
  const green = '#4CAF50';
  const muted = '#718096';
  const options: { val: 1 | -1 | 0; title: string; icon: React.ReactNode }[] = [
    {
      val: -1,
      title: 'Reverse (-)',
      icon: (
        <svg width="14" height="10" viewBox="0 0 12 8">
          <line
            x1="3"
            y1="4"
            x2="12"
            y2="4"
            stroke={value === -1 ? green : muted}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <polyline
            points="5,1 2,4 5,7"
            fill="none"
            stroke={value === -1 ? green : muted}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ),
    },
    {
      val: 0,
      title: 'None',
      icon: (
        <svg width="14" height="10" viewBox="0 0 12 8">
          <rect x="0" y="2.5" width="12" height="3" rx="1.5" fill={value === 0 ? green : muted} />
        </svg>
      ),
    },
    {
      val: 1,
      title: 'Forward (+)',
      icon: (
        <svg width="14" height="10" viewBox="0 0 12 8">
          <line
            x1="0"
            y1="4"
            x2="9"
            y2="4"
            stroke={value === 1 ? green : muted}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <polyline
            points="7,1 10,4 7,7"
            fill="none"
            stroke={value === 1 ? green : muted}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ),
    },
  ];

  return (
    <div className="inline-flex gap-0.5 h-[30px] items-center">
      {options.map(({ val, title, icon }) => (
        <button
          key={val}
          title={title}
          onClick={() => onChange(val)}
          className={`px-2 py-1 rounded ${value === val ? 'bg-green-500/15' : 'wp-interactive'}`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

export function ColorPaletteSelector({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (color: string) => void;
  compact?: boolean;
}) {
  const activePalette = ANNOTATION_COLOR_PALETTES.find((palette) => palette.colors.includes(value));
  const [selectedPalette, setSelectedPalette] = useState(
    activePalette?.name ?? ANNOTATION_COLOR_PALETTES[0].name
  );
  const palette =
    ANNOTATION_COLOR_PALETTES.find((entry) => entry.name === selectedPalette) ??
    ANNOTATION_COLOR_PALETTES[0];

  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-0.5">
        <span className="text-xs text-fg-muted">Color</span>
        <Select
          value={palette.name}
          ariaLabel="Annotation color palette"
          onValueChange={setSelectedPalette}
          options={ANNOTATION_COLOR_PALETTES.map((entry) => ({
            value: entry.name,
            selectedLabel: entry.name,
            searchText: entry.name,
            label: (
              <span className="flex items-center gap-1.5">
                <span className="flex gap-0.5">
                  {entry.colors.slice(0, 4).map((color) => (
                    <span
                      key={color}
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
                {entry.name}
              </span>
            ),
          }))}
        />
      </div>
      <div className={`flex gap-1 ${compact ? 'flex-nowrap' : 'flex-wrap'}`}>
        {palette.colors.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={`${compact ? 'w-3.5 h-3.5' : 'w-5 h-5'} rounded shrink-0`}
            style={{
              backgroundColor: c,
              border: value === c ? '2px solid hsl(var(--color-fg))' : '2px solid transparent',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function RangeFields({
  idPrefix,
  start,
  end,
  onStartChange,
  onEndChange,
  trailing,
}: {
  idPrefix: 'add' | 'edit';
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  trailing?: React.ReactNode;
}) {
  const inputClass =
    'w-full mt-0.5 px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent';
  return (
    <div>
      <div className="flex gap-2 items-end">
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Start</span>
          <input
            data-testid={`${idPrefix}-start-input`}
            type="number"
            min={1}
            value={start}
            onChange={(e) => onStartChange(e.target.value)}
            placeholder="1"
            className={inputClass}
          />
        </label>
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">End</span>
          <input
            data-testid={`${idPrefix}-end-input`}
            type="number"
            min={1}
            value={end}
            onChange={(e) => onEndChange(e.target.value)}
            placeholder="100"
            className={inputClass}
          />
        </label>
      </div>
      {trailing}
    </div>
  );
}
