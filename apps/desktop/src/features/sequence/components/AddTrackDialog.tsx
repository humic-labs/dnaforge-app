import {
  toOptionalUserMessage,
  toUserMessage,
  userMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type {
  ScientificTrackKind,
  TrackAssetLocatorV1,
  TrackSourceAddressV1,
  UcscCatalogLeaf,
} from '@waypoint/genome-data';

import {
  GENOME_SOURCE_CREDENTIAL_V1,
  type GenomeSourceCredentialInput,
} from '../../../shared/genome-source-credentials';
import type { HostedReferenceUcscTrackTargetV1 } from '../../../shared/hosted-reference-ucsc-targets';
import type {
  RemoteAlignmentConnectRequestV1,
  RemoteEndpointProfileV1,
} from '../../../shared/remote-genomics-ipc';
import { CloseIcon, FilePlusIcon, SearchIcon } from '../../../components/icons';
import { Button, UI_FIELD_CLASS, UI_PROSE_WRAP_CLASS } from '../../../components/ui';
import { platform } from '../../../platform';
import { safeFocus } from '../../../shared/utils/safeFocus';
import {
  inspectUcscHub,
  listUcscPublicHubs,
  type UcscHubGenome,
  type UcscPublicHub,
} from '../ucsc-track-client';
import { searchUcscCatalog, subscribeUcscCatalog } from '../ucsc-catalog-store';
import {
  applyUcscCatalogFacets,
  computeUcscCatalogFacets,
  countSelectedFacets,
  toggleCatalogFacet,
  TRACK_KIND_FACET_KEY,
  type CatalogFacetGroup,
  type CatalogFacetSelection,
} from '../ucsc-catalog-facets';
import { CatalogTrackTable, type CatalogTrackFailure } from './CatalogTrackTable';
import { RemoteClusterPanel } from './RemoteClusterPanel';
import type { IndexedTrackImportNotice } from './useIndexedTrackImport';
import type { BamTrackImportNotice, BamTrackImportProgress } from './useBamTrackImport';

export { trackHeadline } from '../ucsc-catalog-table';

type AddDataTab = 'catalog' | 'files' | 'url' | 'hubs' | 'remote' | 'combine';

interface ConnectedHub {
  readonly hubUrl: string;
  readonly genome: string;
  readonly label: string;
}

interface PendingHub {
  readonly hubUrl: string;
  readonly label: string;
  readonly genomes: ReadonlyArray<UcscHubGenome>;
}

export interface NetworkTrackImportInput {
  readonly formatId?: Exclude<IndexedUrlFormat, 'auto'>;
  readonly source: TrackSourceAddressV1;
  readonly index?: TrackAssetLocatorV1;
  readonly scientificKind?: ScientificTrackKind;
  readonly label?: string;
}

export interface SignalReadPileupSourceOption {
  readonly trackId: string;
  readonly label: string;
}

export interface SignalReadPileupCompositionInput {
  readonly readsTrackId: string;
  readonly signalTrackId: string;
  readonly label?: string;
  readonly showSourceTracks: boolean;
}

const EMPTY_SIGNAL_READ_SOURCE_OPTIONS: readonly SignalReadPileupSourceOption[] = [];
const EMPTY_CATALOG_IDS: ReadonlySet<string> = new Set();

type IndexedUrlFormat = 'auto' | 'bigwig' | 'bigbed' | 'bam' | 'cram' | 'vcf' | 'bcf';
type HtsgetFormat = 'bam' | 'cram' | 'vcf' | 'bcf';
type BigBedScientificKind = 'transcript' | 'interval' | 'quantitative' | 'peak' | 'repeat';
type NetworkSourceProtocol = 'http' | 's3' | 'gcs' | 'htsget';
type CredentialMode =
  | 'none'
  | 'saved'
  | 'http-bearer'
  | 'http-basic'
  | 'http-header'
  | 'aws-sigv4'
  | 'gcs-oauth';

interface AddTrackDialogProps {
  readonly open: boolean;
  readonly assemblyDisplayName: string;
  readonly ucscTarget: HostedReferenceUcscTrackTargetV1 | null;
  readonly busy: string | null;
  readonly progress: BamTrackImportProgress | null;
  readonly notice: BamTrackImportNotice | null;
  readonly dataFileNotice: IndexedTrackImportNotice | null;
  readonly indexedBusy: string | null;
  readonly indexedNotice: IndexedTrackImportNotice | null;
  readonly recentRemoteEndpoints?: readonly RemoteEndpointProfileV1[];
  readonly onChooseDataFiles: () => void;
  readonly onImportDataFilePaths?: (paths: ReadonlyArray<string>) => Promise<void> | void;
  readonly onAddNetworkSource: (input: NetworkTrackImportInput) => Promise<void>;
  readonly onSaveCredential: (credential: GenomeSourceCredentialInput) => Promise<void>;
  readonly remoteVariantsAvailable: boolean;
  readonly onAddUcscTrack: (track: UcscCatalogLeaf) => Promise<'added' | 'duplicate'>;
  readonly presentCatalogIds?: ReadonlySet<string>;
  readonly onAddRemoteBam?: (request: RemoteAlignmentConnectRequestV1) => Promise<void>;
  readonly remoteConnecting?: boolean;
  readonly onCancelRemoteConnect?: () => void;
  readonly onRefreshRemoteEndpoints?: () => Promise<void>;
  readonly composableReadTracks?: readonly SignalReadPileupSourceOption[];
  readonly composableSignalTracks?: readonly SignalReadPileupSourceOption[];
  readonly onCreateSignalReadPileup?: (
    input: SignalReadPileupCompositionInput
  ) => 'added' | 'duplicate' | Promise<'added' | 'duplicate'>;
  readonly onClose: () => void;
}

export function AddTrackDialog({
  open,
  assemblyDisplayName,
  ucscTarget,
  busy,
  progress,
  notice,
  dataFileNotice,
  indexedBusy,
  indexedNotice,
  recentRemoteEndpoints = [],
  onChooseDataFiles,
  onImportDataFilePaths,
  onAddNetworkSource,
  onSaveCredential,
  remoteVariantsAvailable,
  onAddUcscTrack,
  presentCatalogIds = EMPTY_CATALOG_IDS,
  onAddRemoteBam,
  remoteConnecting = false,
  onCancelRemoteConnect,
  onRefreshRemoteEndpoints,
  composableReadTracks = EMPTY_SIGNAL_READ_SOURCE_OPTIONS,
  composableSignalTracks = EMPTY_SIGNAL_READ_SOURCE_OPTIONS,
  onCreateSignalReadPileup,
  onClose,
}: AddTrackDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const automaticSearchRef = useRef<AbortController | null>(null);
  const manualSearchGenerationRef = useRef(0);
  const [url, setUrl] = useState('');
  const [urlProtocol, setUrlProtocol] = useState<NetworkSourceProtocol>('http');
  const [urlLabel, setUrlLabel] = useState('');
  const [urlFormat, setUrlFormat] = useState<IndexedUrlFormat>('auto');
  const [urlIndex, setUrlIndex] = useState('');
  const [urlResourceId, setUrlResourceId] = useState('');
  const [cloudBucket, setCloudBucket] = useState('');
  const [cloudRegion, setCloudRegion] = useState('');
  const [s3RequesterPays, setS3RequesterPays] = useState(false);
  const [gcsBillingProject, setGcsBillingProject] = useState('');
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('none');
  const [authRef, setAuthRef] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [basicUsername, setBasicUsername] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [gcsAccessToken, setGcsAccessToken] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [bigBedScientificKind, setBigBedScientificKind] =
    useState<BigBedScientificKind>('interval');
  const [urlAdding, setUrlAdding] = useState(false);
  const [composeReadsTrackId, setComposeReadsTrackId] = useState('');
  const [composeSignalTrackId, setComposeSignalTrackId] = useState('');
  const [composeLabel, setComposeLabel] = useState('');
  const [composeShowSources, setComposeShowSources] = useState(true);
  const [composeAdding, setComposeAdding] = useState(false);
  const [composeNotice, setComposeNotice] = useState<IndexedTrackImportNotice | null>(null);
  const [query, setQuery] = useState('');
  const [sourceTab, setSourceTab] = useState<AddDataTab>('catalog');
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [facetSelection, setFacetSelection] = useState<CatalogFacetSelection>({});
  const [publicSearching, setPublicSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [rowFailures, setRowFailures] = useState<Readonly<Record<string, CatalogTrackFailure>>>({});
  const [publicTracks, setPublicTracks] = useState<ReadonlyArray<UcscCatalogLeaf>>([]);
  const [publicCatalogSize, setPublicCatalogSize] = useState<number | null>(null);
  const [publicCountsAreComplete, setPublicCountsAreComplete] = useState(true);
  const [confirmedCatalogIds, setConfirmedCatalogIds] =
    useState<ReadonlySet<string>>(EMPTY_CATALOG_IDS);
  const [membershipAnnouncement, setMembershipAnnouncement] = useState('');
  const [addingTrack, setAddingTrack] = useState<string | null>(null);
  const seenPresentCatalogIdsRef = useRef(presentCatalogIds);
  const [connectedHubs, setConnectedHubs] = useState<ReadonlyArray<ConnectedHub>>([]);
  const [catalogHubUrl, setCatalogHubUrl] = useState<string | null>(null);
  const [hubUrlInput, setHubUrlInput] = useState('');
  const [hubBusy, setHubBusy] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [pendingHub, setPendingHub] = useState<PendingHub | null>(null);
  const [pendingHubGenome, setPendingHubGenome] = useState('');
  const [publicHubs, setPublicHubs] = useState<ReadonlyArray<UcscPublicHub> | null>(null);
  const [publicHubsBusy, setPublicHubsBusy] = useState(false);
  const activeCatalog = useMemo<HostedReferenceUcscTrackTargetV1 | null>(() => {
    if (catalogHubUrl) {
      const hub = connectedHubs.find((candidate) => candidate.hubUrl === catalogHubUrl);
      if (hub) return { genomeId: hub.genome, hubUrl: hub.hubUrl };
    }
    return ucscTarget;
  }, [catalogHubUrl, connectedHubs, ucscTarget]);
  const listingConnectedHub = catalogHubUrl !== null && activeCatalog?.hubUrl === catalogHubUrl;
  const listingHub = listingConnectedHub || Boolean(activeCatalog?.hubUrl);
  useEffect(() => {
    const previouslyPresent = seenPresentCatalogIdsRef.current;
    seenPresentCatalogIdsRef.current = presentCatalogIds;
    setConfirmedCatalogIds((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set(current);
      for (const id of previouslyPresent) {
        if (!presentCatalogIds.has(id) && next.delete(id)) changed = true;
      }
      return changed ? next : current;
    });
  }, [presentCatalogIds]);
  useEffect(() => {
    if (!open) setMembershipAnnouncement('');
  }, [open]);
  const addedCatalogIds = useMemo(() => {
    if (confirmedCatalogIds.size === 0) return presentCatalogIds;
    const union = new Set(presentCatalogIds);
    for (const id of confirmedCatalogIds) union.add(id);
    return union;
  }, [confirmedCatalogIds, presentCatalogIds]);
  const noteTrackInView = useCallback((track: UcscCatalogLeaf) => {
    setConfirmedCatalogIds((current) => {
      if (current.has(track.catalogId)) return current;
      const next = new Set(current);
      next.add(track.catalogId);
      return next;
    });
    setMembershipAnnouncement(`${track.shortLabel} is in this view.`);
  }, []);
  const activeGenomeId = activeCatalog?.genomeId ?? null;
  const activeHubUrl = activeCatalog?.hubUrl ?? null;
  const visiblePublicHubs = useMemo(() => {
    if (!publicHubs) return null;
    if (!ucscTarget) return publicHubs;
    return publicHubs.filter((hub) => hub.genomes.includes(ucscTarget.genomeId));
  }, [publicHubs, ucscTarget]);

  const filteredPublicTracks = useMemo(
    () => applyUcscCatalogFacets(publicTracks, facetSelection),
    [facetSelection, publicTracks]
  );
  const facetGroups = useMemo(
    () => computeUcscCatalogFacets(publicTracks, facetSelection),
    [facetSelection, publicTracks]
  );
  const selectedFacetCount = countSelectedFacets(facetSelection);
  const activeFacetChips = useMemo(
    () =>
      facetGroups.flatMap((group) =>
        (facetSelection[group.key] ?? []).map((value) => ({
          key: group.key,
          value,
          groupLabel: group.label,
          label: group.values.find((entry) => entry.value === value)?.label ?? value,
        }))
      ),
    [facetGroups, facetSelection]
  );
  const catalogTabLabel = activeCatalog
    ? activeCatalog.hubUrl
      ? hubDisplayLabel(activeCatalog.hubUrl)
      : `UCSC ${activeCatalog.genomeId}`
    : 'Public catalog';

  useEffect(() => {
    if (!open) return;
    manualSearchGenerationRef.current += 1;
    safeFocus(dialogRef.current);
    setFacetSelection({});
    setUrlAdding(false);
    setComposeAdding(false);
    setComposeNotice(null);
    setComposeLabel('');
    setComposeShowSources(true);
    setSearchError(null);
    setUrlError(null);
    setMembershipAnnouncement('');
    setAddingTrack(null);
    setQuery('');
    return () => {
      manualSearchGenerationRef.current += 1;
      automaticSearchRef.current?.abort();
      automaticSearchRef.current = null;
    };
  }, [open, activeGenomeId, activeHubUrl, listingHub]);

  useEffect(() => {
    if (!open) return;
    setComposeReadsTrackId((current) =>
      composableReadTracks.some((track) => track.trackId === current)
        ? current
        : (composableReadTracks[0]?.trackId ?? '')
    );
    setComposeSignalTrackId((current) =>
      composableSignalTracks.some((track) => track.trackId === current)
        ? current
        : (composableSignalTracks[0]?.trackId ?? '')
    );
  }, [composableReadTracks, composableSignalTracks, open]);

  useEffect(() => {
    if (open) return;
    setPublicSearching(false);
    setPublicTracks([]);
    setPublicCatalogSize(null);
    setPublicCountsAreComplete(true);
  }, [open]);

  useEffect(() => {
    if (!open || !activeCatalog) return;
    const timer = setTimeout(() => {
      const generation = ++manualSearchGenerationRef.current;
      automaticSearchRef.current?.abort();
      const controller = new AbortController();
      automaticSearchRef.current = controller;
      setPublicSearching(true);
      void searchUcscCatalog(
        {
          genome: activeCatalog.genomeId,
          query,
          ...(activeCatalog.hubUrl ? { hubUrl: activeCatalog.hubUrl } : {}),
        },
        { signal: controller.signal }
      )
        .then((result) => {
          if (generation !== manualSearchGenerationRef.current) return;
          setFacetSelection({});
          setPublicTracks(result.tracks);
          setPublicCatalogSize(result.catalogSize);
          setPublicCountsAreComplete(result.complete);
          setSearchError(null);
        })
        .catch((error: unknown) => {
          if (generation !== manualSearchGenerationRef.current) return;
          if ((error as Error)?.name === 'AbortError') return;
          setPublicTracks([]);
          setPublicCatalogSize(null);
          setSearchError(trackFailureMessage(error));
        })
        .finally(() => {
          if (generation === manualSearchGenerationRef.current) setPublicSearching(false);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [open, query, activeCatalog]);

  useEffect(() => {
    if (!open || !activeCatalog) return;
    let active = true;
    const target = {
      genome: activeCatalog.genomeId,
      ...(activeCatalog.hubUrl ? { hubUrl: activeCatalog.hubUrl } : {}),
    };
    const unsubscribe = subscribeUcscCatalog(target, () => {
      void searchUcscCatalog({ ...target, query })
        .then((result) => {
          if (!active) return;
          setPublicTracks(result.tracks);
          setPublicCatalogSize(result.catalogSize);
          setPublicCountsAreComplete(result.complete);
          setSearchError(null);
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open, activeCatalog, query]);

  const selectCatalog = useCallback((hubUrl: string | null) => {
    setCatalogHubUrl(hubUrl);
    setPublicTracks([]);
    setFacetSelection({});
    setSearchError(null);
    setMembershipAnnouncement('');
  }, []);

  const handleFileDrop = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0 || !onImportDataFilePaths) return;
      const paths = files
        .map((file) => {
          try {
            return platform().workspace.getPathForFile(file);
          } catch {
            return '';
          }
        })
        .filter((path) => path.length > 0);
      if (paths.length > 0) void onImportDataFilePaths(paths);
    },
    [onImportDataFilePaths]
  );

  if (!open) return null;
  const waitingForManagedIndex = Boolean(busy && progress?.phase === 'checking-index');
  const closeBlocked = Boolean(
    (busy && !waitingForManagedIndex) || indexedBusy || urlAdding || composeAdding
  );
  const interactionBlocked = Boolean(
    busy || indexedBusy || urlAdding || composeAdding || addingTrack !== null
  );

  const selectSourceTab = (next: AddDataTab) => {
    setSourceTab(next);
    if (next === 'remote') void onRefreshRemoteEndpoints?.();
  };

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !activeCatalog ||
      (publicSearching && automaticSearchRef.current === null) ||
      addingTrack !== null
    ) {
      return;
    }
    automaticSearchRef.current?.abort();
    automaticSearchRef.current = null;
    const searchGeneration = ++manualSearchGenerationRef.current;
    setPublicSearching(true);
    setFacetSelection({});
    setSearchError(null);
    setMembershipAnnouncement('');
    try {
      const result = await searchUcscCatalog({
        genome: activeCatalog.genomeId,
        query,
        ...(activeCatalog.hubUrl ? { hubUrl: activeCatalog.hubUrl } : {}),
      });
      if (searchGeneration !== manualSearchGenerationRef.current) return;
      setPublicTracks(result.tracks);
      setPublicCatalogSize(result.catalogSize);
      setPublicCountsAreComplete(result.complete);
    } catch (error) {
      if (searchGeneration !== manualSearchGenerationRef.current) return;
      setPublicTracks([]);
      setPublicCatalogSize(null);
      setPublicCountsAreComplete(true);
      setSearchError(trackFailureMessage(error));
    } finally {
      if (searchGeneration === manualSearchGenerationRef.current) {
        setPublicSearching(false);
      }
    }
  };

  const adoptHub = (hub: ConnectedHub, browse = true) => {
    if (browse) setSourceTab('catalog');
    setConnectedHubs((current) => [
      ...current.filter((candidate) => candidate.hubUrl !== hub.hubUrl),
      hub,
    ]);
    setCatalogHubUrl(hub.hubUrl);
    setHubUrlInput('');
    setPendingHub(null);
    setPendingHubGenome('');
    setPublicTracks([]);
    setSearchError(null);
    setMembershipAnnouncement('');
  };

  const connectHub = async (hubUrl: string, label?: string, browse = true) => {
    const clean = hubUrl.trim();
    if (!clean || hubBusy) return;
    setHubBusy(true);
    setHubError(null);
    setPendingHub(null);
    try {
      const description = await inspectUcscHub(clean);
      const hubLabel = label?.trim() || hubDisplayLabel(description.hubUrl);
      const exact = ucscTarget
        ? description.genomes.find((genome) => genome.name === ucscTarget.genomeId)
        : undefined;
      const chosen = exact ?? (description.genomes.length === 1 ? description.genomes[0] : null);
      if (!chosen) {
        setPendingHub({
          hubUrl: description.hubUrl,
          label: hubLabel,
          genomes: description.genomes,
        });
        setPendingHubGenome(description.genomes[0]?.name ?? '');
        return;
      }
      adoptHub({ hubUrl: description.hubUrl, genome: chosen.name, label: hubLabel }, browse);
    } catch (error) {
      setHubError(trackFailureMessage(error));
    } finally {
      setHubBusy(false);
    }
  };

  const disconnectHub = (hubUrl: string) => {
    setConnectedHubs((current) => current.filter((candidate) => candidate.hubUrl !== hubUrl));
    if (catalogHubUrl === hubUrl) {
      setCatalogHubUrl(null);
      setPublicTracks([]);
    }
  };

  const browsePublicHubs = async () => {
    if (publicHubsBusy) return;
    setPublicHubsBusy(true);
    setHubError(null);
    try {
      setPublicHubs(await listUcscPublicHubs());
    } catch (error) {
      setHubError(trackFailureMessage(error));
    } finally {
      setPublicHubsBusy(false);
    }
  };

  const submitUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!networkSourceReady(urlProtocol, url, cloudBucket) || urlAdding) return;
    setUrlAdding(true);
    setUrlError(null);
    try {
      const label = urlLabel.trim() || undefined;
      const credentialRef = credentialMode === 'none' ? undefined : authRef.trim();
      if (credentialMode !== 'none' && !credentialRef) {
        throw new Error('Enter a credential reference.');
      }
      if (urlProtocol === 's3' && s3RequesterPays && !credentialRef) {
        throw new Error('Requester-pays S3 access requires a credential.');
      }
      if (urlProtocol === 'gcs' && gcsBillingProject.trim() && !credentialRef) {
        throw new Error('A GCS billing project requires a credential.');
      }
      const credential = credentialForNetworkSource({
        mode: credentialMode,
        authRef,
        bearerToken,
        basicUsername,
        basicPassword,
        headerName,
        headerValue,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        gcsAccessToken,
      });
      if (credential) await onSaveCredential(credential);
      if (urlFormat === 'auto' && urlProtocol !== 'http') {
        throw new Error('Choose the indexed format for an object-storage or htsget source.');
      }
      const source = networkSourceLocator({
        protocol: urlProtocol,
        url,
        bucket: cloudBucket,
        objectKey: urlProtocol === 'htsget' ? urlResourceId : url,
        region: cloudRegion,
        requesterPays: s3RequesterPays,
        billingProject: gcsBillingProject,
        authRef: credentialRef,
        formatId: urlFormat,
      });
      const index = requiresCompanionIndex(urlProtocol, urlFormat)
        ? networkIndexLocator({
            protocol: urlProtocol,
            index: urlIndex,
            bucket: cloudBucket,
            region: cloudRegion,
            requesterPays: s3RequesterPays,
            billingProject: gcsBillingProject,
            authRef: credentialRef,
          })
        : undefined;
      await onAddNetworkSource({
        ...(urlFormat === 'auto' ? {} : { formatId: urlFormat }),
        source,
        ...(index ? { index } : {}),
        ...(urlFormat === 'bigwig'
          ? { scientificKind: 'quantitative' as const }
          : urlFormat === 'bigbed'
            ? { scientificKind: bigBedScientificKind }
            : {}),
        ...(label ? { label } : {}),
      });
    } catch (cause) {
      setUrlError(trackFailureMessage(cause));
    } finally {
      setUrlAdding(false);
    }
  };

  const submitComposition = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !onCreateSignalReadPileup ||
      !composeReadsTrackId ||
      !composeSignalTrackId ||
      composeAdding
    ) {
      return;
    }
    setComposeAdding(true);
    setComposeNotice(null);
    try {
      const result = await onCreateSignalReadPileup({
        readsTrackId: composeReadsTrackId,
        signalTrackId: composeSignalTrackId,
        ...(composeLabel.trim() ? { label: composeLabel.trim() } : {}),
        showSourceTracks: composeShowSources,
      });
      setComposeNotice(
        result === 'duplicate'
          ? { kind: 'warn', text: 'Those source tracks are already combined on this view.' }
          : {
              kind: 'success',
              text: 'Combined view created. BigWig height remains visible until each matching read region is ready.',
            }
      );
    } catch (error) {
      setComposeNotice({
        kind: 'error',
        text: trackFailureMessage(error),
      });
    } finally {
      setComposeAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeBlocked) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add data"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !closeBlocked) onClose();
        }}
        data-testid="add-track-dialog"
        onDragOver={(event) => {
          if (!event.dataTransfer?.types?.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!draggingFiles) setDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDraggingFiles(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer?.types?.includes('Files')) return;
          event.preventDefault();
          setDraggingFiles(false);
          handleFileDrop(Array.from(event.dataTransfer.files));
        }}
        className="relative flex h-[88vh] w-full max-w-[min(120rem,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl outline-none"
      >
        {membershipAnnouncement ? (
          <p className="sr-only" role="status" aria-live="polite">
            {membershipAnnouncement}
          </p>
        ) : null}
        {draggingFiles ? (
          <div
            data-testid="add-track-drop-overlay"
            className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center gap-2 rounded border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent"
          >
            <FilePlusIcon className="h-5 w-5" />
            <span>Drop to add to {assemblyDisplayName}</span>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-fg">Add data</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={closeBlocked}
            aria-label="Close data picker"
            className="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-40"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        {}
        <div className="flex shrink-0 gap-1 border-b border-border px-5" role="tablist">
          <AddDataTabButton
            id="catalog"
            label={catalogTabLabel}
            active={sourceTab === 'catalog'}
            onSelect={selectSourceTab}
          />
          <AddDataTabButton
            id="files"
            label="Your files"
            active={sourceTab === 'files'}
            testId="add-data-files-tab"
            onSelect={selectSourceTab}
          />
          <AddDataTabButton
            id="url"
            label="From a URL"
            active={sourceTab === 'url'}
            testId="add-track-link-toggle"
            onSelect={selectSourceTab}
          />
          <AddDataTabButton
            id="hubs"
            label="Track hubs"
            active={sourceTab === 'hubs'}
            testId="add-track-hubs-toggle"
            badge={connectedHubs.length > 0 ? String(connectedHubs.length) : undefined}
            onSelect={selectSourceTab}
          />
          <AddDataTabButton
            id="remote"
            label="Remote cluster"
            active={sourceTab === 'remote'}
            onSelect={selectSourceTab}
          />
          <AddDataTabButton
            id="combine"
            label="Signal + reads"
            active={sourceTab === 'combine'}
            onSelect={selectSourceTab}
          />
        </div>
        {busy && progress ? (
          <div className="shrink-0 px-5 pt-3">
            <AlignmentProgress progress={progress} />
          </div>
        ) : null}
        {dataFileNotice || indexedNotice || notice ? (
          <div className="shrink-0 space-y-2 px-5 pt-3">
            {dataFileNotice ? (
              <Notice notice={dataFileNotice} testId="add-data-files-notice" />
            ) : null}
            {indexedNotice ? (
              <Notice notice={indexedNotice} testId="add-bigwig-track-notice" />
            ) : null}
            {notice ? <Notice notice={notice} testId="add-bam-track-notice" /> : null}
          </div>
        ) : null}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-5"
          data-testid="add-track-public-panel"
        >
          {sourceTab === 'hubs' ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <HubConnectionPanel
                ucscTarget={ucscTarget}
                connectedHubs={connectedHubs}
                catalogHubUrl={catalogHubUrl}
                hubUrlInput={hubUrlInput}
                hubBusy={hubBusy}
                hubError={toOptionalUserMessage(hubError)}
                pendingHub={pendingHub}
                pendingHubGenome={pendingHubGenome}
                publicHubs={visiblePublicHubs}
                publicHubsBusy={publicHubsBusy}
                disabled={interactionBlocked}
                onHubUrlInputChange={setHubUrlInput}
                onConnect={() => void connectHub(hubUrlInput)}
                onConnectPublicHub={(hub) => void connectHub(hub.hubUrl, hub.shortLabel, false)}
                onBrowsePublicHubs={() => void browsePublicHubs()}
                onSelectCatalog={selectCatalog}
                onDisconnect={disconnectHub}
                onPendingHubGenomeChange={setPendingHubGenome}
                onConfirmPendingHub={() => {
                  if (!pendingHub || !pendingHubGenome) return;
                  adoptHub({
                    hubUrl: pendingHub.hubUrl,
                    genome: pendingHubGenome,
                    label: pendingHub.label,
                  });
                }}
                onDismissPendingHub={() => setPendingHub(null)}
              />
            </div>
          ) : sourceTab === 'url' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="add-track-url-panel">
              {!activeCatalog ? (
                <div className="mb-3">
                  <Unavailable assemblyDisplayName={assemblyDisplayName} />
                </div>
              ) : null}
              <p className="text-xs text-fg-muted">
                Link an indexed HTTP file, S3 or Google Cloud Storage object, or htsget service.
                DNAForge streams requested regions and does not download the whole file. It stores
                only durable locations and opaque credential references—not passwords, tokens,
                signed URLs, or temporary tickets.
              </p>
              <form onSubmit={(event) => void submitUrl(event)} className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-medium text-fg">
                    Source protocol
                    <select
                      value={urlProtocol}
                      onChange={(event) => {
                        const protocol = event.target.value as NetworkSourceProtocol;
                        setUrlProtocol(protocol);
                        setCredentialMode('none');
                        setUrlIndex('');
                        if (protocol === 'htsget' && !isHtsgetFormat(urlFormat)) {
                          setUrlFormat('bam');
                        } else if (
                          (protocol === 's3' || protocol === 'gcs') &&
                          urlFormat === 'auto'
                        ) {
                          setUrlFormat('bigwig');
                        }
                      }}
                      className={`${UI_FIELD_CLASS} mt-1`}
                    >
                      <option value="http">Indexed file URL</option>
                      <option value="s3">Amazon S3 object</option>
                      <option value="gcs">Google Cloud Storage object</option>
                      <option value="htsget">htsget service</option>
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-fg">
                    Indexed format
                    <select
                      value={urlFormat}
                      onChange={(event) => setUrlFormat(event.target.value as IndexedUrlFormat)}
                      className={`${UI_FIELD_CLASS} mt-1`}
                    >
                      {urlProtocol === 'http' ? (
                        <option value="auto">Detect from URL</option>
                      ) : null}
                      {urlProtocol !== 'htsget' ? (
                        <option value="bigwig">BigWig signal</option>
                      ) : null}
                      {urlProtocol !== 'htsget' ? (
                        <option value="bigbed">BigBed annotations</option>
                      ) : null}
                      <option value="bam">BAM reads</option>
                      <option value="cram">CRAM reads</option>
                      {remoteVariantsAvailable ? <option value="vcf">VCF variants</option> : null}
                      {remoteVariantsAvailable ? <option value="bcf">BCF variants</option> : null}
                    </select>
                  </label>
                </div>
                {urlProtocol === 's3' || urlProtocol === 'gcs' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-xs font-medium text-fg" htmlFor="cloud-bucket">
                      Bucket
                      <input
                        id="cloud-bucket"
                        required
                        value={cloudBucket}
                        onChange={(event) => setCloudBucket(event.target.value)}
                        placeholder="research-data"
                        className={`${UI_FIELD_CLASS} mt-1 font-mono`}
                      />
                    </label>
                    {urlProtocol === 's3' ? (
                      <label className="block text-xs font-medium text-fg" htmlFor="s3-region">
                        AWS region <span className="font-normal text-fg-muted">(optional)</span>
                        <input
                          id="s3-region"
                          value={cloudRegion}
                          onChange={(event) => setCloudRegion(event.target.value)}
                          placeholder="us-east-1"
                          className={`${UI_FIELD_CLASS} mt-1 font-mono`}
                        />
                      </label>
                    ) : (
                      <label
                        className="block text-xs font-medium text-fg"
                        htmlFor="gcs-billing-project"
                      >
                        Billing project{' '}
                        <span className="font-normal text-fg-muted">(optional)</span>
                        <input
                          id="gcs-billing-project"
                          value={gcsBillingProject}
                          onChange={(event) => setGcsBillingProject(event.target.value)}
                          placeholder="genomics-billing"
                          className={`${UI_FIELD_CLASS} mt-1 font-mono`}
                        />
                      </label>
                    )}
                  </div>
                ) : null}
                {urlProtocol === 's3' ? (
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      checked={s3RequesterPays}
                      onChange={(event) => setS3RequesterPays(event.target.checked)}
                    />
                    Requester-pays bucket
                  </label>
                ) : null}
                {urlProtocol !== 'htsget' && urlFormat === 'bigbed' ? (
                  <label className="block text-xs font-medium text-fg">
                    BigBed content
                    <select
                      value={bigBedScientificKind}
                      onChange={(event) =>
                        setBigBedScientificKind(event.target.value as BigBedScientificKind)
                      }
                      className={`${UI_FIELD_CLASS} mt-1`}
                    >
                      <option value="interval">Intervals</option>
                      <option value="transcript">Transcript models</option>
                      <option value="peak">Peaks</option>
                      <option value="repeat">Repeats</option>
                    </select>
                  </label>
                ) : null}
                <label className="block text-xs font-medium text-fg" htmlFor="indexed-track-url">
                  {urlProtocol === 'htsget'
                    ? 'htsget service endpoint'
                    : urlProtocol === 'http'
                      ? 'Indexed track URL'
                      : 'Object key'}
                </label>
                <div className="flex gap-2">
                  <input
                    id="indexed-track-url"
                    type={urlProtocol === 'http' || urlProtocol === 'htsget' ? 'url' : 'text'}
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder={
                      urlProtocol === 'htsget'
                        ? userMessage('notice.https-htsget-example-org')
                        : urlProtocol === 'http'
                          ? userMessage('notice.https-results-example-org-run-sample-bigwig')
                          : userMessage('notice.cohort-sample-bigwig')
                    }
                    className={`${UI_FIELD_CLASS} flex-1 font-mono`}
                  />
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={
                      interactionBlocked ||
                      !networkSourceReady(urlProtocol, url, cloudBucket) ||
                      (urlProtocol === 'htsget' && !urlResourceId.trim()) ||
                      (requiresCompanionIndex(urlProtocol, urlFormat) && !urlIndex.trim()) ||
                      (credentialMode !== 'none' && !authRef.trim())
                    }
                    data-testid="add-bigwig-url"
                  >
                    {urlAdding || indexedBusy ? 'Checking…' : 'Attach'}
                  </Button>
                </div>
                {urlProtocol === 'htsget' ? (
                  <div>
                    <label
                      className="block text-xs font-medium text-fg"
                      htmlFor="htsget-resource-id"
                    >
                      htsget resource ID
                    </label>
                    <input
                      id="htsget-resource-id"
                      required
                      value={urlResourceId}
                      onChange={(event) => setUrlResourceId(event.target.value)}
                      placeholder="sample-or-dataset-id"
                      className={`${UI_FIELD_CLASS} mt-1 font-mono`}
                    />
                  </div>
                ) : null}
                {urlProtocol !== 'htsget' &&
                (urlFormat === 'bam' ||
                  urlFormat === 'cram' ||
                  urlFormat === 'vcf' ||
                  urlFormat === 'bcf') ? (
                  <div>
                    <label
                      className="block text-xs font-medium text-fg"
                      htmlFor="indexed-companion-url"
                    >
                      {urlFormat === 'bam' || urlFormat === 'cram'
                        ? urlProtocol === 'http'
                          ? 'Alignment index URL'
                          : 'Alignment index object key'
                        : urlProtocol === 'http'
                          ? 'Variant index URL'
                          : 'Variant index object key'}
                    </label>
                    <input
                      id="indexed-companion-url"
                      type={urlProtocol === 'http' ? 'url' : 'text'}
                      required
                      value={urlIndex}
                      onChange={(event) => setUrlIndex(event.target.value)}
                      placeholder={
                        urlProtocol !== 'http'
                          ? urlFormat === 'bam'
                            ? 'cohort/sample.bam.bai'
                            : urlFormat === 'cram'
                              ? 'cohort/sample.cram.crai'
                              : urlFormat === 'bcf'
                                ? 'cohort/sample.bcf.csi'
                                : 'cohort/sample.vcf.gz.tbi'
                          : urlFormat === 'bam'
                            ? 'https://results.example.org/run/sample.bam.bai'
                            : urlFormat === 'cram'
                              ? 'https://results.example.org/run/sample.cram.crai'
                              : urlFormat === 'bcf'
                                ? 'https://results.example.org/run/sample.bcf.csi'
                                : 'https://results.example.org/run/sample.vcf.gz.tbi'
                      }
                      className={`${UI_FIELD_CLASS} mt-1 font-mono`}
                    />
                  </div>
                ) : null}
                <CredentialFields
                  protocol={urlProtocol}
                  mode={credentialMode}
                  authRef={authRef}
                  bearerToken={bearerToken}
                  basicUsername={basicUsername}
                  basicPassword={basicPassword}
                  headerName={headerName}
                  headerValue={headerValue}
                  awsAccessKeyId={awsAccessKeyId}
                  awsSecretAccessKey={awsSecretAccessKey}
                  awsSessionToken={awsSessionToken}
                  gcsAccessToken={gcsAccessToken}
                  onModeChange={setCredentialMode}
                  onAuthRefChange={setAuthRef}
                  onBearerTokenChange={setBearerToken}
                  onBasicUsernameChange={setBasicUsername}
                  onBasicPasswordChange={setBasicPassword}
                  onHeaderNameChange={setHeaderName}
                  onHeaderValueChange={setHeaderValue}
                  onAwsAccessKeyIdChange={setAwsAccessKeyId}
                  onAwsSecretAccessKeyChange={setAwsSecretAccessKey}
                  onAwsSessionTokenChange={setAwsSessionToken}
                  onGcsAccessTokenChange={setGcsAccessToken}
                />
                {urlFormat === 'cram' ? (
                  <p className="text-[11px] text-fg-muted">
                    DNAForge will ask for the matching indexed reference FASTA before attaching this
                    CRAM.
                  </p>
                ) : null}
                <div>
                  <label
                    className="block text-xs font-medium text-fg"
                    htmlFor="indexed-track-label"
                  >
                    Track label <span className="font-normal text-fg-muted">(optional)</span>
                  </label>
                  <input
                    id="indexed-track-label"
                    value={urlLabel}
                    onChange={(event) => setUrlLabel(event.target.value)}
                    placeholder="RNA-seq coverage"
                    className={`${UI_FIELD_CLASS} mt-1`}
                  />
                </div>
                {urlError ? (
                  <p role="alert" data-testid="add-track-url-error" className="text-xs text-danger">
                    {toUserMessage(urlError, 'tracks.loadFailed')}
                  </p>
                ) : null}
              </form>
              {}
            </div>
          ) : sourceTab === 'files' ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <FilePlusIcon className="h-8 w-8 text-fg-subtle" />
              <p className="text-sm text-fg">Drop files anywhere on this window</p>
              <p className="max-w-md text-xs text-fg-muted">
                BAM, CRAM, BigWig, BigBed, BED, GFF, or a script-written .dnaforge-tracks.json
                manifest. DNAForge leaves them where they are and reads only the byte ranges the
                current view needs. A manifest can attach BigWig signal and peaks without reads or a
                CRAI.
              </p>
              <Button
                type="button"
                data-testid="add-data-files-choose"
                disabled={interactionBlocked}
                onClick={onChooseDataFiles}
              >
                Choose files…
              </Button>
            </div>
          ) : sourceTab === 'remote' ? (
            onAddRemoteBam ? (
              <RemoteClusterPanel
                onManageHosts={onClose}
                assemblyDisplayName={assemblyDisplayName}
                recentEndpoints={recentRemoteEndpoints}
                busy={Boolean(busy)}
                connecting={remoteConnecting}
                onCancelConnection={onCancelRemoteConnect}
                submitLabel="Connect and attach"
                onSubmit={onAddRemoteBam}
                onRefreshEndpoints={onRefreshRemoteEndpoints}
              />
            ) : null
          ) : sourceTab === 'combine' ? (
            <div
              className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
              data-testid="add-track-combine-panel"
            >
              <p className="text-xs text-fg-muted">
                Combine an indexed BAM or CRAM already on this view with a BigWig from the same
                sample. The BigWig is drawn in read-row units while read tiles stream, then each
                ready region hands off to the normal interactive pileup.
              </p>
              {composableReadTracks.length === 0 || composableSignalTracks.length === 0 ? (
                <div className="rounded border border-border bg-bg-subtle p-3 text-xs text-fg-muted">
                  Attach at least one indexed BAM or CRAM and one quantitative BigWig first. They
                  can come from Files, URL, or Remote cluster.
                </div>
              ) : (
                <form onSubmit={(event) => void submitComposition(event)} className="space-y-3">
                  <label
                    className="block text-xs font-medium text-fg"
                    htmlFor="combined-read-track"
                  >
                    Read pileup
                    <select
                      id="combined-read-track"
                      value={composeReadsTrackId}
                      onChange={(event) => {
                        setComposeReadsTrackId(event.target.value);
                        setComposeNotice(null);
                      }}
                      className="mt-1 block w-full rounded border border-border bg-bg px-2.5 py-2 text-xs text-fg outline-none focus:border-emerald-500"
                    >
                      {composableReadTracks.map((track) => (
                        <option key={track.trackId} value={track.trackId}>
                          {track.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="block text-xs font-medium text-fg"
                    htmlFor="combined-signal-track"
                  >
                    BigWig signal
                    <select
                      id="combined-signal-track"
                      value={composeSignalTrackId}
                      onChange={(event) => {
                        setComposeSignalTrackId(event.target.value);
                        setComposeNotice(null);
                      }}
                      className="mt-1 block w-full rounded border border-border bg-bg px-2.5 py-2 text-xs text-fg outline-none focus:border-emerald-500"
                    >
                      {composableSignalTracks.map((track) => (
                        <option key={track.trackId} value={track.trackId}>
                          {track.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="block text-xs font-medium text-fg"
                    htmlFor="combined-view-label"
                  >
                    Combined view label{' '}
                    <span className="font-normal text-fg-muted">(optional)</span>
                    <input
                      id="combined-view-label"
                      value={composeLabel}
                      maxLength={200}
                      onChange={(event) => setComposeLabel(event.target.value)}
                      placeholder="Accessibility + reads"
                      className="mt-1 w-full rounded border border-border bg-bg px-2.5 py-2 text-xs text-fg outline-none focus:border-emerald-500"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      checked={composeShowSources}
                      onChange={(event) => setComposeShowSources(event.target.checked)}
                    />
                    Keep the source tracks visible
                  </label>
                  <button
                    type="submit"
                    disabled={
                      interactionBlocked ||
                      !onCreateSignalReadPileup ||
                      !composeReadsTrackId ||
                      !composeSignalTrackId
                    }
                    className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {composeAdding ? 'Creating…' : 'Create combined view'}
                  </button>
                </form>
              )}
              {composeNotice ? (
                <Notice notice={composeNotice} testId="signal-read-compose-notice" />
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 gap-4">
              <CatalogSidebar
                hostedLabel={
                  ucscTarget
                    ? ucscTarget.hubUrl
                      ? `${hubDisplayLabel(ucscTarget.hubUrl)} (${ucscTarget.genomeId})`
                      : `UCSC ${ucscTarget.genomeId}`
                    : null
                }
                connectedHubs={connectedHubs}
                catalogHubUrl={catalogHubUrl}
                onSelectCatalog={selectCatalog}
                groups={facetGroups}
                selection={facetSelection}
                selectedCount={selectedFacetCount}
                onToggle={(key, value) =>
                  setFacetSelection((current) => toggleCatalogFacet(current, key, value))
                }
                onClear={() => setFacetSelection({})}
              />
              {}
              {activeCatalog ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {}
                  <form onSubmit={(event) => void search(event)} className="flex gap-2">
                    <label className="sr-only" htmlFor="public-track-query">
                      Search public genomic data
                    </label>
                    <div className="relative min-w-0 flex-1">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle">
                        <SearchIcon size={14} />
                      </span>
                      <input
                        id="public-track-query"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search by name, tissue, protein, or accession…"
                        className="h-9 w-full min-w-0 rounded border border-border bg-bg pl-7 pr-2 text-sm text-fg outline-none focus:border-accent"
                      />
                    </div>
                    <button type="submit" className="sr-only">
                      Search
                    </button>
                  </form>
                  <div className="mt-3 flex min-h-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1 flex-col">
                      {}
                      {selectedFacetCount > 0 ? (
                        <div
                          data-testid="ucsc-catalog-active-facets"
                          className="mb-2 flex flex-wrap items-center gap-1.5"
                        >
                          {activeFacetChips.map((chip) => (
                            <button
                              key={`${chip.key}:${chip.value}`}
                              type="button"
                              data-testid={`ucsc-facet-chip-${chip.key}-${chip.value}`}
                              aria-label={`Remove ${chip.groupLabel} ${chip.label}`}
                              onClick={() =>
                                setFacetSelection((current) =>
                                  toggleCatalogFacet(current, chip.key, chip.value)
                                )
                              }
                              className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-accent hover:bg-accent/20"
                            >
                              <span className="text-accent/70">{chip.groupLabel}</span>
                              <span>{chip.label}</span>
                              <CloseIcon size={10} />
                            </button>
                          ))}
                          <button
                            type="button"
                            data-testid="ucsc-catalog-facets-clear-all"
                            onClick={() => setFacetSelection({})}
                            className="px-1 text-[11px] text-fg-muted hover:text-fg"
                          >
                            Clear all
                          </button>
                        </div>
                      ) : null}
                      <TrackSearchResults
                        key={`${activeGenomeId}\u0000${activeHubUrl ?? ''}`}
                        query={query}
                        tracks={filteredPublicTracks}
                        schemaTracks={publicTracks}
                        catalogSize={publicCatalogSize}
                        countsAreComplete={publicCountsAreComplete}
                        searching={publicSearching}
                        emptyText={
                          query.trim() || selectedFacetCount > 0
                            ? 'No tracks match this search and these filters.'
                            : listingHub
                              ? 'This hub publishes no tracks for this assembly.'
                              : 'This catalog publishes no tracks for this assembly.'
                        }
                        searchError={toOptionalUserMessage(searchError)}
                        rowFailures={rowFailures}
                        addedCatalogIds={addedCatalogIds}
                        addingTrack={addingTrack}
                        onAddTrack={onAddUcscTrack}
                        onTrackInView={noteTrackInView}
                        onAddingTrackChange={setAddingTrack}
                        onAddStart={(catalogId) =>
                          setRowFailures((current) => {
                            if (!(catalogId in current)) return current;
                            const next = { ...current };
                            delete next[catalogId];
                            return next;
                          })
                        }
                        onAddError={(catalogId, error) =>
                          setRowFailures((current) => ({
                            ...current,
                            [catalogId]: publicTrackFailure(error),
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 p-2">
                  <Unavailable assemblyDisplayName={assemblyDisplayName} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function hubDisplayLabel(hubUrl: string): string {
  try {
    const parsed = new URL(hubUrl);
    const file = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return file && file !== 'hub.txt' ? `${parsed.hostname} · ${file}` : parsed.hostname;
  } catch {
    return hubUrl;
  }
}

function HubConnectionPanel({
  ucscTarget,
  connectedHubs,
  catalogHubUrl,
  hubUrlInput,
  hubBusy,
  hubError,
  pendingHub,
  pendingHubGenome,
  publicHubs,
  publicHubsBusy,
  disabled,
  onHubUrlInputChange,
  onConnect,
  onConnectPublicHub,
  onBrowsePublicHubs,
  onSelectCatalog,
  onDisconnect,
  onPendingHubGenomeChange,
  onConfirmPendingHub,
  onDismissPendingHub,
}: {
  ucscTarget: HostedReferenceUcscTrackTargetV1 | null;
  connectedHubs: ReadonlyArray<ConnectedHub>;
  catalogHubUrl: string | null;
  hubUrlInput: string;
  hubBusy: boolean;
  hubError: string | null;
  pendingHub: PendingHub | null;
  pendingHubGenome: string;
  publicHubs: ReadonlyArray<UcscPublicHub> | null;
  publicHubsBusy: boolean;
  disabled: boolean;
  onHubUrlInputChange: (value: string) => void;
  onConnect: () => void;
  onConnectPublicHub: (hub: UcscPublicHub) => void;
  onBrowsePublicHubs: () => void;
  onSelectCatalog: (hubUrl: string | null) => void;
  onDisconnect: (hubUrl: string) => void;
  onPendingHubGenomeChange: (genome: string) => void;
  onConfirmPendingHub: () => void;
  onDismissPendingHub: () => void;
}) {
  const connectedUrls = new Set(connectedHubs.map((hub) => hub.hubUrl));
  const inputClass = `${UI_FIELD_CLASS} mt-1 font-mono`;
  return (
    <section
      aria-labelledby="track-hub-heading"
      className="space-y-3 rounded border border-border p-3"
      data-testid="track-hub-panel"
    >
      <h3 id="track-hub-heading" className="text-xs font-medium text-fg">
        Track hubs
      </h3>
      <p className="text-[11px] text-fg-muted">
        Connect a UCSC-style track hub by URL or from UCSC&apos;s public registry. DNAForge keeps
        the hub address and track names; the hub&apos;s files stay where they are published.
      </p>
      {ucscTarget || connectedHubs.length > 0 ? (
        <label className="block text-xs font-medium text-fg" htmlFor="catalog-source">
          Catalog source
          <select
            id="catalog-source"
            value={catalogHubUrl ?? ''}
            disabled={disabled}
            onChange={(event) => onSelectCatalog(event.target.value || null)}
            className={`${UI_FIELD_CLASS} mt-1`}
          >
            {ucscTarget ? (
              <option value="">
                {ucscTarget.hubUrl
                  ? `${hubDisplayLabel(ucscTarget.hubUrl)} (${ucscTarget.genomeId})`
                  : `UCSC ${ucscTarget.genomeId}`}
              </option>
            ) : null}
            {connectedHubs.map((hub) => (
              <option key={hub.hubUrl} value={hub.hubUrl}>
                {hub.label} ({hub.genome})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {connectedHubs.length > 0 ? (
        <ul aria-label="Connected track hubs" className="space-y-1">
          {connectedHubs.map((hub) => (
            <li
              key={hub.hubUrl}
              className="flex items-center gap-2 rounded bg-bg-subtle px-2 py-1 text-[11px] text-fg"
            >
              <span className="min-w-0 flex-1 truncate font-mono" title={hub.hubUrl}>
                {hub.hubUrl}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onDisconnect(hub.hubUrl)}
                className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent hover:text-fg disabled:opacity-50"
              >
                Disconnect {hub.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConnect();
        }}
        className="flex items-end gap-2"
      >
        <label className="block min-w-0 flex-1 text-xs font-medium text-fg" htmlFor="track-hub-url">
          Track hub URL
          <input
            id="track-hub-url"
            type="url"
            value={hubUrlInput}
            disabled={disabled || hubBusy}
            onChange={(event) => onHubUrlInputChange(event.target.value)}
            placeholder="https://example.org/hub.txt"
            className={inputClass}
          />
        </label>
        <Button
          variant="primary"
          type="submit"
          disabled={disabled || hubBusy || !hubUrlInput.trim()}
        >
          {hubBusy ? 'Connecting…' : 'Connect hub'}
        </Button>
        <Button type="button" disabled={disabled || publicHubsBusy} onClick={onBrowsePublicHubs}>
          {publicHubsBusy ? 'Loading…' : 'Browse public hubs'}
        </Button>
      </form>
      {pendingHub ? (
        <div
          role="group"
          aria-label={`Choose the hub assembly for ${pendingHub.label}`}
          className="space-y-2 rounded border border-warning/40 p-2"
        >
          <p className="text-xs text-warning">
            {pendingHub.label} does not name {ucscTarget ? ucscTarget.genomeId : 'this assembly'}.
            Choose which of its assemblies matches the open reference; DNAForge verifies the
            chromosome table before attaching any track.
          </p>
          <label className="block text-xs font-medium text-fg" htmlFor="pending-hub-genome">
            Hub assembly
            <select
              id="pending-hub-genome"
              value={pendingHubGenome}
              onChange={(event) => onPendingHubGenomeChange(event.target.value)}
              className={`${UI_FIELD_CLASS} mt-1`}
            >
              {pendingHub.genomes.map((genome) => (
                <option key={genome.name} value={genome.name}>
                  {genome.name}
                  {genome.organism ? ` · ${genome.organism}` : ''}
                  {genome.assemblyHub ? ' · assembly hub' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button
              variant="primary"
              type="button"
              disabled={!pendingHubGenome}
              onClick={onConfirmPendingHub}
            >
              Use this assembly
            </Button>
            <Button type="button" onClick={onDismissPendingHub}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {hubError ? (
        <p role="alert" className="rounded border border-error/40 px-3 py-2 text-xs text-error">
          {toUserMessage(hubError, 'tracks.loadFailed')}
        </p>
      ) : null}
      {publicHubs ? (
        publicHubs.length === 0 ? (
          <p className="text-[11px] text-fg-muted">
            UCSC&apos;s public registry lists no hubs for {ucscTarget?.genomeId ?? 'this assembly'}.
          </p>
        ) : (
          <ul
            aria-label="Public track hubs"
            className="max-h-[220px] space-y-1 overflow-y-auto rounded border border-border p-1"
          >
            {publicHubs.map((hub) => {
              const connected = connectedUrls.has(hub.hubUrl);
              return (
                <li key={hub.hubUrl} className="flex items-start gap-2 px-2 py-1.5">
                  <div className={`flex-1 ${UI_PROSE_WRAP_CLASS}`}>
                    <div className="text-xs font-medium text-fg">{hub.shortLabel}</div>
                    <div className="text-[11px] text-fg-muted">{hub.longLabel}</div>
                    <div className="font-mono text-xs text-fg-subtle">{hub.hubUrl}</div>
                  </div>
                  {connected ? (
                    <span className="shrink-0 rounded border border-success/40 px-2 py-0.5 text-xs text-success">
                      Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled || hubBusy}
                      onClick={() => onConnectPublicHub(hub)}
                      className="shrink-0 rounded border border-border px-2.5 py-1 text-xs font-medium text-fg hover:border-accent disabled:opacity-50"
                    >
                      Connect
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}

function AddDataTabButton({
  id,
  label,
  active,
  badge,
  testId,
  onSelect,
}: {
  id: AddDataTab;
  label: string;
  active: boolean;
  badge?: string;
  testId?: string;
  onSelect: (tab: AddDataTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      {...(testId ? { 'data-testid': testId } : {})}
      onClick={() => onSelect(id)}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium ${
        active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
      }`}
    >
      <span className="max-w-[16rem] truncate">{label}</span>
      {badge ? (
        <span className="rounded-full bg-bg-muted px-1.5 text-[10px] text-fg-subtle">{badge}</span>
      ) : null}
    </button>
  );
}

function CatalogSidebar({
  hostedLabel,
  connectedHubs,
  catalogHubUrl,
  onSelectCatalog,
  groups,
  selection,
  selectedCount,
  onToggle,
  onClear,
}: {
  hostedLabel: string | null;
  connectedHubs: ReadonlyArray<ConnectedHub>;
  catalogHubUrl: string | null;
  onSelectCatalog: (hubUrl: string | null) => void;
  groups: ReadonlyArray<CatalogFacetGroup>;
  selection: CatalogFacetSelection;
  selectedCount: number;
  onToggle: (key: string, value: string) => void;
  onClear: () => void;
}) {
  const showSources = connectedHubs.length > 0;
  return (
    <aside
      data-testid="ucsc-catalog-sidebar"
      className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border pr-3"
    >
      {showSources ? (
        <>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Catalog
          </div>
          {hostedLabel ? (
            <SourceChoiceRow
              label={hostedLabel}
              active={catalogHubUrl === null}
              testId="ucsc-catalog-source-hosted"
              onClick={() => onSelectCatalog(null)}
            />
          ) : null}
          {connectedHubs.map((hub) => (
            <SourceChoiceRow
              key={hub.hubUrl}
              label={hub.label || hubDisplayLabel(hub.hubUrl)}
              active={catalogHubUrl === hub.hubUrl}
              testId={`ucsc-catalog-source-${hub.hubUrl}`}
              onClick={() => onSelectCatalog(hub.hubUrl)}
            />
          ))}
        </>
      ) : hostedLabel ? (
        <SourceChoiceRow
          label={hostedLabel}
          active
          testId="ucsc-catalog-source-hosted"
          onClick={() => onSelectCatalog(null)}
        />
      ) : null}

      {groups.length > 0 ? (
        <>
          <div className={`${showSources ? 'mt-4' : ''} mb-1 flex items-center justify-between`}>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              Narrow by · {groups.length} filters
            </span>
            {selectedCount > 0 ? (
              <button
                type="button"
                data-testid="ucsc-catalog-facets-clear"
                onClick={onClear}
                className="text-xs text-accent hover:underline"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div data-testid="ucsc-catalog-facets" className="min-h-0">
            {groups.map((group) => (
              <CatalogFacetGroupRows
                key={group.key}
                group={group}
                chosen={selection[group.key] ?? []}
                onToggle={onToggle}
              />
            ))}
          </div>
        </>
      ) : null}
    </aside>
  );
}

function SourceChoiceRow({
  label,
  active,
  testId,
  onClick,
}: {
  label: string;
  active: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${
        active
          ? 'bg-accent/15 font-medium text-accent'
          : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
      }`}
    >
      <span className="truncate" title={label}>
        {label}
      </span>
    </button>
  );
}

const FACET_VALUES_BEFORE_MORE = 8;

function CatalogFacetGroupRows({
  group,
  chosen,
  onToggle,
}: {
  group: CatalogFacetGroup;
  chosen: ReadonlyArray<string>;
  onToggle: (key: string, value: string) => void;
}) {
  const [sectionOpen, setSectionOpen] = useState(group.key === TRACK_KIND_FACET_KEY);
  const [expanded, setExpanded] = useState(false);
  const [valueQuery, setValueQuery] = useState('');
  useEffect(() => {
    if (chosen.length > 0) setSectionOpen(true);
  }, [chosen.length]);
  const search = valueQuery.trim().toLocaleLowerCase();
  const matching = search
    ? group.values.filter((entry) => entry.label.toLocaleLowerCase().includes(search))
    : group.values;
  const initialCount =
    group.key === TRACK_KIND_FACET_KEY ? group.values.length : FACET_VALUES_BEFORE_MORE;
  const visible = expanded || search ? matching : matching.slice(0, initialCount);
  const withheld = matching.length - visible.length;
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        aria-label={`${group.label} filter`}
        aria-expanded={sectionOpen}
        onClick={() => setSectionOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted hover:text-fg"
      >
        <span>{group.label}</span>
        <span className="flex items-center gap-2 text-[10px] font-normal normal-case tracking-normal text-fg-subtle">
          {chosen.length ? `${chosen.length} selected` : `${group.values.length} choices`}
          <span aria-hidden="true">{sectionOpen ? '▾' : '▸'}</span>
        </span>
      </button>
      {sectionOpen ? (
        <div className="pb-2">
          {group.values.length > 12 ? (
            <input
              aria-label={`Find ${group.label}`}
              value={valueQuery}
              onChange={(event) => setValueQuery(event.target.value)}
              placeholder={`Find ${group.label.toLocaleLowerCase()}…`}
              className="mb-1 w-full rounded border border-border bg-bg px-1.5 py-1 text-xs text-fg outline-none focus:border-accent"
            />
          ) : null}
          <div
            className={expanded && group.values.length > 20 ? 'max-h-56 overflow-y-auto pr-1' : ''}
          >
            {visible.map((entry) => {
              const active = chosen.includes(entry.value);
              return (
                <button
                  key={entry.value}
                  type="button"
                  aria-pressed={active}
                  data-testid={`ucsc-facet-${group.key}-${entry.value}`}
                  onClick={() => onToggle(group.key, entry.value)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs ${
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  <span className="truncate" title={entry.label}>
                    {entry.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-fg-subtle">
                    {entry.count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
          {search && visible.length === 0 ? (
            <p className="px-1.5 py-1 text-[11px] text-fg-subtle">No matching choices</p>
          ) : null}
          {withheld > 0 ? (
            <button
              type="button"
              aria-label={`Show all ${group.label} choices`}
              onClick={() => setExpanded(true)}
              className="mt-0.5 px-1.5 text-[10px] text-fg-subtle hover:text-fg"
            >
              Show all {group.values.length.toLocaleString()} ({withheld} more)
            </button>
          ) : expanded && group.values.length > initialCount && !search ? (
            <button
              type="button"
              aria-label={`Show fewer ${group.label} choices`}
              onClick={() => setExpanded(false)}
              className="mt-0.5 px-1.5 text-[10px] text-fg-subtle hover:text-fg"
            >
              Show fewer
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isHtsgetFormat(format: IndexedUrlFormat): format is HtsgetFormat {
  return format === 'bam' || format === 'cram' || format === 'vcf' || format === 'bcf';
}

function networkSourceReady(
  protocol: NetworkSourceProtocol,
  source: string,
  bucket: string
): boolean {
  return source.trim().length > 0 && (protocol === 's3' || protocol === 'gcs')
    ? bucket.trim().length > 0
    : source.trim().length > 0;
}

function requiresCompanionIndex(
  protocol: NetworkSourceProtocol,
  format: IndexedUrlFormat
): boolean {
  return (
    protocol !== 'htsget' &&
    (format === 'bam' || format === 'cram' || format === 'vcf' || format === 'bcf')
  );
}

function networkSourceLocator(input: {
  protocol: NetworkSourceProtocol;
  url: string;
  bucket: string;
  objectKey: string;
  region: string;
  requesterPays: boolean;
  billingProject: string;
  authRef?: string;
  formatId: IndexedUrlFormat;
}): TrackSourceAddressV1 {
  const auth = input.authRef ? { authRef: input.authRef } : {};
  switch (input.protocol) {
    case 'http':
      return { kind: 'http', url: input.url.trim(), ...auth };
    case 's3':
      return {
        kind: 's3',
        bucket: input.bucket.trim(),
        key: input.objectKey.trim(),
        ...(input.region.trim() ? { region: input.region.trim() } : {}),
        ...(input.requesterPays ? { requesterPays: true } : {}),
        ...auth,
      };
    case 'gcs':
      return {
        kind: 'gcs',
        bucket: input.bucket.trim(),
        object: input.objectKey.trim(),
        ...(input.billingProject.trim() ? { billingProject: input.billingProject.trim() } : {}),
        ...auth,
      };
    case 'htsget': {
      if (!isHtsgetFormat(input.formatId)) {
        throw new Error('Choose BAM, CRAM, VCF, or BCF for an htsget source.');
      }
      const reads = input.formatId === 'bam' || input.formatId === 'cram';
      return {
        kind: 'htsget',
        endpoint: input.url.trim(),
        resourceId: input.objectKey.trim(),
        dataClass: reads ? 'reads' : 'variants',
        format: input.formatId.toUpperCase() as 'BAM' | 'CRAM' | 'VCF' | 'BCF',
        ...auth,
      };
    }
  }
}

function networkIndexLocator(input: {
  protocol: NetworkSourceProtocol;
  index: string;
  bucket: string;
  region: string;
  requesterPays: boolean;
  billingProject: string;
  authRef?: string;
}): TrackAssetLocatorV1 {
  const auth = input.authRef ? { authRef: input.authRef } : {};
  switch (input.protocol) {
    case 'http':
      return { kind: 'http', url: input.index.trim(), ...auth };
    case 's3':
      return {
        kind: 's3',
        bucket: input.bucket.trim(),
        key: input.index.trim(),
        ...(input.region.trim() ? { region: input.region.trim() } : {}),
        ...(input.requesterPays ? { requesterPays: true } : {}),
        ...auth,
      };
    case 'gcs':
      return {
        kind: 'gcs',
        bucket: input.bucket.trim(),
        object: input.index.trim(),
        ...(input.billingProject.trim() ? { billingProject: input.billingProject.trim() } : {}),
        ...auth,
      };
    case 'htsget':
      throw new Error('htsget sources do not use companion indices.');
  }
}

function credentialForNetworkSource(input: {
  mode: CredentialMode;
  authRef: string;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  headerName: string;
  headerValue: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  gcsAccessToken: string;
}): GenomeSourceCredentialInput | undefined {
  const base = {
    contract: GENOME_SOURCE_CREDENTIAL_V1,
    authRef: input.authRef.trim(),
  } as const;
  switch (input.mode) {
    case 'none':
    case 'saved':
      return undefined;
    case 'http-bearer':
      return { ...base, kind: input.mode, token: input.bearerToken };
    case 'http-basic':
      return {
        ...base,
        kind: input.mode,
        username: input.basicUsername,
        password: input.basicPassword,
      };
    case 'http-header':
      return {
        ...base,
        kind: input.mode,
        headerName: input.headerName,
        headerValue: input.headerValue,
      };
    case 'aws-sigv4':
      return {
        ...base,
        kind: input.mode,
        accessKeyId: input.awsAccessKeyId,
        secretAccessKey: input.awsSecretAccessKey,
        ...(input.awsSessionToken ? { sessionToken: input.awsSessionToken } : {}),
      };
    case 'gcs-oauth':
      return { ...base, kind: input.mode, accessToken: input.gcsAccessToken };
  }
}

function CredentialFields({
  protocol,
  mode,
  authRef,
  bearerToken,
  basicUsername,
  basicPassword,
  headerName,
  headerValue,
  awsAccessKeyId,
  awsSecretAccessKey,
  awsSessionToken,
  gcsAccessToken,
  onModeChange,
  onAuthRefChange,
  onBearerTokenChange,
  onBasicUsernameChange,
  onBasicPasswordChange,
  onHeaderNameChange,
  onHeaderValueChange,
  onAwsAccessKeyIdChange,
  onAwsSecretAccessKeyChange,
  onAwsSessionTokenChange,
  onGcsAccessTokenChange,
}: {
  protocol: NetworkSourceProtocol;
  mode: CredentialMode;
  authRef: string;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  headerName: string;
  headerValue: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  gcsAccessToken: string;
  onModeChange: (value: CredentialMode) => void;
  onAuthRefChange: (value: string) => void;
  onBearerTokenChange: (value: string) => void;
  onBasicUsernameChange: (value: string) => void;
  onBasicPasswordChange: (value: string) => void;
  onHeaderNameChange: (value: string) => void;
  onHeaderValueChange: (value: string) => void;
  onAwsAccessKeyIdChange: (value: string) => void;
  onAwsSecretAccessKeyChange: (value: string) => void;
  onAwsSessionTokenChange: (value: string) => void;
  onGcsAccessTokenChange: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded border border-border p-3" data-credential-mode={mode}>
      <legend className="px-1 text-xs font-medium text-fg">Authentication</legend>
      <label className="block text-xs font-medium text-fg" htmlFor="source-credential-mode">
        Credential
        <select
          id="source-credential-mode"
          value={mode}
          onChange={(event) => onModeChange(event.target.value as CredentialMode)}
          className={`${UI_FIELD_CLASS} mt-1`}
        >
          <option value="none">No credential (public source)</option>
          <option value="saved">Use a saved credential</option>
          {protocol === 'http' || protocol === 'htsget' ? (
            <>
              <option value="http-bearer">Save a bearer token</option>
              <option value="http-basic">Save a username and password</option>
              <option value="http-header">Save a custom request header</option>
            </>
          ) : null}
          {protocol === 's3' ? <option value="aws-sigv4">Save AWS access keys</option> : null}
          {protocol === 'gcs' ? <option value="gcs-oauth">Save a GCS access token</option> : null}
        </select>
      </label>
      {mode !== 'none' ? (
        <label className="block text-xs font-medium text-fg" htmlFor="source-auth-ref">
          Credential reference
          <input
            id="source-auth-ref"
            required
            value={authRef}
            onChange={(event) => onAuthRefChange(event.target.value)}
            placeholder="credential:research-data"
            className={`${UI_FIELD_CLASS} mt-1 font-mono`}
          />
          <span className="mt-1 block font-normal text-fg-muted">
            Use the same reference later to reuse this key without entering it again.
          </span>
        </label>
      ) : null}
      {mode === 'http-bearer' ? (
        <SecretInput
          id="source-bearer-token"
          label="Bearer token"
          value={bearerToken}
          onChange={onBearerTokenChange}
        />
      ) : null}
      {mode === 'http-basic' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-fg" htmlFor="source-basic-username">
            Username
            <input
              id="source-basic-username"
              required
              autoComplete="off"
              value={basicUsername}
              onChange={(event) => onBasicUsernameChange(event.target.value)}
              className={`${UI_FIELD_CLASS} mt-1`}
            />
          </label>
          <SecretInput
            id="source-basic-password"
            label="Password"
            value={basicPassword}
            onChange={onBasicPasswordChange}
          />
        </div>
      ) : null}
      {mode === 'http-header' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-fg" htmlFor="source-header-name">
            Header name
            <input
              id="source-header-name"
              required
              autoComplete="off"
              value={headerName}
              onChange={(event) => onHeaderNameChange(event.target.value)}
              placeholder="X-Research-Token"
              className={`${UI_FIELD_CLASS} mt-1 font-mono`}
            />
          </label>
          <SecretInput
            id="source-header-value"
            label="Header value"
            value={headerValue}
            onChange={onHeaderValueChange}
          />
        </div>
      ) : null}
      {mode === 'aws-sigv4' ? (
        <>
          <label className="block text-xs font-medium text-fg" htmlFor="source-aws-access-key">
            AWS access key ID
            <input
              id="source-aws-access-key"
              required
              autoComplete="off"
              value={awsAccessKeyId}
              onChange={(event) => onAwsAccessKeyIdChange(event.target.value)}
              className={`${UI_FIELD_CLASS} mt-1 font-mono`}
            />
          </label>
          <SecretInput
            id="source-aws-secret-key"
            label="AWS secret access key"
            value={awsSecretAccessKey}
            onChange={onAwsSecretAccessKeyChange}
          />
          <SecretInput
            id="source-aws-session-token"
            label="AWS session token (optional)"
            value={awsSessionToken}
            required={false}
            onChange={onAwsSessionTokenChange}
          />
        </>
      ) : null}
      {mode === 'gcs-oauth' ? (
        <SecretInput
          id="source-gcs-token"
          label="GCS OAuth access token"
          value={gcsAccessToken}
          onChange={onGcsAccessTokenChange}
        />
      ) : null}
    </fieldset>
  );
}

function SecretInput({
  id,
  label,
  value,
  required = true,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs font-medium text-fg" htmlFor={id}>
      {label}
      <input
        id={id}
        type="password"
        required={required}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${UI_FIELD_CLASS} mt-1 font-mono`}
      />
    </label>
  );
}

function AlignmentProgress({ progress }: { progress: BamTrackImportProgress }) {
  return (
    <div role="status" aria-live="polite" className="space-y-1.5 text-xs text-fg-muted">
      <div className="flex items-center justify-between gap-3">
        <span>{`Current step: ${progress.label}`}</span>
        <span className="shrink-0">
          {`Step ${progress.stepNumber} of ${progress.stepCount} · File ${progress.fileNumber} of ${progress.fileCount}`}
        </span>
      </div>
      <div className="truncate font-mono text-fg-subtle" title={progress.fileName}>
        {progress.fileName}
      </div>
      <progress
        aria-label="Aligned-read import progress"
        aria-valuetext={progress.label}
        className="h-1.5 w-full overflow-hidden rounded-full accent-accent"
      />
    </div>
  );
}

function Notice({
  notice,
  testId,
}: {
  notice: BamTrackImportNotice | IndexedTrackImportNotice;
  testId: string;
}) {
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={`rounded border px-2.5 py-2 text-xs ${
        notice.kind === 'error'
          ? 'border-error/40 text-error'
          : notice.kind === 'warn'
            ? 'border-warning/40 text-warning'
            : 'border-success/40 text-success'
      }`}
    >
      {notice.text}
    </div>
  );
}

function Unavailable({ assemblyDisplayName }: { assemblyDisplayName: string }) {
  return (
    <p
      role="status"
      className="mb-3 rounded border border-warning/40 px-3 py-2 text-xs text-warning"
    >
      Public catalog loading is not mapped for {assemblyDisplayName}. Connect a track hub that
      publishes this assembly below, or use local files and direct URLs whose references match it.
    </p>
  );
}

function TrackSearchResults({
  query,
  tracks,
  schemaTracks,
  catalogSize,
  countsAreComplete,
  searching,
  emptyText,
  searchError,
  rowFailures,
  addedCatalogIds,
  addingTrack,
  onAddTrack,
  onTrackInView,
  onAddingTrackChange,
  onAddStart,
  onAddError,
}: {
  query: string;
  tracks: ReadonlyArray<UcscCatalogLeaf>;
  schemaTracks: ReadonlyArray<UcscCatalogLeaf>;
  catalogSize: number | null;
  countsAreComplete: boolean;
  searching: boolean;
  emptyText: string;
  searchError: string | null;
  rowFailures: Readonly<Record<string, CatalogTrackFailure>>;
  addedCatalogIds: ReadonlySet<string>;
  addingTrack: string | null;
  onAddTrack: (track: UcscCatalogLeaf) => Promise<'added' | 'duplicate'>;
  onTrackInView: (track: UcscCatalogLeaf) => void;
  onAddingTrackChange: (trackId: string | null) => void;
  onAddStart: (catalogId: string) => void;
  onAddError: (catalogId: string, error: unknown) => void;
}) {
  const addOperationGenerationRef = useRef(0);
  useEffect(
    () => () => {
      addOperationGenerationRef.current += 1;
    },
    []
  );

  const addTrack = (track: UcscCatalogLeaf) => {
    const operationGeneration = ++addOperationGenerationRef.current;
    onAddStart(track.catalogId);
    onAddingTrackChange(track.catalogId);
    void onAddTrack(track)
      .then((result) => {
        if (operationGeneration !== addOperationGenerationRef.current) return;
        if (result === 'added' || result === 'duplicate') onTrackInView(track);
      })
      .catch((error) => {
        if (operationGeneration !== addOperationGenerationRef.current) return;
        onAddError(track.catalogId, error);
      })
      .finally(() => {
        if (operationGeneration === addOperationGenerationRef.current) {
          onAddingTrackChange(null);
        }
      });
  };

  return (
    <>
      {searchError ? (
        <p
          role="alert"
          className="mt-3 rounded border border-error/40 px-3 py-2 text-xs text-error"
        >
          {toUserMessage(searchError, 'tracks.loadFailed')}
        </p>
      ) : null}
      <CatalogTrackTable
        query={query}
        tracks={tracks}
        schemaTracks={schemaTracks}
        catalogSize={catalogSize}
        countsAreComplete={countsAreComplete}
        searching={searching}
        emptyText={emptyText}
        rowFailures={rowFailures}
        addingTrack={addingTrack}
        addedCatalogIds={addedCatalogIds}
        onAdd={addTrack}
      />
    </>
  );
}

function publicTrackFailure(error: unknown): CatalogTrackFailure {
  const message = trackFailureMessage(error);
  if (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  ) {
    return { message, retryable: error.retryable };
  }
  return { message, retryable: false };
}

function trackFailureMessage(error: unknown): UserMessage {
  console.warn('[AddTrackDialog] Track operation failed', error);
  return toUserMessage(error, 'tracks.loadFailed');
}
