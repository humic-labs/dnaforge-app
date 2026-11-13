import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useState, useCallback, useRef } from 'react';
import type { ParsedPlasmid, PlasmidFeature, PlasmidMapOptions } from '../types';
import { DEFAULT_MAP_OPTIONS } from '../types';
import { parseGenBank, isGenBankFormat } from '../parsers/genbank';
import { PlasmidMap } from './PlasmidMap';
function DnaHelixIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 15c6.667-6 13.333 0 20-6" />
      <path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993" />
      <path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993" />
      <path d="M17 6l-2.5-2.5" />
      <path d="M14 8l-3-3" />
      <path d="M7 18l2.5 2.5" />
      <path d="M10 16l3 3" />
    </svg>
  );
}

export interface PlasmidViewerProps {
  initialPlasmid?: ParsedPlasmid | null;
  options?: Partial<PlasmidMapOptions>;
  onPlasmidLoad?: (plasmid: ParsedPlasmid) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function PlasmidViewer({
  initialPlasmid = null,
  options: partialOptions,
  onPlasmidLoad,
  onError,
  className,
  style,
}: PlasmidViewerProps): JSX.Element {
  const [plasmid, setPlasmid] = useState<ParsedPlasmid | null>(initialPlasmid);
  const [selectedFeature, setSelectedFeature] = useState<PlasmidFeature | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const options: PlasmidMapOptions = { ...DEFAULT_MAP_OPTIONS, ...partialOptions };

  const handleParse = useCallback(
    (content: string, _source: string) => {
      try {
        if (!isGenBankFormat(content)) {
          throw new Error('Invalid GenBank format. File should start with LOCUS.');
        }
        const parsed = parseGenBank(content);
        setPlasmid(parsed);
        setSelectedFeature(null);
        setError(null);
        setInputText('');
        onPlasmidLoad?.(parsed);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to parse GenBank file';
        setError(toUserMessage(err, 'sequence.parseFailed'));
        onError?.(err instanceof Error ? err : new Error(message));
      }
    },
    [onPlasmidLoad, onError]
  );

  const handleFileUpload = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        handleParse(content, file.name);
      };
      reader.onerror = () => {
        setError(userMessage('failure.failed-to-read-file'));
      };
      reader.readAsText(file);
    },
    [handleParse]
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileUpload(file);
      }
    },
    [handleFileUpload]
  );

  const handlePasteSubmit = useCallback(() => {
    if (inputText.trim()) {
      handleParse(inputText, 'Pasted content');
    }
  }, [inputText, handleParse]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileUpload(file);
      }
    },
    [handleFileUpload]
  );

  const handleExportSVG = useCallback(() => {
    const svgElement = svgContainerRef.current?.querySelector('svg');
    if (!svgElement || !plasmid) return;

    const svgString = new XMLSerializer().serializeToString(svgElement);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${plasmid.name}_map.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [plasmid]);

  const handleExportPNG = useCallback(() => {
    const svgElement = svgContainerRef.current?.querySelector('svg');
    if (!svgElement || !plasmid) return;

    const svgString = new XMLSerializer().serializeToString(svgElement);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = options.width * 2;
      canvas.height = options.height * 2;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const pngUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = pngUrl;
        link.download = `${plasmid.name}_map.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(pngUrl);
      }, 'image/png');
    };

    img.src = url;
  }, [plasmid, options.width, options.height]);

  const handleClear = useCallback(() => {
    setPlasmid(null);
    setSelectedFeature(null);
    setError(null);
    setInputText('');
  }, []);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: "'Inter', 'Helvetica', sans-serif",
    ...style,
  };

  const dropZoneStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    border: `2px dashed ${isDragging ? 'hsl(var(--color-accent))' : 'hsl(var(--color-border))'}`,
    borderRadius: 12,
    backgroundColor: isDragging ? 'hsl(var(--color-accent) / 0.1)' : 'hsl(var(--color-bg-subtle))',
    margin: 20,
    padding: 40,
    transition: 'all 0.2s ease',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: 'hsl(var(--color-accent))',
    color: 'hsl(var(--color-bg))',
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: 'hsl(var(--color-border))',
    color: 'hsl(var(--color-fg-muted))',
  };

  if (!plasmid) {
    return (
      <div className={className} style={containerStyle}>
        <div
          style={dropZoneStyle}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
              <DnaHelixIcon size={48} />
            </div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'hsl(var(--color-fg))' }}>
              Plasmid Map Viewer
            </h2>
            <p style={{ margin: '8px 0 0', color: 'hsl(var(--color-fg-subtle))', fontSize: 14 }}>
              Upload a GenBank file or paste GenBank text to visualize your plasmid
            </p>
          </div>

          {error && (
            <div
              style={{
                backgroundColor: 'hsl(var(--color-error) / 0.15)',
                color: 'hsl(var(--color-error))',
                padding: '12px 16px',
                borderRadius: 6,
                marginBottom: 20,
                fontSize: 13,
                maxWidth: 400,
              }}
            >
              {toUserMessage(error, 'structure.failed')}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gb,.gbk,.genbank"
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
            />
            <button style={primaryButtonStyle} onClick={() => fileInputRef.current?.click()}>
              Upload GenBank File
            </button>
          </div>

          <div style={{ width: '100%', maxWidth: 500 }}>
            <div style={{ marginBottom: 8, color: 'hsl(var(--color-fg-subtle))', fontSize: 13 }}>
              Or paste GenBank text:
            </div>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="LOCUS       pUC19     2686 bp    DNA     circular..."
              style={{
                width: '100%',
                height: 150,
                padding: 12,
                fontSize: 12,
                fontFamily: "'Roboto Mono', monospace",
                border: '1px solid hsl(var(--color-border))',
                borderRadius: 6,
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <button
              style={{
                ...primaryButtonStyle,
                marginTop: 12,
                opacity: inputText.trim() ? 1 : 0.5,
              }}
              onClick={handlePasteSubmit}
              disabled={!inputText.trim()}
            >
              Parse GenBank
            </button>
          </div>

          <p style={{ marginTop: 24, color: 'hsl(var(--color-fg-subtle))', fontSize: 12 }}>
            Supports .gb, .gbk files • Drag and drop enabled
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={containerStyle}>
      {}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid hsl(var(--color-border))',
          backgroundColor: 'hsl(var(--color-bg))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button style={secondaryButtonStyle} onClick={handleClear}>
            ← New Plasmid
          </button>
          <span style={{ color: 'hsl(var(--color-fg-subtle))', fontSize: 13 }}>
            {plasmid.features.length} features
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={secondaryButtonStyle}
            onClick={handleExportSVG}
            title="Download as SVG (vector)"
          >
            Export SVG
          </button>
          <button
            style={secondaryButtonStyle}
            onClick={handleExportPNG}
            title="Download as PNG (image)"
          >
            Export PNG
          </button>
        </div>
      </div>

      {}
      <div
        ref={svgContainerRef}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          backgroundColor: 'hsl(var(--color-bg-subtle))',
          padding: 20,
        }}
      >
        <PlasmidMap
          plasmid={plasmid}
          options={options}
          selectedFeature={selectedFeature}
          onFeatureSelect={setSelectedFeature}
        />
      </div>

      {}
      {selectedFeature && (
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid hsl(var(--color-border))',
            backgroundColor: 'hsl(var(--color-bg))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
            <div
              style={{
                width: 4,
                height: 40,
                backgroundColor: selectedFeature.color,
                borderRadius: 2,
              }}
            />
            <div style={{ flex: 1 }}>
              <h3
                style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'hsl(var(--color-fg))' }}
              >
                {selectedFeature.displayName}
              </h3>
              <div
                style={{
                  display: 'flex',
                  gap: 16,
                  marginTop: 8,
                  fontSize: 13,
                  color: 'hsl(var(--color-fg-subtle))',
                }}
              >
                <span>
                  <strong>Type:</strong> {selectedFeature.type}
                </span>
                <span>
                  <strong>Location:</strong> {selectedFeature.start}..{selectedFeature.end}
                </span>
                <span>
                  <strong>Length:</strong> {selectedFeature.end - selectedFeature.start + 1} bp
                </span>
                {selectedFeature.direction !== 'none' && (
                  <span>
                    <strong>Direction:</strong>{' '}
                    {selectedFeature.direction === 'forward' ? 'Forward →' : '← Reverse'}
                  </span>
                )}
              </div>
              {selectedFeature.qualifiers.product?.[0] && (
                <div style={{ marginTop: 8, fontSize: 13, color: 'hsl(var(--color-fg-muted))' }}>
                  <strong>Product:</strong> {selectedFeature.qualifiers.product[0]}
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedFeature(null)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 20,
                color: 'hsl(var(--color-fg-subtle))',
                cursor: 'pointer',
                padding: 4,
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
