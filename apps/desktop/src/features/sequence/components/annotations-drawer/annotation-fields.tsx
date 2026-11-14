import { usePresentationListener } from '../../../../presentation/PresentationSurface';
import React, { useState, useMemo, useEffect, useRef } from 'react';
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
  const [open, setOpen] = useState(false);
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
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
        }}
        className="w-full px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-bg border border-border rounded shadow-lg z-20 max-h-[200px] overflow-y-auto">
          {filtered.map((type) => (
            <button
              key={type}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setInputValue(type);
                onChange(type);
                setOpen(false);
                inputRef.current?.blur();
              }}
              className={`w-full text-left px-2 py-1 text-xs hover:bg-bg-subtle ${
                type === value ? 'text-accent font-medium' : 'text-fg'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}
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
          className={`px-2 py-1 rounded ${
            value === val ? 'bg-green-500/15' : 'hover:bg-bg-subtle'
          }`}
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
  const presentationEvents = usePresentationListener();

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const activePaletteIndex = ANNOTATION_COLOR_PALETTES.findIndex((p) => p.colors.includes(value));
  const [selectedPalette, setSelectedPalette] = useState(
    activePaletteIndex >= 0 ? activePaletteIndex : 0
  );
  const palette = ANNOTATION_COLOR_PALETTES[selectedPalette];

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    presentationEvents.add(document, 'keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      presentationEvents.remove(document, 'keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [open, presentationEvents]);

  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-0.5">
        <span className="text-xs text-fg-muted">Color</span>
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[10px] text-fg-muted/60 hover:text-fg-muted px-1 py-0.5 rounded hover:bg-bg-muted cursor-pointer"
          >
            {palette.name}
            <svg
              width="8"
              height="8"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="inline-block ml-0.5 -mt-px"
            >
              <path d="M3 4.5l3 3 3-3" />
            </svg>
          </button>
          {open && (
            <div className="absolute top-full left-0 mt-1 bg-bg border border-border rounded shadow-lg z-20 min-w-[100px]">
              {ANNOTATION_COLOR_PALETTES.map((p, i) => (
                <button
                  key={p.name}
                  onClick={() => {
                    setSelectedPalette(i);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1 text-xs hover:bg-bg-subtle flex items-center gap-1.5 ${
                    i === selectedPalette ? 'text-accent font-medium' : 'text-fg'
                  }`}
                >
                  <span className="flex gap-0.5">
                    {p.colors.slice(0, 4).map((c) => (
                      <span
                        key={c}
                        className="w-2 h-2 rounded-full inline-block"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
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
