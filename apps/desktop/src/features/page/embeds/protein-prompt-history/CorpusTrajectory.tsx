import type { ProteinCorpusLedger } from './corpus-ledger';

export function ProteinCorpusTrajectory({
  ledger,
  onExport,
}: {
  ledger: ProteinCorpusLedger;
  onExport: () => void;
}) {
  return (
    <details
      data-testid="protein-corpus-trajectory"
      className="mt-2 rounded border border-border p-2 text-xs"
    >
      <summary className="cursor-pointer font-medium text-accent">
        Corpus trajectory · {ledger.versions.length} recorded variants ·{' '}
        {ledger.distinctGuidanceBodies} guidance bodies · {ledger.attempts.length} attempts
      </summary>
      <p className="mt-2 text-fg-muted">
        Saved means a view exists, not that it is scientifically or visually good. Reviews count
        linked feedback; only explicit assessments count as judgments. A run meets the question only
        when every saved output is marked acceptable. Technical recoveries retain their failed
        attempts.
      </p>
      {ledger.incompleteStarts.length > 0 && (
        <p role="status" className="mt-1 font-medium text-error">
          {ledger.incompleteStarts.length} started trials have no result record.
        </p>
      )}
      <div className="mt-2 overflow-x-auto">
        <table
          aria-label="Protein corpus trajectory"
          className="min-w-[700px] border-collapse text-left"
        >
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="pr-3 pb-1">
                Version
              </th>
              <th scope="col" className="pr-3 pb-1">
                Cases
              </th>
              <th scope="col" className="pr-3 pb-1">
                Attempts / slots
              </th>
              <th scope="col" className="pr-3 pb-1">
                Starts without result
              </th>
              <th scope="col" className="pr-3 pb-1">
                Saved slots
              </th>
              <th scope="col" className="pr-3 pb-1">
                Failed / noncomparable
              </th>
              <th scope="col" className="pr-3 pb-1">
                Recovered
              </th>
              <th scope="col" className="pr-3 pb-1">
                Reviewed / unreviewed
              </th>
              <th scope="col" className="pr-3 pb-1">
                Meets / needs / uncertain / unknown
              </th>
              <th scope="col" className="pr-3 pb-1">
                Base / profile / agent
              </th>
              <th scope="col" className="pb-1">
                Exact prompts
              </th>
            </tr>
          </thead>
          <tbody>
            {ledger.versions.map((version) => (
              <tr key={version.key} className="border-b border-border align-top">
                <th scope="row" className="py-1 pr-3 font-medium">
                  <details>
                    <summary className="cursor-pointer text-accent">{version.label}</summary>
                    <ul className="mt-1 space-y-0.5 text-fg-muted">
                      {version.cases.map((item) => (
                        <li key={item.caseId}>
                          {item.caseId}: {item.renderedSlots}/{item.slots} saved ·{' '}
                          {item.reviewedRenderedSlots} reviewed · {item.acceptableRenderedSlots}/
                          {item.needsWorkRenderedSlots}/{item.uncertainRenderedSlots}/
                          {item.unassessedRenderedSlots} judgments · {item.attempts} attempts ·{' '}
                          {item.startsWithoutResult} starts without result
                        </li>
                      ))}
                    </ul>
                  </details>
                  {version.labels.length > 1 && (
                    <span className="block font-normal text-fg-muted">
                      Also recorded as {version.labels.slice(1).join(', ')}
                    </span>
                  )}
                  {version.sameGuidanceAs.length > 0 && (
                    <span className="block font-normal text-fg-muted">
                      Same guidance as {version.sameGuidanceAs.join(', ')}; separate recorded cohort
                    </span>
                  )}
                  <time
                    className="block font-normal text-fg-muted"
                    dateTime={new Date(version.firstRecordedAt).toISOString()}
                  >
                    {new Date(version.firstRecordedAt).toLocaleDateString()}
                  </time>
                </th>
                <td className="py-1 pr-3">{version.cases.length}</td>
                <td className="py-1 pr-3">
                  {version.attempts} / {version.slots}
                </td>
                <td className="py-1 pr-3">{version.startsWithoutResult}</td>
                <td className="py-1 pr-3">{version.renderedSlots}</td>
                <td className="py-1 pr-3">
                  {version.failedSlots} / {version.noncomparableSlots}
                </td>
                <td className="py-1 pr-3">{version.recoveredSlots}</td>
                <td className="py-1 pr-3">
                  {version.reviewedRenderedSlots} / {version.unreviewedRenderedSlots}
                </td>
                <td className="py-1 pr-3">
                  {version.acceptableRenderedSlots} / {version.needsWorkRenderedSlots} /{' '}
                  {version.uncertainRenderedSlots} / {version.unassessedRenderedSlots}
                </td>
                <td
                  className="py-1 pr-3"
                  title="Distinct captured app prompt prefixes, render profiles, and agent configurations; zero means unknown, and values above one signal a mixed comparison"
                >
                  {version.basePromptPrefixes} / {version.renderProfiles} /{' '}
                  {version.agentConfigurations}
                </td>
                <td className="py-1">
                  {version.capturedPromptAttempts}/{version.attempts}
                  {version.missingPromptAttempts > 0 && (
                    <span className="ml-1 text-error">
                      ({version.missingPromptAttempts} missing)
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={onExport}
        className="mt-2 rounded border border-border px-2 py-1 text-accent wp-interactive"
      >
        Download trial records JSON
      </button>
    </details>
  );
}
