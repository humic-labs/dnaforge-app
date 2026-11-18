'use client';

import {
  userMessageWithValues,
  userMessageValue,
  userMessage,
  toUserMessage,
} from '@waypoint/user-messages';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Structure3dSource, Structure3dAttrs } from '../types';
import { SOURCE_CONFIGS, SOURCE_ORDER } from '../types';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import { validateAlphaFoldId, validateRcsbId } from '../api/structure-service-client';

interface InlineSearchProps {
  attrs: Structure3dAttrs;
  onUpdateAttrs: (attrs: Structure3dAttrs) => void;
  onFileData?: (data: string, fileName: string) => void;
  isEditing?: boolean;
  originalAttrs?: Structure3dAttrs;
  onCancelEdit?: () => void;
}

type Stage = 'source' | 'input';

export function InlineSearch({
  attrs,
  onUpdateAttrs,
  onFileData,
  isEditing = false,
  originalAttrs,
  onCancelEdit,
}: InlineSearchProps) {
  const [stage, setStage] = useState<Stage>(attrs.source ? 'input' : 'source');
  const [inputValue, setInputValue] = useState('');
  const [selectedSource, setSelectedSource] = useState<Structure3dSource | null>(
    attrs.source || null
  );
  const [suggestion, setSuggestion] = useState<Structure3dSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [currentIdBadge, setCurrentIdBadge] = useState<string | null>(
    isEditing && originalAttrs?.sourceId ? originalAttrs.sourceId : null
  );

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && originalAttrs?.sourceId) {
      setCurrentIdBadge(originalAttrs.sourceId);
      setSelectedSource(originalAttrs.source || null);
      setStage('input');
    }
  }, [isEditing, originalAttrs]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.activeElement === previousFocus) safeFocus(inputRef.current);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  useEffect(() => {
    if (stage !== 'source') {
      setSuggestion(null);
      return;
    }

    const input = inputValue.toLowerCase().trim();
    if (!input) {
      setSuggestion(null);
      return;
    }

    const match = SOURCE_ORDER.find((s) => {
      const config = SOURCE_CONFIGS[s];
      return (
        config.label.toLowerCase().startsWith(input) ||
        config.shortLabel.toLowerCase().startsWith(input) ||
        s.startsWith(input)
      );
    });

    setSuggestion(match || null);
  }, [inputValue, stage]);

  const handleSourceSelect = useCallback((source: Structure3dSource) => {
    setSelectedSource(source);
    setStage('input');
    setInputValue('');
    setError(null);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!selectedSource || !inputValue.trim()) return;

    const config = SOURCE_CONFIGS[selectedSource];
    const value = inputValue.trim();

    if (!config.validate(value)) {
      setError(
        userMessageWithValues('structure.invalidIdentifier', {
          source: userMessageValue(config.label),
        })
      );
      return;
    }

    const sourceId = value.toUpperCase();
    setIsLoading(true);
    setError(null);

    try {
      if (selectedSource === 'pdb') {
        const result = await validateRcsbId(sourceId);
        if (!result.valid) {
          setError(
            userMessageWithValues('structure.pdbMissing', { id: userMessageValue(sourceId) })
          );
          setIsLoading(false);
          return;
        }
        onUpdateAttrs({
          ...attrs,
          source: selectedSource,
          sourceId,
          pdbId: sourceId,
          label: sourceId,
          title: result.metadata?.title,
          description: result.metadata?.description,
          organism: result.metadata?.organism,
          resolution: result.metadata?.resolution,
          method: result.metadata?.method,
        });
      } else if (selectedSource === 'alphafold') {
        const result = await validateAlphaFoldId(sourceId);
        if (!result.valid) {
          setError(
            userMessageWithValues('structure.alphaFoldMissing', { id: userMessageValue(sourceId) })
          );
          setIsLoading(false);
          return;
        }
        onUpdateAttrs({
          ...attrs,
          source: selectedSource,
          sourceId: result.providerIdentityKey ?? sourceId,
          providerIdentityKey: result.providerIdentityKey,
          uniprotId: sourceId,
          accession: sourceId,
          fragment: result.fragment ?? 'F1',
          version: result.latestVersion !== undefined ? `V${result.latestVersion}` : undefined,
          modelId: result.modelId,
          label: sourceId,
          title: result.metadata?.title,
          description: result.metadata?.description,
          organism: result.metadata?.organism,
        });
      } else {
        onUpdateAttrs({
          ...attrs,
          source: selectedSource,
          sourceId: value,
          label: value,
        });
      }
    } catch (e) {
      setError(userMessage('failure.failed-to-validate-id-please-try-again'));
    } finally {
      setIsLoading(false);
    }
  }, [selectedSource, inputValue, attrs, onUpdateAttrs]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (stage === 'source') {
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          if (suggestion) {
            handleSourceSelect(suggestion);
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (suggestion) {
            handleSourceSelect(suggestion);
          }
        }
      } else if (stage === 'input') {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          handleLoad();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (isEditing && onCancelEdit) {
            onCancelEdit();
          } else {
            setStage('source');
            setSelectedSource(null);
            setInputValue('');
            setError(null);
            setCurrentIdBadge(null);
          }
        } else if (e.key === 'Backspace' && !inputValue) {
          e.preventDefault();
          e.stopPropagation();
          if (currentIdBadge) {
            setCurrentIdBadge(null);
          } else {
            setStage('source');
            setSelectedSource(null);
            setInputValue('');
            setError(null);
          }
        }
      }
    },
    [
      stage,
      suggestion,
      inputValue,
      currentIdBadge,
      isEditing,
      onCancelEdit,
      handleSourceSelect,
      handleLoad,
    ]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const file = e.dataTransfer.files[0];
      if (!file) return;

      const validExtensions = ['.pdb', '.cif', '.mmcif', '.ent'];
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
      if (!validExtensions.includes(ext)) {
        setError(userMessage('failure.file-must-be-pdb-or-cif-format'));
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        if (content && onFileData) {
          onFileData(content, file.name);
        } else if (content) {
          onUpdateAttrs({
            ...attrs,
            source: 'file',
            sourceId: content,
            label: file.name,
          });
        }
      };
      reader.onerror = () => {
        setError(userMessage('failure.failed-to-read-file'));
      };
      reader.readAsText(file);
    },
    [attrs, onUpdateAttrs, onFileData]
  );

  const getPlaceholder = () => {
    if (stage === 'source') {
      return 'pdb, alphafold, url, file';
    }
    if (selectedSource) {
      return SOURCE_CONFIGS[selectedSource].placeholder;
    }
    return '';
  };

  const renderGhostText = () => {
    if (stage !== 'source' || !suggestion || !inputValue) return null;

    const suggestionLabel = SOURCE_CONFIGS[suggestion].label.toLowerCase();
    const inputLower = inputValue.toLowerCase();

    if (!suggestionLabel.startsWith(inputLower)) return null;

    const remaining = suggestionLabel.slice(inputLower.length);
    return (
      <span className="text-fg-muted/50 pointer-events-none">
        {remaining}
        <span className="text-fg-muted/30 text-xs ml-2">Tab</span>
      </span>
    );
  };

  return (
    <div
      className={`relative ${isDragOver ? 'ring-2 ring-accent' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {}
      <div className="flex items-center gap-2">
        {stage === 'input' && selectedSource && (
          <button
            onClick={() => {
              setStage('source');
              setSelectedSource(null);
              setInputValue('');
              setError(null);
              setCurrentIdBadge(null);
            }}
            className={`px-2 py-0.5 rounded text-xs font-medium ${SOURCE_CONFIGS[selectedSource].badgeColor} hover:opacity-80 transition-opacity flex items-center gap-1 shrink-0`}
          >
            {SOURCE_CONFIGS[selectedSource].label}
            <span className="text-current/50">x</span>
          </button>
        )}

        {}
        {stage === 'input' && currentIdBadge && (
          <button
            onClick={() => setCurrentIdBadge(null)}
            className="px-2 py-0.5 rounded text-xs font-mono bg-bg-muted text-fg wp-interactive transition-colors flex items-center gap-1 shrink-0"
            title="Backspace to clear"
          >
            {currentIdBadge}
            <span className="text-fg-muted/50">x</span>
          </button>
        )}

        {}
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder()}
            className="w-full bg-transparent text-sm outline-none placeholder:text-fg-muted/50"
            autoComplete="off"
            spellCheck={false}
          />
          {}
          {stage === 'source' && suggestion && inputValue && (
            <div className="absolute inset-0 flex items-center pointer-events-none text-sm">
              <span className="invisible">{inputValue}</span>
              {renderGhostText()}
            </div>
          )}
        </div>

        {}
        {stage === 'input' && inputValue && !currentIdBadge && (
          <button
            onClick={handleLoad}
            className="px-2 py-0.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors shrink-0"
          >
            Load
          </button>
        )}

        {}
        {isEditing && onCancelEdit && (
          <button
            onClick={onCancelEdit}
            className="px-2 py-0.5 text-xs text-fg-muted wp-interactive border border-border rounded transition-colors shrink-0"
          >
            Cancel
          </button>
        )}
      </div>

      {}
      {isLoading && <div className="text-xs text-fg-muted mt-1">Validating ID...</div>}

      {}
      {error && (
        <div className="text-xs text-error mt-1">{toUserMessage(error, 'structure.failed')}</div>
      )}

      {}
      {isDragOver && (
        <div className="absolute inset-0 bg-accent/10 rounded flex items-center justify-center">
          <span className="text-sm text-accent font-medium">Drop structure file</span>
        </div>
      )}
    </div>
  );
}
