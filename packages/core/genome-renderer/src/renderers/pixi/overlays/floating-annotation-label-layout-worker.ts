import {
  precomputeFloatingAnnotationLabelAssignments,
  type FloatingAnnotationLabelAssignmentPlan,
  type FloatingAnnotationLabelDescriptor,
  type FloatingAnnotationLabelPlacementOption,
  type FloatingAnnotationLabelSlot,
} from './floating-annotation-label-layout';

export interface FloatingAnnotationLabelLayoutWorkerRequest {
  readonly requestId: number;
  readonly descriptorData: Float64Array;
  readonly optionData: Float64Array;
  readonly pixelsPerBp: number;
  readonly genomeLength: number;
  readonly circular: boolean;
}

export interface FloatingAnnotationLabelLayoutWorkerResponse extends Omit<
  FloatingAnnotationLabelAssignmentPlan,
  'assignments'
> {
  readonly requestId: number;
  readonly assignments: readonly (readonly [number, FloatingAnnotationLabelSlot])[];
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<FloatingAnnotationLabelLayoutWorkerRequest>) => void) | null;
  postMessage: (message: FloatingAnnotationLabelLayoutWorkerResponse) => void;
};

const DESCRIPTOR_STRIDE = 9;
const OPTION_STRIDE = 6;

function unpackDescriptors(
  descriptorData: Float64Array,
  optionData: Float64Array
): FloatingAnnotationLabelDescriptor[] {
  const descriptors: FloatingAnnotationLabelDescriptor[] = [];
  for (let offset = 0; offset < descriptorData.length; offset += DESCRIPTOR_STRIDE) {
    const optionOffset = descriptorData[offset + 7];
    const optionCount = descriptorData[offset + 8];
    const placementOptions: FloatingAnnotationLabelPlacementOption[] = [];
    for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
      const optionBase = (optionOffset + optionIndex) * OPTION_STRIDE;
      placementOptions.push({
        tangentStep: optionData[optionBase],
        layoutCenterBp: optionData[optionBase + 1],
        layoutCenterMinBp: optionData[optionBase + 2],
        layoutCenterMaxBp: optionData[optionBase + 3],
        outwardClearance: optionData[optionBase + 4],
        outwardRail: optionData[optionBase + 5],
      });
    }
    descriptors.push({
      featureId: descriptorData[offset],
      text: '',
      stableOrder: [descriptorData[offset + 1], descriptorData[offset + 2]],
      sequenceCenterBp: descriptorData[offset + 3],
      outwardSide: descriptorData[offset + 4] < 0 ? -1 : 1,
      textWidth: descriptorData[offset + 5],
      textHeight: descriptorData[offset + 6],
      placementOptions,
    });
  }
  return descriptors;
}

workerScope.onmessage = ({ data }) => {
  const plan = precomputeFloatingAnnotationLabelAssignments(
    unpackDescriptors(data.descriptorData, data.optionData),
    {
      pixelsPerBp: data.pixelsPerBp,
      genomeLength: data.genomeLength,
      circular: data.circular,
    }
  );
  workerScope.postMessage({
    requestId: data.requestId,
    ...plan,
    assignments: [...plan.assignments],
  });
};
