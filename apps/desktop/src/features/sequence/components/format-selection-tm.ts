import type { LocalTmReadout } from '../../design/public/algorithms/local-tm';

export interface SelectionTmDisplay {
  text: string | null;
  title: string | undefined;
}

const NOTHING: SelectionTmDisplay = { text: null, title: undefined };

export function formatSelectionTm(
  readout: LocalTmReadout | null | undefined,
  fallbackTm: number | null | undefined
): SelectionTmDisplay {
  if (!readout) {
    if (fallbackTm === null || fallbackTm === undefined) return NOTHING;
    return { text: `${Math.round(fallbackTm)}°C`, title: 'Estimated melting temperature' };
  }

  switch (readout.kind) {
    case 'value':
      return {
        text: `${Math.round(readout.tm)}°C`,
        title: 'Estimated melting temperature',
      };

    case 'range': {
      const low = Math.round(readout.minTm);
      const high = Math.round(readout.maxTm);
      const text = low === high ? `~${low}°C` : `${low}–${high}°C`;
      return {
        text,
        title:
          `This selection contains degenerate bases, so it is ${readout.combinations} ` +
          `different sequences with melting temperatures from ${readout.minTm.toFixed(1)}°C ` +
          `to ${readout.maxTm.toFixed(1)}°C (mean ${readout.meanTm.toFixed(1)}°C).`,
      };
    }

    case 'indeterminate':
      return { text: '—', title: readout.detail };
  }
}
