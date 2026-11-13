import type { RulerDecoration } from '@waypoint/workspace-editor';
import { CHANGE_COLORS } from '@waypoint/workspace-editor';
import type { DiffResult } from './sequence-diff';

export function diffToDecorations(diff: DiffResult): RulerDecoration[] {
  const decorations: RulerDecoration[] = [];

  for (const change of diff.changes) {
    switch (change.type) {
      case 'insertion':
        decorations.push({
          start: change.position,
          end: change.position + change.length - 1,
          color: CHANGE_COLORS.insertion.accent,
          layer: 'git-diff',
          style: 'solid',
          metadata: { type: 'insertion', bases: change.newBases },
        });
        break;

      case 'deletion':
        decorations.push({
          start: change.position,
          end: change.position,
          color: CHANGE_COLORS.deletion.accent,
          layer: 'git-diff',
          style: 'caret',
          metadata: { type: 'deletion', bases: change.oldBases, length: change.length },
        });
        break;

      case 'mutation':
        decorations.push({
          start: change.position,
          end: change.position + change.length - 1,
          color: CHANGE_COLORS.substitution.accent,
          layer: 'git-diff',
          style: 'solid',
          metadata: { type: 'mutation', old: change.oldBases, new: change.newBases },
        });
        break;
    }
  }

  return decorations;
}
