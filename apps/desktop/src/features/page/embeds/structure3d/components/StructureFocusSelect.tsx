'use client';

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
    <select
      aria-label="Focused structure member"
      value={activeMemberId}
      onChange={(e) => onFocusMemberChange(e.target.value)}
      className={
        layout === 'sidebar'
          ? 'text-xs px-1.5 py-1 rounded border bg-bg text-fg text-left cursor-pointer hover:border-fg-muted focus:outline-none focus:ring-1 focus:ring-accent border-border'
          : 'text-xs px-2 py-1 rounded border bg-bg text-fg cursor-pointer hover:border-fg-muted focus:outline-none focus:ring-1 focus:ring-accent border-border'
      }
      data-testid="structure-focus-select"
    >
      {members.map((member) => (
        <option key={member.memberId} value={member.memberId}>
          {structureMemberOptionLabel(member)}
        </option>
      ))}
    </select>
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
