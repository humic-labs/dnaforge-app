import { Notice } from '../../components/ui';
import { parseScientificDocument } from './model';
export function FrozenProtocolDefinition({ raw }: { raw: Record<string, unknown> }) {
  const frozen = raw.frozenProtocol as { source?: { originalText?: unknown } } | undefined;
  if (!frozen)
    return (
      <Notice>
        The source supplied a protocol version. A saved copy of its definition was not recorded.
      </Notice>
    );
  if (typeof frozen.source?.originalText !== 'string')
    return <Notice tone="error">The saved protocol definition is unavailable.</Notice>;
  const definition = parseScientificDocument(
    'saved.dnaforge-protocol.json',
    frozen.source.originalText
  );
  if (definition.kind !== 'protocol')
    return <Notice tone="error">The saved definition is not a Protocol.</Notice>;
  return (
    <section className="space-y-3" aria-label="Protocol used">
      <h3 className="font-semibold">Protocol used</h3>
      <p className="text-xs">Saved for this run. Later protocol edits leave this copy unchanged.</p>
      <div className="space-y-3" data-testid="run-frozen-protocol">
        <h4 className="font-semibold">{definition.title}</h4>
        {definition.steps.map((step) => (
          <section key={step.id}>
            <h5 className="text-sm font-medium">
              {step.ordinal}. {step.title}
            </h5>
            <p className="whitespace-pre-wrap text-sm">{step.content.text}</p>
          </section>
        ))}
      </div>
    </section>
  );
}
