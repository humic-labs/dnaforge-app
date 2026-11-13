import {
  toUserMessage,
  renderUserMessage,
  withUserMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { parseWorkspacePath, validateMaterializedTree } from '@waypoint/workspace-revisions';
import type { HostedManifestFile } from './api';
import {
  downloadHostedRecoveryFile,
  listHostedRecoveryCandidates,
  loadHostedRecoveryCandidate,
  type HostedRecoveryCandidate,
  type HostedRecoveryDetail,
} from './recovery-api';

export function HostedRecoveryPanel({
  workspaceId,
  accountId,
}: {
  workspaceId: string;
  accountId: string;
}) {
  return (
    <RecoveryCandidates
      key={JSON.stringify([accountId, workspaceId])}
      workspaceId={workspaceId}
      accountId={accountId}
    />
  );
}

function RecoveryCandidates({
  workspaceId,
  accountId,
}: {
  workspaceId: string;
  accountId: string;
}) {
  const [candidates, setCandidates] = useState<readonly HostedRecoveryCandidate[]>([]);
  const [detail, setDetail] = useState<HostedRecoveryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<UserMessage | null>(null);
  const [message, setMessage] = useState<UserMessage | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const detailRequest = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void listHostedRecoveryCandidates(workspaceId, accountId)
      .then((result) => {
        if (!current) return;
        if (!Array.isArray(result.candidates)) throw new Error('The recovery list was invalid.');
        setCandidates(
          result.candidates.filter((candidate) => unexpired(candidate, accountId, Date.now()))
        );
        setNow(Date.now());
      })
      .catch((cause: unknown) => {
        if (current) setError(toUserMessage(cause, 'recovery.failed'));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [accountId, workspaceId, refresh]);

  useEffect(() => {
    const expiries = candidates
      .map((candidate) => Date.parse(candidate.expiresAt))
      .filter((expiry) => expiry > now);
    if (!expiries.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(1, Math.min(...expiries) - Date.now() + 1))
    );
    return () => clearTimeout(timer);
  }, [candidates, now]);

  async function inspect(candidate: HostedRecoveryCandidate) {
    const request = ++detailRequest.current;
    setInspecting(candidate.id);
    setDetail(null);
    setError(null);
    setMessage(null);
    try {
      const loaded = await loadHostedRecoveryCandidate(workspaceId, candidate.id, accountId);
      if (!alive.current || request !== detailRequest.current) return;
      if (
        loaded.workspaceId !== workspaceId ||
        loaded.candidate.id !== candidate.id ||
        !unexpired(loaded.candidate, accountId, Date.now())
      )
        throw withUserMessage(
          new Error('This recovery capture is no longer available to the active account.'),
          'recovery.accountUnavailable'
        );
      validateFiles(loaded);
      setDetail(loaded);
    } catch (cause) {
      if (alive.current && request === detailRequest.current)
        setError(toUserMessage(cause, 'recovery.failed'));
    } finally {
      if (alive.current && request === detailRequest.current) setInspecting(null);
    }
  }

  async function download(saved: HostedRecoveryDetail, file: HostedManifestFile) {
    setDownloading(file.path);
    setError(null);
    setMessage(null);
    try {
      if (!unexpired(saved.candidate, accountId, Date.now()))
        throw withUserMessage(new Error('This recovery capture has expired.'), 'recovery.expired');
      const bytes = await downloadHostedRecoveryFile(saved, file, accountId);
      if (!alive.current || !unexpired(saved.candidate, accountId, Date.now())) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' })
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.path.split('/').pop()!;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setMessage(
        userMessageWithValues('recovery.downloadStarted', { file: userMessageValue(file.path) })
      );
    } catch (cause) {
      if (alive.current) setError(toUserMessage(cause, 'recovery.failed'));
    } finally {
      if (alive.current) setDownloading(null);
    }
  }

  const retained = candidates.filter((candidate) => unexpired(candidate, accountId, now));
  const visibleDetail = detail && unexpired(detail.candidate, accountId, now) ? detail : null;
  return (
    <section aria-labelledby="hosted-recovery-heading" data-testid="hosted-recovery-panel">
      <h3 id="hosted-recovery-heading">Private recovery captures</h3>
      <p className="hosted-history-empty">
        These are temporary retained files, not accepted revisions. They may contain invalid
        packages. Only your account can access them; they normally expire after seven days.
      </p>
      <button
        type="button"
        className="hosted-text-button"
        onClick={() => setRefresh((value) => value + 1)}
        disabled={loading}
      >
        Refresh recovery captures
      </button>
      {error ? (
        <p className="hosted-history-empty" role="alert">
          {renderUserMessage(error)}
        </p>
      ) : null}
      {message ? (
        <p className="hosted-history-empty" role="status">
          {message}
        </p>
      ) : null}
      {loading ? (
        <p className="hosted-history-empty">Loading recovery captures…</p>
      ) : retained.length === 0 ? (
        <p className="hosted-history-empty">
          No unexpired recovery captures are available for this account and project.
        </p>
      ) : (
        <ul className="hosted-history-list">
          {retained.map((candidate) => (
            <li key={candidate.id} data-candidate-id={candidate.id}>
              <div>
                <strong>
                  {candidate.coverage === 'incomplete'
                    ? 'Incomplete capture'
                    : 'Captured files retained'}
                </strong>
                <span>
                  Saved {new Date(candidate.createdAt).toLocaleString()}; expires{' '}
                  {new Date(candidate.expiresAt).toLocaleString()}.
                </span>
                <span>
                  {candidate.coverage === 'incomplete'
                    ? 'Some files were absent or excluded.'
                    : 'File retention does not establish package validity.'}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Inspect recovery capture ${candidate.id}`}
                disabled={!!downloading}
                onClick={() => void inspect(candidate)}
              >
                {inspecting === candidate.id ? 'Loading…' : 'Inspect files'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {visibleDetail ? (
        <div data-testid="hosted-recovery-detail">
          <p className="hosted-history-empty">
            Downloads do not restore or publish this project. Save the files separately and inspect
            the package before importing any copy.
          </p>
          {visibleDetail.missingPaths.length ? (
            <>
              <strong>Missing or excluded required files</strong>
              <ul>
                {visibleDetail.missingPaths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          ) : null}
          <ul className="hosted-history-list">
            {visibleDetail.manifest.files.map((file) => (
              <li key={file.path}>
                <div>
                  <strong>{file.path}</strong>
                  <span>
                    {file.sizeBytes.toLocaleString()} bytes · SHA-256{' '}
                    {file.contentSha256.slice(0, 16)}…
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Download ${file.path}`}
                  disabled={!!downloading}
                  onClick={() => void download(visibleDetail, file)}
                >
                  {downloading === file.path ? 'Verifying…' : 'Download file'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function unexpired(candidate: HostedRecoveryCandidate, accountId: string, now: number): boolean {
  return (
    !!candidate &&
    !!candidate.id &&
    candidate.accountId === accountId &&
    (candidate.coverage === 'captured-bytes' || candidate.coverage === 'incomplete') &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    Date.parse(candidate.expiresAt) > now
  );
}

function validateFiles(detail: HostedRecoveryDetail) {
  if (!Array.isArray(detail.manifest?.files) || !Array.isArray(detail.missingPaths))
    throw new Error('The recovery capture was invalid.');
  const entries = detail.manifest.files.map((file) => {
    const path = parseWorkspacePath(file.path);
    if (
      !path.ok ||
      path.value !== file.path ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.contentSha256)
    )
      throw new Error('The recovery file metadata was invalid.');
    return { path: path.value, kind: 'file' as const, owner: file.path };
  });
  if (
    !validateMaterializedTree(entries).ok ||
    detail.missingPaths.some((path) => typeof path !== 'string')
  )
    throw new Error('The recovery capture contains ambiguous file paths.');
}
