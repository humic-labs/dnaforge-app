import type { BoundPrimer } from '../types';
import { savedPrimerModificationMarkers } from '../adapters';
import { Tooltip } from '../../../shared/components/Tooltip';

const STATUS_COLORS: Record<string, string> = {
  designed: 'bg-neutral-500/20 text-neutral-400',
  ordered: 'bg-blue-500/20 text-blue-400',
  received: 'bg-green-500/20 text-green-400',
  verified: 'bg-emerald-500/20 text-emerald-300',
  archived: 'bg-neutral-600/20 text-neutral-500',
};

interface PrimerRowProps {
  primer: BoundPrimer;
  isSelected?: boolean;
  onClick?: () => void;
  onDetach?: () => void;
}

export function PrimerRow({ primer, isSelected, onClick, onDetach }: PrimerRowProps) {
  const direction = primer.binding.strand === -1 ? 'reverse' : 'forward';
  const directionArrow = direction === 'forward' ? '→' : '←';
  const modificationMarkers = savedPrimerModificationMarkers(primer);

  const row = (
    <div
      data-testid={`primer-row-${primer.binding.id}`}
      className={`group w-full px-3 py-2 cursor-pointer border-b border-border wp-interactive transition-colors ${
        isSelected ? 'bg-accent/10 border-l-2 border-l-accent' : ''
      }`}
      onClick={onClick}
    >
      {}
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-muted font-mono">{primer.catalogNumber}</span>
        <span className="text-sm font-medium text-fg truncate">{primer.name}</span>
      </div>

      {}
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-fg-muted">{directionArrow}</span>
        <span className="text-xs text-fg-muted">{primer.length} nt</span>
        <span className="text-xs text-fg-muted">
          {primer.tm == null ? 'Tm —' : `${primer.tm.toFixed(1)}°C`}
        </span>
      </div>

      {}
      <div
        data-testid={`primer-row-sequence-${primer.binding.id}`}
        className="mt-0.5 break-all font-mono text-xs text-fg-muted"
      >
        {primer.sequence}
      </div>

      {}
      <div className="flex items-center gap-2 mt-1">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_COLORS[primer.status] ?? STATUS_COLORS.designed}`}
        >
          {primer.status}
        </span>
        <span className="text-[10px] text-fg-muted">
          {primer.binding.locationLabel ??
            `${primer.binding.bindingStart}–${primer.binding.bindingEnd}`}
        </span>
        <div className="flex-1" />
        {onDetach && (
          <button
            data-testid={`primer-detach-${primer.binding.id}`}
            className="text-[10px] text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              onDetach();
            }}
          >
            Detach
          </button>
        )}
      </div>
    </div>
  );
  return modificationMarkers?.length ? (
    <Tooltip
      side="left"
      className="flex w-full"
      content={
        <div data-testid="attached-primer-modifications">
          {modificationMarkers.map((marker, index) => (
            <div key={index}>
              {marker.label} {marker.token}
            </div>
          ))}
        </div>
      }
    >
      {row}
    </Tooltip>
  ) : (
    row
  );
}
