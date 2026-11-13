import React from 'react';
import type { CutSite } from '@waypoint/sequence-utils';

interface EnzymeInfoTooltipProps {
  cutSite: CutSite;
  position: { x: number; y: number };
  onClose: () => void;
}

export function EnzymeInfoTooltip({
  cutSite,
  position,
  onClose,
}: EnzymeInfoTooltipProps): React.ReactElement {
  const { enzyme } = cutSite;

  const getOverhangInfo = () => {
    if (enzyme.overhang_type === 'blunt') {
      return 'Blunt end';
    }
    if (enzyme.overhang_type === '5_prime') {
      return `5' overhang (${enzyme.overhang_length} nt)`;
    }
    if (enzyme.overhang_type === '3_prime') {
      return `3' overhang (${enzyme.overhang_length} nt)`;
    }
    return 'Unknown';
  };

  const getCutNotation = () => {
    const seq = enzyme.recognition_sequence;
    const topCut = enzyme.cut_position_top ?? 0;

    if (topCut >= 0 && topCut <= seq.length) {
      return seq.slice(0, topCut) + '^' + seq.slice(topCut);
    }
    return seq;
  };

  const suppliers = enzyme.suppliers.map((s) => s.name).join(', ');

  return (
    <div
      style={{
        ...styles.container,
        left: position.x,
        top: position.y,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={styles.header}>
        <span style={styles.name}>{enzyme.name}</span>
        <button onClick={onClose} style={styles.closeButton}>
          ×
        </button>
      </div>

      <div style={styles.content}>
        <div style={styles.row}>
          <span style={styles.label}>Recognition:</span>
          <span style={styles.value}>{enzyme.recognition_sequence}</span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Cut site:</span>
          <span style={{ ...styles.value, fontFamily: 'monospace' }}>{getCutNotation()}</span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Overhang:</span>
          <span style={styles.value}>{getOverhangInfo()}</span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Position:</span>
          <span style={styles.value}>{cutSite.cutPositionTop + 1}</span>
        </div>

        {enzyme.source_organism && (
          <div style={styles.row}>
            <span style={styles.label}>Source:</span>
            <span style={styles.value}>{enzyme.source_organism}</span>
          </div>
        )}

        {suppliers && (
          <div style={styles.row}>
            <span style={styles.label}>Vendors:</span>
            <span style={styles.value}>{suppliers}</span>
          </div>
        )}
      </div>

      <div style={styles.footer}>Double-click to select recognition site</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    backgroundColor: 'hsl(var(--color-bg))',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    border: '1px solid hsl(var(--color-border))',
    minWidth: '240px',
    maxWidth: '320px',
    zIndex: 1000,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    borderBottom: '1px solid hsl(var(--color-border))',
    backgroundColor: 'hsl(var(--color-bg-subtle))',
    borderRadius: '8px 8px 0 0',
  },
  name: {
    fontWeight: 600,
    fontSize: '14px',
    color: 'hsl(var(--color-fg))',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: 'hsl(var(--color-fg-muted))',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: '1',
  },
  content: {
    padding: '12px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '6px',
  },
  label: {
    fontSize: '12px',
    color: 'hsl(var(--color-fg-muted))',
  },
  value: {
    fontSize: '12px',
    color: 'hsl(var(--color-fg))',
    fontWeight: 500,
  },
  footer: {
    padding: '8px 12px',
    borderTop: '1px solid hsl(var(--color-border))',
    fontSize: '11px',
    color: 'hsl(var(--color-fg-subtle))',
    textAlign: 'center',
  },
};
