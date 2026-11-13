import type { RenderedPrimerSegment } from '@waypoint/workspace-editor';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import type { JunctionFieldHandle } from './JunctionHandleOverlay';
import type { JunctionWorkbenchRow } from './model';
import { sourceContributionBoundaryFieldForRow } from './AssemblyWorkbenchInteractionCapabilities';
import {
  productOverlapBioRangeForField,
  productOverlapBoundaryBioColForField,
} from './ProductOverlapPreviewContract';
import {
  FALLBACK_LEFT_SOURCE_COLOR,
  FALLBACK_RIGHT_SOURCE_COLOR,
  productOwnerColor,
  productOwnerForPoint,
} from './WorkbenchPaintingContract';

const PRODUCT_OVERLAP_HANDLE_HEIGHT_PX = 52;

export { sourceContributionBoundaryFieldForRow };

export function projectFieldHandlesForRow(input: {
  row: JunctionWorkbenchRow;
  fields: AssemblyWorkbenchEditableField[];
  primerSegments: RenderedPrimerSegment[];
  height: number;
  screenXForBioCol: (bioCol: number) => number;
}): JunctionFieldHandle[] {
  const handles: JunctionFieldHandle[] = [];
  for (const field of input.fields) {
    if (field.units !== 'bp' || typeof field.value !== 'number' || !field.range) continue;
    if (!isHandleRenderableField(field)) continue;
    const productHomologyHandle = projectProductHomologyHandle(input, field);
    if (productHomologyHandle) {
      handles.push(productHomologyHandle);
      continue;
    }
    const productGoldenGateHandle = projectProductGoldenGateHandle(input, field);
    if (productGoldenGateHandle) {
      handles.push(productGoldenGateHandle);
      continue;
    }
    for (const anchor of field.anchors) {
      if (anchor.rowId !== input.row.id) continue;
      if (!shouldRenderAnchor(field, anchor.role)) continue;

      const primerGeometry = isPrimerField(field)
        ? primerHandleGeometry(field, anchor.role, input.primerSegments)
        : null;
      const undrawnPrimerX =
        isPrimerField(field) && !primerGeometry
          ? undrawnPrimerBoundaryX(input.row, field, anchor.role, input.screenXForBioCol)
          : null;
      if (isPrimerField(field) && !primerGeometry && undrawnPrimerX === null) continue;

      const x = primerGeometry?.x ?? undrawnPrimerX ?? input.screenXForBioCol(anchor.bioCol);
      handles.push({
        id: `${field.id}:${anchor.rowId}:${anchor.role}`,
        label: `${field.label} ${labelForRole(anchor.role)}`,
        field,
        rowId: anchor.rowId,
        kind: field.kind,
        role: anchor.role,
        value: field.value,
        min: field.range.min,
        max: field.range.max,
        step: field.range.step,
        largeStep: field.range.largeStep,
        x,
        y: primerGeometry?.y ?? 0,
        height: primerGeometry?.height ?? input.height,
        guideStartY: primerGeometry?.guideStartY,
        dragScale: dragScaleForField(field, anchor.role),
        previewSegments: primerGeometry?.previewSegments,
        geometryPending: undrawnPrimerX === null ? undefined : true,
        disabled: field.disabled,
        color: colorForHandle(input.row, field, anchor),
      });
    }
  }
  return handles;
}

function isHandleRenderableField(field: AssemblyWorkbenchEditableField): boolean {
  return (
    field.kind === 'primerPbs' ||
    field.kind === 'homologyArm' ||
    field.kind === 'goldenGateOverhang'
  );
}

function isPrimerField(field: AssemblyWorkbenchEditableField): boolean {
  return field.kind === 'primerPbs' || field.kind === 'primerTail';
}

function undrawnPrimerBoundaryX(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  role: AssemblyWorkbenchEditableField['anchors'][number]['role'],
  screenXForBioCol: (bioCol: number) => number
): number | null {
  const primerId = field.target.primerId;
  if (!primerId || (role !== 'pbs-start' && role !== 'pbs-end')) return null;
  const primer = (row.primers ?? []).find(
    (candidate) => candidate.id === primerId || candidate.sourcePrimerId === primerId
  );
  if (!primer || primer.end <= primer.start) return null;
  const overhangLength = Math.max(
    0,
    Math.min(primer.overhangLength ?? 0, primer.end - primer.start)
  );
  const bindingStart =
    primer.direction === 'forward' ? primer.start + overhangLength : primer.start;
  const bindingEnd = primer.direction === 'forward' ? primer.end : primer.end - overhangLength;
  if (bindingEnd <= bindingStart) return null;
  const rowPosition = role === 'pbs-start' ? bindingStart : bindingEnd;
  return screenXForBioCol(rowPosition - row.anchorRowPosition);
}

function shouldRenderAnchor(
  field: AssemblyWorkbenchEditableField,
  role: AssemblyWorkbenchEditableField['anchors'][number]['role']
): boolean {
  if (role === 'boundary') return true;
  const side = field.target.side;
  if (field.kind === 'primerPbs') {
    return side === 'left' ? role === 'pbs-start' : role === 'pbs-end';
  }
  if (field.kind === 'primerTail') {
    return side === 'left' ? role === 'tail-start' : role === 'tail-end';
  }
  if (field.kind === 'homologyArm') return false;
  return false;
}

function projectProductHomologyHandle(
  input: {
    row: JunctionWorkbenchRow;
    height: number;
    screenXForBioCol: (bioCol: number) => number;
  },
  field: AssemblyWorkbenchEditableField
): JunctionFieldHandle | null {
  if (input.row.kind !== 'product' || field.kind !== 'homologyArm') return null;
  if (typeof field.value !== 'number' || !field.range) return null;
  const side = field.target.side;
  if (side !== 'left' && side !== 'right') return null;
  const role = side === 'left' ? 'tail-start' : 'tail-end';
  const anchor = field.anchors.find((item) => item.role === role);
  const bioCol = productOverlapBoundaryBioColForField(input.row, field) ?? anchor?.bioCol;
  if (typeof bioCol !== 'number') return null;
  const handleHeight = Math.min(input.height, PRODUCT_OVERLAP_HANDLE_HEIGHT_PX);
  return {
    id: `${field.id}:${input.row.id}:overlap-${side}`,
    label: `${field.label} overlap ${side === 'left' ? 'start' : 'end'}`,
    field,
    rowId: input.row.id,
    kind: field.kind,
    role,
    value: field.value,
    min: field.range.min,
    max: field.range.max,
    step: field.range.step,
    largeStep: field.range.largeStep,
    x: input.screenXForBioCol(bioCol),
    y: Math.max(0, input.height - handleHeight),
    height: handleHeight,
    guideStartY: Math.max(0, input.height - handleHeight),
    dragScale: side === 'left' ? -1 : 1,
    disabled: field.disabled,
    color: productOwnerColor(input.row, side),
  };
}

function projectProductGoldenGateHandle(
  input: {
    row: JunctionWorkbenchRow;
    height: number;
    screenXForBioCol: (bioCol: number) => number;
  },
  field: AssemblyWorkbenchEditableField
): JunctionFieldHandle | null {
  if (input.row.kind !== 'product' || field.kind !== 'goldenGateOverhang') return null;
  if (typeof field.value !== 'number' || !field.range) return null;
  const range = productOverlapBioRangeForField(input.row, field);
  if (!range || range.kind !== 'goldengate-overhang') return null;
  const bioCol = (range.startBioCol + range.endBioCol) / 2;
  if (typeof bioCol !== 'number') return null;
  const handleHeight = Math.min(input.height, PRODUCT_OVERLAP_HANDLE_HEIGHT_PX);
  const startX = input.screenXForBioCol(range.startBioCol);
  const endX = input.screenXForBioCol(range.endBioCol);
  return {
    id: `${field.id}:${input.row.id}:overhang-offset`,
    label: `${field.label} overhang offset`,
    field,
    rowId: input.row.id,
    kind: field.kind,
    role: 'boundary',
    value: field.value,
    min: field.range.min,
    max: field.range.max,
    step: field.range.step,
    largeStep: field.range.largeStep,
    x: input.screenXForBioCol(bioCol),
    y: Math.max(0, input.height - handleHeight),
    height: handleHeight,
    guideStartY: Math.max(0, input.height - handleHeight),
    dragScale: 1,
    disabled: field.disabled,
    visualSpan:
      endX > startX
        ? {
            startX,
            endX,
          }
        : undefined,
    color: productOwnerColor(
      input.row,
      productOwnerForPoint(input.row, {
        bioCol,
        rowPosition: rowPositionForBioCol(input.row, bioCol) ?? 0,
      })
    ),
  };
}

function primerHandleGeometry(
  field: AssemblyWorkbenchEditableField,
  role: AssemblyWorkbenchEditableField['anchors'][number]['role'],
  segments: RenderedPrimerSegment[]
): {
  x: number;
  y: number;
  height: number;
  guideStartY: number;
  previewSegments: JunctionFieldHandle['previewSegments'];
} | null {
  const primerSegments = segments.filter(
    (segment) =>
      segment.primerId === field.target.primerId || segment.sourcePrimerId === field.target.primerId
  );
  if (primerSegments.length === 0) return null;
  const segmentRole =
    role === 'pbs-start' || role === 'pbs-end'
      ? (segment: RenderedPrimerSegment) => segment.role === 'pbs'
      : (segment: RenderedPrimerSegment) => segment.role !== 'pbs';
  const matching = primerSegments.filter(segmentRole);
  if (matching.length === 0) return null;
  const minX = Math.min(...matching.map((segment) => segment.x));
  const maxX = Math.max(...matching.map((segment) => segment.x + segment.width));
  const minY = Math.min(...matching.map((segment) => segment.y));
  const maxY = Math.max(...matching.map((segment) => segment.y + segment.height));
  const reverse = matching.some((segment) => segment.direction === 'reverse');
  return {
    x: role === 'pbs-start' || role === 'tail-start' ? minX : maxX,
    y: minY,
    height: maxY - minY,
    guideStartY: reverse ? maxY : minY,
    previewSegments: matching.map((segment) => ({
      x: segment.x,
      y: segment.y,
      width: segment.width,
      height: segment.height,
    })),
  };
}

function rowPositionForBioCol(row: JunctionWorkbenchRow, bioCol: number): number | null {
  const point = row.points.find((item) => item.bioCol === bioCol);
  return point?.rowPosition ?? null;
}

function dragScaleForField(
  field: AssemblyWorkbenchEditableField,
  role: AssemblyWorkbenchEditableField['anchors'][number]['role']
): number {
  if (field.kind === 'sourceContributionBoundary' || field.kind === 'goldenGateOverhang') return 1;
  return role === 'pbs-start' || role === 'tail-start' ? -1 : 1;
}

function colorForHandle(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  anchor: AssemblyWorkbenchEditableField['anchors'][number]
): string {
  if (row.kind === 'product') {
    return productOwnerColor(
      row,
      productOwnerForPoint(row, {
        bioCol: anchor.bioCol,
        rowPosition: rowPositionForBioCol(row, anchor.bioCol) ?? 0,
      })
    );
  }
  if (field.kind === 'sourceContributionBoundary' || field.kind === 'primerPbs') {
    return row.fragmentColor ?? FALLBACK_LEFT_SOURCE_COLOR;
  }
  if (field.kind === 'primerTail') {
    return row.partnerFragmentColor ?? row.fragmentColor ?? FALLBACK_RIGHT_SOURCE_COLOR;
  }
  return row.leftFragmentColor ?? row.fragmentColor ?? '#2563eb';
}

function labelForRole(role: AssemblyWorkbenchEditableField['anchors'][number]['role']): string {
  switch (role) {
    case 'boundary':
      return 'boundary';
    case 'pbs-start':
      return 'PBS start';
    case 'pbs-end':
      return 'PBS end';
    case 'tail-start':
      return 'tail start';
    case 'tail-end':
      return 'tail end';
  }
}
