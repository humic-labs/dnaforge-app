import { XIcon, PaperclipIcon } from '../icons';
import { ChatEntityReferenceChip } from './ChatEntityReferenceChip';
import { FileTypeIcon } from '../icons/file-type-icon';
import { getFileIconCategory } from '../../utils/fileTypes';
import type { AgentAttachmentManifest } from '../../shared/agent-attachments';

export type AttachedFile = AgentAttachmentManifest;

interface FilePillProps {
  file: AttachedFile;
  onRemove?: () => void;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FilePill({ file, onRemove }: FilePillProps) {
  const phase = onRemove ? 'draft' : 'sent';
  return (
    <span title={`${file.name} (${formatSize(file.size)})`}>
      <ChatEntityReferenceChip
        entityType="file"
        label={file.name}
        preserveExtension
        attachmentPhase={phase}
        iconContext={{ path: file.name }}
        iconOverride={
          <FileTypeIcon
            category={getFileIconCategory(file.name)}
            path={file.name}
            className="h-3.5 w-3.5"
          />
        }
        endSlot={
          onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="entity-reference-chip__end entity-reference-chip__remove"
              aria-label={`Remove ${file.name}`}
            >
              <XIcon size={10} />
            </button>
          ) : (
            <span className="entity-reference-chip__end" aria-hidden="true">
              <PaperclipIcon size={11} />
            </span>
          )
        }
      />
    </span>
  );
}
