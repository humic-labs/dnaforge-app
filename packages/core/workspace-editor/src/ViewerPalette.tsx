import React, { useState, useRef, useEffect } from 'react';

export interface ViewerPaletteOptions {
  showAnnotations: boolean;
  showTranslation: boolean;
  showReverseComplement: boolean;
  showCutSites?: boolean;
  showPrimers?: boolean;
  showResidueNumbers?: boolean;
  zoomLevel?: number;
  translationMode?: 'expanded' | 'compact';
}

interface ViewerPaletteProps {
  options: ViewerPaletteOptions;
  onChange: (options: ViewerPaletteOptions) => void;
  className?: string;
  style?: React.CSSProperties;
}

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200];
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;

const GearIcon: React.FC<{ size?: number; style?: React.CSSProperties }> = ({
  size = 20,
  style,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const ZoomControl: React.FC<{
  value: number;
  onChange: (value: number) => void;
}> = ({ value, onChange }) => {
  const handleDecrease = () => {
    const newValue = Math.max(MIN_ZOOM, value - 25);
    onChange(newValue);
  };

  const handleIncrease = () => {
    const newValue = Math.min(MAX_ZOOM, value + 25);
    onChange(newValue);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <span
        style={{
          fontSize: '12px',
          color: 'hsl(var(--color-fg))',
          minWidth: '32px',
        }}
      >
        Zoom
      </span>
      <button
        onClick={handleDecrease}
        disabled={value <= MIN_ZOOM}
        style={{
          width: '24px',
          height: '24px',
          border: '1px solid hsl(var(--color-border))',
          borderRadius: '4px',
          backgroundColor:
            value <= MIN_ZOOM ? 'hsl(var(--color-bg-muted))' : 'hsl(var(--color-bg))',
          cursor: value <= MIN_ZOOM ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 'bold',
          color: value <= MIN_ZOOM ? 'hsl(var(--color-fg-subtle))' : 'hsl(var(--color-fg))',
        }}
        title="Zoom out"
      >
        −
      </button>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          padding: '4px 8px',
          border: '1px solid hsl(var(--color-border))',
          borderRadius: '4px',
          backgroundColor: 'hsl(var(--color-bg))',
          fontSize: '12px',
          cursor: 'pointer',
          minWidth: '60px',
        }}
      >
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {preset}%
          </option>
        ))}
        {}
        {!ZOOM_PRESETS.includes(value) && <option value={value}>{value}%</option>}
      </select>
      <button
        onClick={handleIncrease}
        disabled={value >= MAX_ZOOM}
        style={{
          width: '24px',
          height: '24px',
          border: '1px solid hsl(var(--color-border))',
          borderRadius: '4px',
          backgroundColor:
            value >= MAX_ZOOM ? 'hsl(var(--color-bg-muted))' : 'hsl(var(--color-bg))',
          cursor: value >= MAX_ZOOM ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 'bold',
          color: value >= MAX_ZOOM ? 'hsl(var(--color-fg-subtle))' : 'hsl(var(--color-fg))',
        }}
        title="Zoom in"
      >
        +
      </button>
    </div>
  );
};

const Toggle: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ label, checked, onChange }) => {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        userSelect: 'none',
        fontSize: '12px',
        color: 'hsl(var(--color-fg))',
      }}
    >
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: '32px',
          minWidth: '32px',
          height: '18px',
          borderRadius: '9px',
          backgroundColor: checked ? '#4285f4' : 'hsl(var(--color-border))',
          position: 'relative',
          transition: 'background-color 0.2s',
          cursor: 'pointer',
          flexShrink: 0,
          transform: 'translateZ(0)',
          isolation: 'isolate' as const,
        }}
      >
        <div
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            backgroundColor: '#fff',
            position: 'absolute',
            top: '2px',
            left: '2px',
            transform: checked ? 'translate3d(14px, 0, 0)' : 'translate3d(0, 0, 0)',
            transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            willChange: 'transform',
            backfaceVisibility: 'hidden' as const,
          }}
        />
      </div>
      <span>{label}</span>
    </label>
  );
};

const TranslationModeSelector: React.FC<{
  value: 'expanded' | 'compact';
  onChange: (value: 'expanded' | 'compact') => void;
}> = ({ value, onChange }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', color: 'hsl(var(--color-fg))', fontWeight: 500 }}>
        Amino Acid Tracks
      </span>
      <div style={{ display: 'flex', gap: '4px' }}>
        <button
          onClick={() => onChange('expanded')}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontSize: '11px',
            fontWeight: 500,
            border: '1px solid',
            borderColor: value === 'expanded' ? '#1976d2' : 'hsl(var(--color-border))',
            borderRadius: '4px',
            backgroundColor: value === 'expanded' ? '#e3f2fd' : 'hsl(var(--color-bg))',
            color: value === 'expanded' ? '#1976d2' : 'hsl(var(--color-fg-muted))',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          title="Each CDS annotation gets its own separate amino acid track"
        >
          Expanded
        </button>
        <button
          onClick={() => onChange('compact')}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontSize: '11px',
            fontWeight: 500,
            border: '1px solid',
            borderColor: value === 'compact' ? '#9c27b0' : 'hsl(var(--color-border))',
            borderRadius: '4px',
            backgroundColor: value === 'compact' ? '#f3e5f5' : 'hsl(var(--color-bg))',
            color: value === 'compact' ? '#9c27b0' : 'hsl(var(--color-fg-muted))',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          title="In-frame CDS annotations share a single amino acid track"
        >
          Smart Compact
        </button>
      </div>
      <span style={{ fontSize: '10px', color: 'hsl(var(--color-fg-subtle))', lineHeight: 1.3 }}>
        {value === 'expanded' ? 'Each CDS has its own AA track' : 'In-frame CDSs share AA tracks'}
      </span>
    </div>
  );
};

export const ViewerPalette: React.FC<ViewerPaletteProps> = ({
  options,
  onChange,
  className,
  style,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleToggle = (key: keyof ViewerPaletteOptions) => (checked: boolean) => {
    onChange({ ...options, [key]: checked });
  };

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        ...style,
      }}
    >
      {}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          border: '1px solid hsl(var(--color-border))',
          borderRadius: '6px',
          backgroundColor: isOpen ? 'hsl(var(--color-bg-muted))' : 'hsl(var(--color-bg))',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        title="Display Settings"
      >
        <GearIcon
          size={18}
          style={{
            color: isOpen ? '#1976d2' : 'hsl(var(--color-fg-muted))',
            transition: 'color 0.15s ease',
          }}
        />
      </button>

      {}
      {isOpen && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '4px',
            minWidth: '240px',
            backgroundColor: 'hsl(var(--color-bg))',
            borderRadius: '8px',
            border: '1px solid hsl(var(--color-border))',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {}
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid hsl(var(--color-border))',
              backgroundColor: 'hsl(var(--color-bg-subtle))',
            }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'hsl(var(--color-fg))',
              }}
            >
              Display Settings
            </span>
          </div>

          {}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '12px 14px',
            }}
          >
            <Toggle
              label="Annotations"
              checked={options.showAnnotations}
              onChange={handleToggle('showAnnotations')}
            />
            <Toggle
              label="Translation (CDS)"
              checked={options.showTranslation}
              onChange={handleToggle('showTranslation')}
            />
            <Toggle
              label="Complement Strand"
              checked={options.showReverseComplement}
              onChange={handleToggle('showReverseComplement')}
            />
            {options.showCutSites !== undefined && (
              <Toggle
                label="Cut Sites"
                checked={options.showCutSites}
                onChange={handleToggle('showCutSites')}
              />
            )}
            {options.showPrimers !== undefined && (
              <Toggle
                label="Primers"
                checked={options.showPrimers}
                onChange={handleToggle('showPrimers')}
              />
            )}

            {}
            {options.showTranslation && options.showResidueNumbers !== undefined && (
              <div style={{ paddingLeft: '12px' }}>
                <Toggle
                  label="Residue Numbers"
                  checked={!!options.showResidueNumbers}
                  onChange={handleToggle('showResidueNumbers')}
                />
              </div>
            )}

            {}
            {options.showTranslation && options.translationMode !== undefined && (
              <>
                <div
                  style={{
                    height: '1px',
                    backgroundColor: 'hsl(var(--color-border))',
                    margin: '4px 0',
                  }}
                />
                <TranslationModeSelector
                  value={options.translationMode}
                  onChange={(value) => onChange({ ...options, translationMode: value })}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const ZoomControlStandalone: React.FC<{
  value: number;
  onChange: (value: number) => void;
}> = ({ value, onChange }) => {
  return <ZoomControl value={value} onChange={onChange} />;
};
