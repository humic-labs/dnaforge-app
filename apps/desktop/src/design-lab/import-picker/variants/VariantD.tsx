import { useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import {
  CONFIRMED_ENTITY_TYPES,
  ENTITY_ACTIONS,
  PROJECT_IMPORT_ACTIONS,
  type ConfirmedEntityType,
  type EntityAction,
  type ImportPickerVariantProps,
  type ProjectImportAction,
} from '../model';
import {
  ClosePickerButton,
  EntityTypeGlyph,
  ProjectActionGlyph,
  PrototypeSurface,
} from '../shared';

type CommandResult =
  | { key: string; kind: 'type'; type: ConfirmedEntityType }
  | { key: string; kind: 'entity-action'; action: EntityAction }
  | { key: string; kind: 'project-action'; action: ProjectImportAction };

function commandKey(value: string): string {
  return value.toLowerCase().replace(/ /g, '-');
}

export function VariantD({ onRequestClose }: ImportPickerVariantProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedType, setSelectedType] = useState<ConfirmedEntityType | null>(null);
  const [selectedCommandKey, setSelectedCommandKey] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const primaryResults = useMemo<CommandResult[]>(() => {
    if (selectedType) {
      return ENTITY_ACTIONS.filter((action) => action.toLowerCase().includes(normalizedQuery)).map(
        (action) => ({
          key: `entity-action-${commandKey(action)}`,
          kind: 'entity-action',
          action,
        })
      );
    }

    return CONFIRMED_ENTITY_TYPES.filter((type) =>
      type.label.toLowerCase().includes(normalizedQuery)
    ).map((type) => ({ key: `type-${type.id}`, kind: 'type', type }));
  }, [normalizedQuery, selectedType]);

  const projectResults = useMemo<CommandResult[]>(
    () =>
      PROJECT_IMPORT_ACTIONS.map((action) => ({
        key: `project-${commandKey(action)}`,
        kind: 'project-action' as const,
        action,
      })),
    []
  );
  const visibleResults = [...primaryResults, ...projectResults];

  const runResult = (result: CommandResult): void => {
    if (result.kind === 'type') {
      setSelectedType(result.type);
      setSelectedCommandKey(null);
      setQuery('');
      setActiveIndex(0);
      return;
    }

    if (result.kind === 'entity-action' && selectedType) {
      setSelectedCommandKey(result.key);
      return;
    }

    if (result.kind === 'project-action') {
      setSelectedCommandKey(result.key);
    }
  };

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % visibleResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + visibleResults.length) % visibleResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = visibleResults[activeIndex];
      if (result) runResult(result);
    } else if (event.key === 'Escape' && selectedType) {
      event.preventDefault();
      setSelectedType(null);
      setQuery('');
      setActiveIndex(0);
    }
  };

  const resultIndex = (key: string): number =>
    visibleResults.findIndex((result) => result.key === key);

  return (
    <PrototypeSurface
      label="Command Deck"
      className="absolute left-[264px] top-[47px] z-20 flex min-h-[500px] w-[620px] flex-col border border-[#315069] bg-[#07111f] font-mono text-[#d9eee8] shadow-2xl"
    >
      <header className="flex h-12 items-center justify-between border-b border-[#315069] px-4">
        <div className="flex items-center gap-3 text-sm font-bold tracking-[0.12em]">
          <span className="text-[#b9ff66]" aria-hidden="true">
            &gt;
          </span>
          <span>ADD</span>
        </div>
        <ClosePickerButton onClick={onRequestClose} className="text-[#d9eee8]" />
      </header>

      <div className="border-b border-[#315069] p-3">
        <label className="flex h-11 items-center border border-[#4d718b] bg-[#0b1a2b] px-3 focus-within:border-[#b9ff66]">
          <span className="mr-2 text-[#b9ff66]" aria-hidden="true">
            /
          </span>
          <input
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            aria-label="Search commands"
            aria-activedescendant={visibleResults[activeIndex]?.key}
            placeholder={selectedType ? 'filter actions' : 'search commands'}
            className="min-w-0 flex-1 bg-transparent text-sm text-[#f3fffb] outline-none placeholder:text-[#70899b]"
          />
          <span className="border-l border-[#315069] pl-3 text-[10px] text-[#8eacb9]">
            ↑↓ ENTER
          </span>
        </label>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_238px]">
        <div className="min-h-0 border-r border-[#315069]">
          {selectedType ? (
            <div className="border-b border-[#315069] bg-[#0b1a2b] px-3 py-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedType(null);
                  setQuery('');
                  setActiveIndex(0);
                }}
                className="mb-2 text-[11px] font-bold text-[#b9ff66] hover:underline focus-visible:outline-none focus-visible:underline"
              >
                ← ALL COMMANDS
              </button>
              <div className="flex items-center gap-2 text-sm font-bold">
                <EntityTypeGlyph type={selectedType} className="h-5 w-5" />
                <span>{selectedType.label}</span>
              </div>
            </div>
          ) : (
            <div className="border-b border-[#315069] px-3 py-2 text-[10px] font-bold tracking-[0.18em] text-[#8eacb9]">
              ENTITY COMMANDS
            </div>
          )}

          <div aria-label={selectedType ? `${selectedType.label} actions` : 'Entity types'}>
            {primaryResults.map((result) => {
              const index = resultIndex(result.key);
              const active = index === activeIndex;
              const selected = result.key === selectedCommandKey;

              return (
                <button
                  id={result.key}
                  key={result.key}
                  type="button"
                  aria-pressed={selected}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => runResult(result)}
                  className={`flex h-12 w-full items-center gap-3 border-b border-l-4 border-b-[#1b3448] px-3 text-left text-sm font-bold focus-visible:outline-none ${
                    active
                      ? 'border-l-[#b9ff66] bg-[#b9ff66] text-[#07111f]'
                      : selected
                        ? 'border-l-[#b9ff66] bg-[#173247] text-[#f3fffb]'
                        : 'border-l-transparent bg-[#07111f] text-[#d9eee8] hover:bg-[#10263a]'
                  }`}
                >
                  {result.kind === 'type' ? (
                    <>
                      <EntityTypeGlyph type={result.type} className="h-5 w-5" />
                      <span>{result.type.label}</span>
                    </>
                  ) : result.kind === 'entity-action' ? (
                    <>
                      <span className="w-5 text-center text-[#75d7ff]" aria-hidden="true">
                        ›
                      </span>
                      <span>{result.action}</span>
                    </>
                  ) : null}
                </button>
              );
            })}
            {primaryResults.length === 0 && (
              <div className="px-3 py-5 text-xs text-[#70899b]">NO MATCHING COMMAND</div>
            )}
          </div>
        </div>

        <section aria-label="Project-scale actions" className="bg-[#0b1a2b]">
          <h2 className="border-b border-[#315069] px-3 py-2 text-[10px] font-bold tracking-[0.14em] text-[#b9ff66]">
            Project-scale actions
          </h2>
          {projectResults.map((result) => {
            if (result.kind !== 'project-action') return null;
            const index = resultIndex(result.key);
            const active = index === activeIndex;
            const selected = result.key === selectedCommandKey;

            return (
              <button
                id={result.key}
                key={result.key}
                type="button"
                aria-pressed={selected}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => runResult(result)}
                className={`flex min-h-14 w-full items-center gap-3 border-b border-l-4 border-b-[#315069] px-3 text-left text-xs font-bold leading-4 focus-visible:outline-none ${
                  active
                    ? 'border-l-[#b9ff66] bg-[#b9ff66] text-[#07111f]'
                    : selected
                      ? 'border-l-[#b9ff66] bg-[#173247] text-[#f3fffb]'
                      : 'border-l-transparent text-[#d9eee8] hover:bg-[#10263a]'
                }`}
              >
                <ProjectActionGlyph action={result.action} className="h-4 w-4" />
                <span>{result.action}</span>
              </button>
            );
          })}
        </section>
      </div>
    </PrototypeSurface>
  );
}
