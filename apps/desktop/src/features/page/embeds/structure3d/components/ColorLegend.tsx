'use client';

import type { Legend, ScaleLegend } from 'molstar/lib/mol-util/legend';
import { molecularColorCss } from '../utils/structureColoration';
import {
  MAX_SWATCH_SECTORS,
  type ColorKey,
  type MolViewSpecColorGroup,
} from '../molstar/molViewSpecLegend';
import './ColorLegend.css';
import type { CSSProperties, ReactNode } from 'react';
import type { Color } from 'molstar/lib/mol-util/color';
import { createPortal } from 'react-dom';
import { useMolecularViewWorkspace } from './MolecularViewWorkspace';
import { StructureTargetButton } from './StructureTargetButton';

const MULTICOLOR_SWATCH =
  'conic-gradient(#e6194b, #f58231, #ffe119, #3cb44b, #42d4f4, #4363d8, #911eb4, #e6194b)';

function swatchStyle(group: MolViewSpecColorGroup | undefined, color: Color): CSSProperties {
  if (!group?.multicolor) return { backgroundColor: molecularColorCss(color) };
  const swatch = group.swatch;
  if (swatch?.kind === 'gradient')
    return {
      background: `linear-gradient(to right, ${swatch.colors.map(molecularColorCss).join(', ')})`,
    };
  if (!swatch?.colors.length || swatch.colors.length > MAX_SWATCH_SECTORS)
    return { background: MULTICOLOR_SWATCH };
  if (swatch.colors.length === 1) return { backgroundColor: molecularColorCss(swatch.colors[0]) };
  const step = 360 / swatch.colors.length;
  return {
    background: `conic-gradient(${swatch.colors
      .map(
        (sector, index) =>
          `${molecularColorCss(sector)} ${index * step}deg ${(index + 1) * step}deg`
      )
      .join(', ')})`,
  };
}

export function ColorLegend({
  legends,
  placement = 'overlay',
  namedGroups,
  onSelectNamedGroup,
  onFocusNamedGroup,
  colorKeys = [],
  children,
}: {
  legends: readonly Legend[];
  colorKeys?: readonly ColorKey[];
  placement?: 'overlay' | 'inline';
  namedGroups?: readonly MolViewSpecColorGroup[];
  onSelectNamedGroup?: (group: MolViewSpecColorGroup) => void;
  onFocusNamedGroup?: (group: MolViewSpecColorGroup) => void;
  children?: ReactNode;
}) {
  const workspace = useMolecularViewWorkspace();
  if (!legends.length && !colorKeys.length && !children) return null;
  const content = (
    <div
      className={
        workspace
          ? `structure-color-legend ${placement === 'inline' ? 'max-h-28' : 'max-h-48'} w-full overflow-x-hidden overflow-y-auto text-xs space-y-2`
          : placement === 'inline'
            ? 'structure-color-legend max-h-28 w-full overflow-x-hidden overflow-y-scroll bg-bg px-3 py-2 text-xs space-y-2'
            : 'structure-color-legend absolute bottom-3 right-3 max-h-48 w-64 max-w-[calc(100%_-_1.5rem)] overflow-x-hidden overflow-y-scroll bg-bg/90 rounded-md p-2 text-xs space-y-2'
      }
      data-testid="structure-color-legend"
      role="group"
      aria-label="Structure color key"
    >
      {children}
      {legends.map((legend, index) => (
        <div key={index}>
          {legend.kind === 'table-legend' ? (
            <div className="space-y-1">
              {legend.table.map(([label, color], rowIndex) => {
                const candidate = index === 0 ? namedGroups?.[rowIndex] : undefined;
                const group =
                  candidate?.label === label && candidate.color === color ? candidate : undefined;
                const content = (
                  <>
                    <span
                      className="h-3 w-3 shrink-0 rounded-sm"
                      style={swatchStyle(group, color)}
                    />
                    <span className="min-w-0 break-words text-fg-muted">{label}</span>
                  </>
                );
                return group ? (
                  <div
                    key={`${label}-${color}-${rowIndex}`}
                    className="flex w-full items-center gap-1"
                  >
                    <button
                      type="button"
                      aria-label={`Select ${label}`}
                      title={
                        group.selectable
                          ? 'Select the atoms in this color group'
                          : 'An exact atom selection is unavailable for this color group'
                      }
                      disabled={!group.selectable || !onSelectNamedGroup}
                      onClick={() => onSelectNamedGroup?.(group)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left enabled:hover:underline disabled:cursor-default"
                      data-testid={`structure-color-group-${rowIndex}`}
                    >
                      {content}
                    </button>
                    <StructureTargetButton
                      label={label}
                      disabled={!group.selectable || !onFocusNamedGroup}
                      onClick={() => onFocusNamedGroup?.(group)}
                    />
                  </div>
                ) : (
                  <div key={`${label}-${color}-${rowIndex}`} className="flex items-center gap-2">
                    {content}
                  </div>
                );
              })}
            </div>
          ) : (
            <ScaleBar legend={legend} />
          )}
        </div>
      ))}
      {colorKeys.map((key) => (
        <div key={key.title} data-testid="structure-color-key">
          <div className="mb-1 font-medium text-fg">{key.title}</div>
          {key.legend.kind === 'table-legend' ? (
            <div className="space-y-1">
              {key.legend.table.map(([label, color]) => (
                <div key={label} className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: molecularColorCss(color) }}
                  />
                  <span className="min-w-0 break-words text-fg-muted">{label}</span>
                </div>
              ))}
            </div>
          ) : (
            <ScaleBar legend={key.legend} />
          )}
        </div>
      ))}
    </div>
  );
  return workspace ? (workspace.legend ? createPortal(content, workspace.legend) : null) : content;
}

function ScaleBar({ legend }: { legend: ScaleLegend }) {
  return (
    <div className="min-w-32">
      <div
        className="h-3 rounded-sm"
        style={{
          background: `linear-gradient(to right, ${legend.colors
            .map((entry) =>
              Array.isArray(entry)
                ? `${molecularColorCss(entry[0])} ${entry[1] * 100}%`
                : molecularColorCss(entry)
            )
            .join(', ')})`,
        }}
      />
      <div className="mt-1 flex justify-between gap-4 text-fg-muted">
        <span>{legend.minLabel}</span>
        <span>{legend.maxLabel}</span>
      </div>
    </div>
  );
}
