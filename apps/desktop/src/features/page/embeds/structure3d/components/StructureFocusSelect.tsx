'use client';

import { MenuNativeSelect } from '@waypoint/ui-components';

import type { StructureComplexMember } from '../types';
import { structureMemberOptionLabel } from '../utils/structureMemberLabels';

interface StructureFocusSelectProps {
  members: StructureComplexMember[];
  activeMemberId: string;
  onFocusMemberChange: (memberId: string) => void;
  layout: 'sidebar' | 'bar';
}

export function StructureFocusSelect({
  members,
  activeMemberId,
  onFocusMemberChange,
  layout,
}: StructureFocusSelectProps) {
  const select = (
    <MenuNativeSelect
      aria-label="Focused structure member"
      value={activeMemberId}
      onChange={(e) => onFocusMemberChange(e.target.value)}
      data-testid="structure-focus-select"
    >
      {members.map((member) => (
        <option key={member.memberId} value={member.memberId}>
          {structureMemberOptionLabel(member)}
        </option>
      ))}
    </MenuNativeSelect>
  );

  if (layout === 'sidebar') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-fg-muted uppercase tracking-wide">Focus</span>
        {select}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-muted">Focus:</span>
      {select}
    </div>
  );
}
