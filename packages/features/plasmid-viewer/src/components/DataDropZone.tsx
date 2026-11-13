import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useState, useCallback, useRef } from 'react';
import type { ParsedPlasmid } from '../types';
import { parseGenBank, isGenBankFormat } from '../parsers/genbank';

export interface DataDropZoneProps {
  onDataLoad: (data: ParsedPlasmid) => void;
  onCommentChange?: (comment: string) => void;
  comment?: string;
  isLoading?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function DataDropZone({
  onDataLoad,
  onCommentChange,
  comment = '',
  isLoading = false,
  className,
  style,
}: DataDropZoneProps): JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localComment, setLocalComment] = useState(comment);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      const reader = new FileReader();

      reader.onload = (e) => {
        const content = e.target?.result as string;
        try {
          if (isGenBankFormat(content)) {
            const parsed = parseGenBank(content);
            onDataLoad(parsed);
          } else {
            setError(userMessage('failure.unsupported-format-currently-supports-genbank-gb-gbk'));
          }
        } catch (err) {
          setError(toUserMessage(err, 'failure.failed-to-parse-file'));
        }
      };

      reader.onerror = () => setError(userMessage('failure.failed-to-read-file'));
      reader.readAsText(file);
    },
    [onDataLoad]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const handleCommentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setLocalComment(value);
      onCommentChange?.(value);
    },
    [onCommentChange]
  );

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 16,
        backgroundColor: 'hsl(var(--color-bg-subtle))',
        borderRight: '1px solid hsl(var(--color-border))',
        width: 280,
        flexShrink: 0,
        ...style,
      }}
    >
      {}
      <div>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'hsl(var(--color-fg))' }}>
          Data Input
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'hsl(var(--color-fg-subtle))' }}>
          Drop files or paste data
        </p>
      </div>

      {}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          border: `2px dashed ${isDragging ? 'hsl(var(--color-accent))' : 'hsl(var(--color-border))'}`,
          borderRadius: 8,
          backgroundColor: isDragging ? 'hsl(var(--color-accent) / 0.1)' : 'hsl(var(--color-bg))',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          minHeight: 120,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".gb,.gbk,.genbank,.fasta,.fa,.fna"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />

        {isLoading ? (
          <span style={{ color: 'hsl(var(--color-fg-subtle))', fontSize: 13 }}>Loading...</span>
        ) : (
          <>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📁</div>
            <span style={{ color: 'hsl(var(--color-fg-muted))', fontSize: 13, fontWeight: 500 }}>
              Drop file here
            </span>
            <span style={{ color: 'hsl(var(--color-fg-subtle))', fontSize: 11, marginTop: 4 }}>
              GenBank, FASTA
            </span>
          </>
        )}
      </div>

      {}
      {error && (
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: 'hsl(var(--color-error) / 0.1)',
            borderRadius: 6,
            fontSize: 12,
            color: 'hsl(var(--color-error))',
          }}
        >
          {toUserMessage(error, 'structure.failed')}
        </div>
      )}

      {}
      <div
        style={{
          height: 1,
          backgroundColor: 'hsl(var(--color-border))',
          margin: '4px 0',
        }}
      />

      {}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <label
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'hsl(var(--color-fg-muted))',
            marginBottom: 8,
          }}
        >
          Instructions
          <span
            style={{
              fontWeight: 400,
              color: 'hsl(var(--color-fg-subtle))',
              fontSize: 11,
              marginLeft: 6,
            }}
          >
            (for AI assistant)
          </span>
        </label>
        <textarea
          value={localComment}
          onChange={handleCommentChange}
          placeholder="What would you like to do with this data?&#10;&#10;Examples:&#10;• Find all EcoRI sites&#10;• Design primers for the GFP gene&#10;• Check if the sequence is correct"
          style={{
            flex: 1,
            minHeight: 150,
            padding: 12,
            fontSize: 13,
            fontFamily: 'inherit',
            border: '1px solid hsl(var(--color-border))',
            borderRadius: 6,
            resize: 'none',
            lineHeight: 1.5,
          }}
        />
      </div>

      {}
      <div style={{ fontSize: 11, color: 'hsl(var(--color-fg-subtle))' }}>
        Supported: .gb, .gbk, .fasta, .fa
      </div>
    </div>
  );
}
