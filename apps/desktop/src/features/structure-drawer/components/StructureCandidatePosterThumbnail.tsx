import { userMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import type { StructureCandidate } from '../types/structure-drawer';
import {
  isStructureCandidatePosterCapacityError,
  loadStructureCandidatePosterObjectUrl,
  resolveStructureCandidatePosterBaseUrl,
  structureCandidatePosterAsset,
} from './structure-candidate-poster';
import type { StructureCandidatePosterLease } from './structure-candidate-poster';

export function StructureCandidatePosterThumbnail({
  candidate,
}: {
  candidate: StructureCandidate;
}) {
  const { asset, hasPosterAsset, imageUrl, loadingImage, posterError } =
    useStructureCandidatePoster(candidate);
  if (!hasPosterAsset) return null;

  const loaded = Boolean(imageUrl && asset);
  return (
    <span
      data-testid="structure-candidate-poster-thumb"
      data-candidate-id={candidate.id}
      data-provider={candidate.provider}
      data-poster-status={loaded ? 'loaded' : loadingImage ? 'loading' : 'unavailable'}
      data-poster-error={posterError ?? undefined}
      data-poster-primary-url={asset?.primaryUrl}
      data-poster-primary-source-url={asset?.primarySourceUrl}
      className="relative flex h-[78px] w-[78px] aspect-square shrink-0 self-start overflow-hidden bg-bg-subtle"
      aria-hidden="true"
    >
      {loaded ? (
        <img
          data-testid="structure-candidate-poster-image"
          src={imageUrl!}
          data-poster-primary-url={asset!.primaryUrl}
          data-poster-primary-source-url={asset!.primarySourceUrl}
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : (
        <span
          data-testid="structure-candidate-poster-placeholder"
          className={
            loadingImage
              ? 'flex h-full w-full items-center justify-center bg-bg-subtle'
              : 'flex h-full w-full items-center justify-center bg-bg-muted text-[10px] font-medium uppercase text-fg-muted'
          }
        >
          {loadingImage ? (
            <span
              data-testid="structure-candidate-poster-loading-spinner"
              className="h-5 w-5 rounded-full border-2 border-fg-muted/25 border-t-fg-muted motion-reduce:animate-none animate-spin"
            />
          ) : (
            'No image'
          )}
        </span>
      )}
    </span>
  );
}

function useStructureCandidatePoster(candidate: StructureCandidate) {
  const hasPosterAsset =
    (candidate.structure.kind === 'pdb' && candidate.structure.pdbId.trim().length > 0) ||
    (candidate.structure.kind === 'uniprot' && candidate.structure.accession.trim().length > 0);
  const [sidecarBaseUrl, setSidecarBaseUrl] = useState<string | null>(null);
  const [baseUrlUnavailable, setBaseUrlUnavailable] = useState(false);
  const asset = useMemo(
    () => (sidecarBaseUrl ? structureCandidatePosterAsset(candidate, sidecarBaseUrl) : null),
    [candidate, sidecarBaseUrl]
  );
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [posterError, setPosterError] = useState<string | null>(null);
  const [capacityRetryEpoch, setCapacityRetryEpoch] = useState(0);

  useEffect(() => {
    if (!hasPosterAsset) {
      setSidecarBaseUrl(null);
      setBaseUrlUnavailable(false);
      setPosterError(null);
      return;
    }
    let active = true;
    setBaseUrlUnavailable(false);
    setLoadingImage(true);
    setPosterError(null);
    void resolveStructureCandidatePosterBaseUrl()
      .then((url) => {
        if (active) setSidecarBaseUrl(url);
      })
      .catch(() => {
        if (active) {
          setBaseUrlUnavailable(true);
          setPosterError(userMessage('failure.sidecar-base-url-unavailable'));
        }
      });
    return () => {
      active = false;
    };
  }, [hasPosterAsset]);

  useEffect(() => {
    if (!asset) {
      setImageUrl(null);
      if (!hasPosterAsset || baseUrlUnavailable) setLoadingImage(false);
      return;
    }
    const abort = new AbortController();
    let posterLease: StructureCandidatePosterLease | null = null;
    let capacityRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    let capacityRetryScheduled = false;
    setLoadingImage(true);
    setImageUrl(null);
    setPosterError(null);
    void loadStructureCandidatePosterObjectUrl(asset, abort.signal)
      .then((lease) => {
        if (abort.signal.aborted) {
          lease?.release();
          return;
        }
        posterLease = lease;
        setImageUrl(lease?.objectUrl ?? null);
        setPosterError(lease ? null : userMessage('notice.poster-fetch-empty'));
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        if (isStructureCandidatePosterCapacityError(error)) {
          capacityRetryScheduled = true;
          setImageUrl(null);
          setPosterError(userMessage('failure.poster-capacity-wait'));
          capacityRetryTimeout = setTimeout(() => {
            if (!abort.signal.aborted) setCapacityRetryEpoch((epoch) => epoch + 1);
          }, 250);
        } else if ((error as Error).name !== 'AbortError') {
          setImageUrl(null);
          setPosterError(userMessage('failure.poster-fetch-error'));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted && !capacityRetryScheduled) setLoadingImage(false);
      });
    return () => {
      abort.abort();
      if (capacityRetryTimeout) clearTimeout(capacityRetryTimeout);
      posterLease?.release();
    };
  }, [asset, baseUrlUnavailable, capacityRetryEpoch, hasPosterAsset]);

  return { asset, hasPosterAsset, imageUrl, loadingImage, posterError };
}
