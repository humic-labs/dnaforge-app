import { describe, expect, it, vi } from 'vitest';
import { reportOrfPaint } from './orf-observation';

describe('reportOrfPaint', () => {
  it('leaves a suppressed nonempty model pending', () => {
    const presented = vi.fn();
    reportOrfPaint(presented, false, false, 'sequence_canvas');
    expect(presented).not.toHaveBeenCalled();
  });

  it('reports an actual ORF draw with its receiving surface', () => {
    const presented = vi.fn();
    reportOrfPaint(presented, false, true, 'sequence_tracks');
    expect(presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'orf_drawn',
      surface: 'sequence_tracks',
    });
  });

  it('reports a valid empty model without inventing an ORF draw', () => {
    const presented = vi.fn();
    reportOrfPaint(presented, true, false, 'plasmid_map');
    expect(presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'empty_model',
      surface: 'plasmid_map',
    });
  });

  it('isolates observation exceptions from the renderer', () => {
    expect(() =>
      reportOrfPaint(
        () => {
          throw new Error('controlled observer failure');
        },
        false,
        true,
        'sequence_canvas'
      )
    ).not.toThrow();
  });
});
