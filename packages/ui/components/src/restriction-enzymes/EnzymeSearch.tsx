import React, { useRef, useEffect, KeyboardEvent } from 'react';

interface EnzymeSearchProps {
  nameValue: string;
  sequenceValue: string;
  onNameChange: (value: string) => void;
  onSequenceChange: (value: string) => void;
  onArrowDown: () => void;
}

export function EnzymeSearch({
  nameValue,
  sequenceValue,
  onNameChange,
  onSequenceChange,
  onArrowDown,
}: EnzymeSearchProps): React.ReactElement {
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onArrowDown();
    }
  };

  return (
    <div style={styles.container}>
      {}
      <div style={styles.inputWrapper}>
        <input
          ref={nameInputRef}
          type="text"
          value={nameValue}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Name"
          style={styles.input}
        />
        {nameValue && (
          <button onClick={() => onNameChange('')} style={styles.clearButton} title="Clear">
            ×
          </button>
        )}
      </div>

      {}
      <div style={styles.inputWrapper}>
        <input
          type="text"
          value={sequenceValue}
          onChange={(e) => onSequenceChange(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          placeholder="Sequence"
          style={{ ...styles.input, fontFamily: 'monospace' }}
        />
        {sequenceValue && (
          <button onClick={() => onSequenceChange('')} style={styles.clearButton} title="Clear">
            ×
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    gap: '6px',
    padding: '6px 8px',
    borderBottom: '1px solid hsl(var(--color-border))',
  },
  inputWrapper: {
    position: 'relative',
    flex: 1,
  },
  input: {
    width: '100%',
    padding: '5px 24px 5px 8px',
    border: '1px solid hsl(var(--color-border))',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    backgroundColor: 'hsl(var(--color-bg))',
    color: 'hsl(var(--color-fg))',
  },
  clearButton: {
    position: 'absolute',
    right: '6px',
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '0 2px',
    lineHeight: '1',
  },
};
