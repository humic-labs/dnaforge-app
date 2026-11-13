export function prepackedLayerConstructionRoute(input: {
  trustedV4Admission: boolean;
  trustedDetailPacketAdmission: boolean;
}): 'v4' | 'detail-packet' | 'legacy' {
  if (input.trustedV4Admission) return 'v4';
  if (input.trustedDetailPacketAdmission) return 'detail-packet';
  return 'legacy';
}

export function shouldRejectIncompatibleActiveOwner(input: {
  preserveActiveOwner: boolean;
  existingIsActiveLayer: boolean;
  bankCompatible: boolean;
}): boolean {
  return input.preserveActiveOwner && input.existingIsActiveLayer && !input.bankCompatible;
}
