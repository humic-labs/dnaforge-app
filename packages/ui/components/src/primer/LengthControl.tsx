'use client';

import { INTERACTION_CLASS } from '../menu/appearance';

import React from 'react';
import { StepperTriangle } from './StepperTriangle';

export interface LengthControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  colorClass: string;
  onChange: (newValue: number) => void;
  hideLabel?: boolean;
  showSign?: boolean;
  size?: 'sm' | 'md';
}

export function LengthControl({
  label,
  value,
  min,
  max,
  colorClass,
  onChange,
  hideLabel = false,
  showSign = false,
  size = 'sm',
}: LengthControlProps) {
  const md = size === 'md';
  const boxHeight = md ? 'h-7' : 'h-5';
  const inputWidth = md ? (showSign ? 'w-9' : 'w-8') : showSign ? 'w-7' : 'w-5';
  const inputText = md ? 'text-sm' : 'text-xs';
  const formatValue = (v: number) => {
    if (showSign && v > 0) return `+${v}`;
    return v.toString();
  };

  const [localValue, setLocalValue] = React.useState<string>(formatValue(value));
  const [isFocused, setIsFocused] = React.useState(false);

  React.useEffect(() => {
    if (!isFocused) {
      setLocalValue(formatValue(value));
    }
  }, [value, isFocused, showSign]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '' || raw === '-' || raw === '+' || /^[+-]?\d+$/.test(raw)) {
      setLocalValue(raw);
      if (raw !== '' && raw !== '-' && raw !== '+') {
        const parsed = parseInt(raw, 10);
        onChange(Math.max(min, Math.min(max, parsed)));
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (localValue === '' || localValue === '-' || localValue === '+') {
      const defaultVal = min <= 0 && max >= 0 ? 0 : min;
      onChange(defaultVal);
      setLocalValue(formatValue(defaultVal));
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      const newVal = Math.min(max, value + 1);
      onChange(newVal);
      setLocalValue(formatValue(newVal));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const newVal = Math.max(min, value - 1);
      onChange(newVal);
      setLocalValue(formatValue(newVal));
    }
  };

  const increment = () => {
    const newVal = Math.min(max, value + 1);
    onChange(newVal);
    setLocalValue(formatValue(newVal));
  };

  const decrement = () => {
    const newVal = Math.max(min, value - 1);
    onChange(newVal);
    setLocalValue(formatValue(newVal));
  };

  return (
    <div className="flex items-center gap-1">
      {!hideLabel && <span className="text-fg-muted text-xs">{label}:</span>}
      <div
        className={`group flex items-center ${boxHeight} bg-bg border border-border rounded-md overflow-hidden focus-within:ring-1 focus-within:ring-accent`}
      >
        <input
          type="text"
          value={localValue}
          placeholder="0"
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={`${inputWidth} h-full text-center font-mono ${inputText} ${localValue === '' ? 'text-fg-muted' : colorClass} bg-transparent border-none focus:outline-none placeholder:text-fg-muted/60`}
        />
        <div className="flex flex-col h-full opacity-30 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              increment();
            }}
            disabled={value >= max}
            className={`${INTERACTION_CLASS} flex-1 px-0.5 flex items-center justify-center text-fg-muted disabled:opacity-20`}
            tabIndex={-1}
          >
            <StepperTriangle direction="up" className="w-2 h-1.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              decrement();
            }}
            disabled={value <= min}
            className={`${INTERACTION_CLASS} flex-1 px-0.5 flex items-center justify-center text-fg-muted disabled:opacity-20`}
            tabIndex={-1}
          >
            <StepperTriangle direction="down" className="w-2 h-1.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
