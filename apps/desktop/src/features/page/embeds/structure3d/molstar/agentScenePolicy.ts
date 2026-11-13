export const MVS_BACKGROUND_LOCK = {
  id: 'background-locked',
  label: 'Background locked',
  errorCode: 'MVS_BACKGROUND_LOCKED',
  enforcement:
    'Agent scene and story-step tools reject canvas changes; all MolViewSpec loads remove saved canvas nodes before rendering, leaving the host background transparent.',
} as const;

export const MVS_DUPLICATE_GEOMETRY_RULE = {
  id: 'duplicate-geometry',
  label: 'No duplicate geometry',
  errorCode: 'MVS_DUPLICATE_GEOMETRY',
  enforcement:
    'MolViewSpec rendering rejects overlapping ownership of native visual features, including within one representation and schematic versus atomic nucleotide connections.',
} as const;

export const MVS_ATTACHMENT_INTEGRITY_RULE = {
  id: 'covalent-attachment-integrity',
  label: 'Covalent attachments preserved',
  errorCode: 'MISSING_COVALENT_ATTACHMENT',
  enforcement:
    'Canonical scene authoring includes source-derived covalent attachment context in one native owner. Apply/save reject displayed attachments missing native bond geometry or source endpoints; no bonds are fabricated.',
} as const;

export const MVS_INTERACTION_CONTACT_RETENTION_RULE = {
  id: 'computed-interaction-contact-retention',
  label: 'Computed contacts retained',
  errorCode: 'MVS_INTERACTION_CONTACTS_LOST',
  enforcement:
    'Whole-scene replacements retain each complete native computed contact set in a relevant detail step. Missing, hidden or changed endpoints fail before mutation. Explicit focus changes may discard the context; native recomputation replaces it through the canonical scene owner.',
} as const;

export const MVS_HYDROGEN_VISIBILITY_RULE = {
  id: 'hydrogen-atoms-hidden-by-default',
  label: 'Hydrogen atoms hidden unless requested',
  errorCode: 'MVS_HYDROGEN_VISIBILITY_OWNED',
  enforcement:
    'Native construction and every saved story step hide all hydrogen atoms. Scene flags cannot opt out; new authoring can show them only when the host recorded an explicit display request from the submitted user message. Saved exceptions retain that request. Hydrogen-bond calculations and guides are unchanged.',
} as const;

export const MVS_AGENT_SCENE_POLICY = {
  id: 'mvs-agent-scene-v7',
  enforcedConstraints: [
    MVS_BACKGROUND_LOCK,
    MVS_DUPLICATE_GEOMETRY_RULE,
    MVS_ATTACHMENT_INTEGRITY_RULE,
    MVS_INTERACTION_CONTACT_RETENTION_RULE,
    MVS_HYDROGEN_VISIBILITY_RULE,
  ],
} as const;
