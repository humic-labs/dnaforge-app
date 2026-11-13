import { toUserMessage } from '@waypoint/user-messages';
import { beginSkillObservation } from '../../lib/skill-operation-telemetry';
import type { SkillAction, SkillObservationContext } from '../../shared/skill-operation-telemetry';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { platform } from '../../platform';
import {
  SETTINGS_DANGER_BUTTON_CLASS,
  SETTINGS_FIELD_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SettingsSelect,
} from '../../components/SettingsSubsection';
import { XIcon } from '../../components/icons/glyphs';
import type {
  AgentCapabilitySnapshot,
  AgentManagedProvider,
  AgentManagedSkill,
  AgentManagedSkillScope,
  AgentProviderSkillPolicyScope,
  AgentSkillDocument,
  AgentSkillCatalogReview,
  AgentSkillCatalogSnapshot,
  AgentSkillPackSummary,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  buildUnifiedSkillRows,
  UnifiedSkillBrowser,
  type CatalogSkillReference,
  type UnifiedSkillRow,
} from './UnifiedSkillBrowser';
import { buildInstalledSkillRows, type InstalledSkillRow } from './skill-library-model';

const PROVIDERS: Array<{ value: AgentManagedProvider; label: string }> = [
  { value: 'all', label: 'All agent runtimes' },
  { value: 'codex-sdk', label: 'Codex' },
  { value: 'claude-agent-sdk', label: 'Claude Code' },
  { value: 'grok-acp', label: 'Grok Build' },
];

const fieldClass = SETTINGS_FIELD_CLASS;

type CatalogReview = {
  key: string;
  token: string | null;
  skill: AgentSkillCatalogReview;
  contextKey: string;
  intentKey: string;
  snapshotId: string;
};

export function AgentExtensionsPanel({
  conversationId = null,
  view = 'overview',
  preferredProvider = null,
  onBack,
}: {
  conversationId?: string | null;
  view?: 'overview' | 'skills';
  preferredProvider?: AgentTransport | null;
  onBack?: () => void;
}) {
  const workspacePath = useWorkspaceStore((state) => state.folders[0]?.path ?? null);
  const [skills, setSkills] = useState<AgentManagedSkill[]>([]);
  const [codexSnapshot, setCodexSnapshot] = useState<AgentCapabilitySnapshot | null>(null);
  const [claudeSnapshot, setClaudeSnapshot] = useState<AgentCapabilitySnapshot | null>(null);
  const [grokSnapshot, setGrokSnapshot] = useState<AgentCapabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillInstructions, setSkillInstructions] = useState('');
  const [skillProvider, setSkillProvider] = useState<AgentManagedProvider>(
    preferredProvider ?? 'all'
  );
  const [skillScope, setSkillScope] = useState<AgentManagedSkillScope>('global');
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [skillImportOpen, setSkillImportOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillPacks, setSkillPacks] = useState<AgentSkillPackSummary[]>([]);
  const [catalogSnapshots, setCatalogSnapshots] = useState<AgentSkillCatalogSnapshot[]>([]);
  const [selectedUnifiedSkillKey, setSelectedUnifiedSkillKey] = useState<string | null>(null);
  const [unifiedCatalogReview, setUnifiedCatalogReview] = useState<CatalogReview | null>(null);
  const [nativeSkillInspection, setNativeSkillInspection] = useState<{
    key: string;
    skill: AgentSkillDocument;
  } | null>(null);
  const [skillDetailLoadingKey, setSkillDetailLoadingKey] = useState<string | null>(null);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
  const [cliPolicyScope, setCliPolicyScope] = useState<AgentProviderSkillPolicyScope>('global');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const contextKey = JSON.stringify([workspacePath, conversationId, preferredProvider]);
  const intentKey = JSON.stringify([
    contextKey,
    skillProvider,
    skillScope,
    skillScope === 'workspace' ? workspacePath : null,
  ]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const intentRef = useRef(intentKey);
  intentRef.current = intentKey;
  const mutationRequest = useRef(0);
  const inventoryRequest = useRef(0);
  const catalogRequest = useRef(0);
  const detailRequest = useRef(0);
  const reviewRef = useRef<CatalogReview | null>(null);
  const detailPending = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const installAttempt = useRef<object | null>(null);
  const inventoryContext = useRef(contextKey);
  const [loadedContext, setLoadedContext] = useState(contextKey);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [catalogState, setCatalogState] = useState<
    'idle' | 'loading' | 'ready' | 'partial' | 'error'
  >('idle');
  const [catalogFailures, setCatalogFailures] = useState<
    Array<{ packId: string; label: string; error: string }>
  >([]);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const lastCatalogRetry = useRef(0);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState<{
    key: string;
    intentKey: string;
    revision: string;
    state: 'error' | 'unknown' | 'committed';
    stage?: string;
  } | null>(null);
  const currentContext = loadedContext === contextKey;

  useEffect(() => {
    reviewRef.current = null;
    detailRequest.current += 1;
    detailPending.current = null;
    setSkillDetailLoadingKey(null);
    setUnifiedCatalogReview((review) => (review ? { ...review, token: null } : null));
    return () => {
      mutationRequest.current += 1;
      inventoryRequest.current += 1;
      catalogRequest.current += 1;
      detailRequest.current += 1;
      reviewRef.current = null;
      detailPending.current = null;
      installAttempt.current = null;
    };
  }, [contextKey]);
  useEffect(() => {
    reviewRef.current = null;
    detailRequest.current += 1;
    detailPending.current = null;
    setSkillDetailLoadingKey(null);
    setUnifiedCatalogReview((review) => (review ? { ...review, token: null } : null));
  }, [intentKey]);

  const refresh = useCallback(
    async (onManaged?: (rows: AgentManagedSkill[]) => void) => {
      if (contextRef.current !== contextKey) return false;
      const request = ++inventoryRequest.current;
      const context = contextKey;
      const owns = () => contextRef.current === context && request === inventoryRequest.current;
      if (inventoryContext.current !== context) {
        inventoryContext.current = context;
        setLoadedContext(context);
        setSkills([]);
        setSkillPacks([]);
        setPacksLoaded(false);
        setCatalogSnapshots([]);
        setCodexSnapshot(null);
        setClaudeSnapshot(null);
        setGrokSnapshot(null);
        setCatalogFailures([]);
        setCatalogState('idle');
        setSelectedUnifiedSkillKey(null);
        selectedKeyRef.current = null;
        setUnifiedCatalogReview(null);
        setNativeSkillInspection(null);
        setSkillDetailError(null);
        setCatalogAttempt(null);
        setMutationNotice(null);
        setBusyKey(null);
      }
      setLoading(true);
      setError(null);
      const capabilities = platform().agentCapabilities;
      const results = await Promise.allSettled([
        Promise.resolve()
          .then(() => capabilities.listManaged({ workspacePath, conversationId }))
          .then((managed) => {
            if (owns()) {
              setSkills(managed.skills ?? []);
              onManaged?.(managed.skills ?? []);
              setCatalogAttempt((current) =>
                current?.state === 'unknown' || current?.state === 'committed' ? null : current
              );
            }
          }),
        Promise.resolve()
          .then(() => capabilities.listSkillPacks())
          .then((packs) => {
            if (owns()) {
              setSkillPacks(packs);
              setPacksLoaded(true);
            }
          })
          .catch((cause) => {
            if (owns()) {
              setCatalogState('error');
              setCatalogFailures([
                {
                  packId: 'sources',
                  label: 'Skill sources',
                  error: toUserMessage(cause, 'failure.could-not-load-skill-sources'),
                },
              ]);
            }
            throw cause;
          }),
        ...(
          [
            ['codex-sdk', setCodexSnapshot],
            ['claude-agent-sdk', setClaudeSnapshot],
            ['grok-acp', setGrokSnapshot],
          ] as const
        ).map(async ([provider, setSnapshot]) => {
          const snapshot = await capabilities.discover({
            provider,
            workspacePath,
            ...(conversationId ? { conversationId } : {}),
          });
          if (owns()) setSnapshot(snapshot.provider === provider ? snapshot : null);
        }),
      ]);
      if (!owns()) return false;
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected')
        setError(toUserMessage(failure.reason, 'failure.could-not-load-some-skills'));
      setLoading(false);
      return !failure;
    },
    [conversationId, workspacePath, contextKey]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!currentContext || !packsLoaded) return;
    const request = ++catalogRequest.current;
    const context = contextKey;
    const owns = () => contextRef.current === context && request === catalogRequest.current;
    const packs = skillPacks.filter((pack) => pack.delivery === 'dnaforge');
    const forceRefresh = lastCatalogRetry.current !== catalogRetry;
    lastCatalogRetry.current = catalogRetry;
    if (!packs.length) {
      setCatalogSnapshots([]);
      setCatalogFailures([]);
      setCatalogState('ready');
      return;
    }
    setCatalogState('loading');
    const measurement = beginSkillObservation('discover', { source: 'catalog' });
    void Promise.allSettled(
      packs.map(async (pack) => {
        const result = await platform().agentCapabilities.browseSkillPack({
          packId: pack.id,
          ...(forceRefresh ? { forceRefresh: true } : {}),
        });
        if (!result.ok) throw new Error(result.error);
        return result.snapshot;
      })
    ).then((results) => {
      if (!owns()) {
        measurement.settle('owner_return', 'superseded', { freshness: 'superseded' });
        return;
      }
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              {
                packId: packs[index].id,
                label: packs[index].name,
                error: toUserMessage(result.reason, 'failure.could-not-load-this-skill-source'),
              },
            ]
          : []
      );
      setCatalogSnapshots((previous) => {
        const retained = new Map(
          previous
            .filter((snapshot) => packs.some((pack) => pack.id === snapshot.packId))
            .map((snapshot) => [snapshot.packId, snapshot])
        );
        for (const result of results)
          if (result.status === 'fulfilled') retained.set(result.value.packId, result.value);
        return [...retained.values()];
      });
      setCatalogFailures(failures);
      setCatalogState(
        failures.length === packs.length ? 'error' : failures.length ? 'partial' : 'ready'
      );
      measurement.settle(
        'owner_return',
        failures.length === packs.length ? 'failed' : failures.length ? 'partial' : 'accepted',
        { authority: 'owner_return' }
      );
    });
    return () => {
      if (catalogRequest.current === request) catalogRequest.current += 1;
    };
  }, [skillPacks, packsLoaded, catalogRetry, contextKey, currentContext]);

  const providerSnapshots = useMemo(
    () =>
      (currentContext ? [codexSnapshot, claudeSnapshot, grokSnapshot] : []).filter(
        Boolean
      ) as AgentCapabilitySnapshot[],
    [claudeSnapshot, codexSnapshot, grokSnapshot, currentContext]
  );
  const installedSkillRows = useMemo(
    () => buildInstalledSkillRows(currentContext ? skills : [], providerSnapshots, workspacePath),
    [providerSnapshots, skills, currentContext, workspacePath]
  );
  const enabledSkillCount = useMemo(
    () => installedSkillRows.filter((skill) => skill.enabled).length,
    [installedSkillRows]
  );
  const unifiedSkillRows = useMemo(
    () =>
      buildUnifiedSkillRows(
        installedSkillRows,
        currentContext ? skillPacks : [],
        currentContext ? catalogSnapshots : []
      ),
    [catalogSnapshots, installedSkillRows, skillPacks, currentContext]
  );

  const runMutation = useCallback(
    async (
      key: string,
      operation: () => Promise<{ ok: true } | { ok: false; error: string }>,
      metadata: {
        action: SkillAction;
        context?: SkillObservationContext;
        observation?: ReturnType<typeof beginSkillObservation>;
      } = { action: 'save' }
    ) => {
      if (contextRef.current !== contextKey) return false;
      const request = ++mutationRequest.current;
      const context = contextKey;
      const owns = () => contextRef.current === context && request === mutationRequest.current;
      if (!owns()) return false;
      const measurement =
        metadata.observation ?? beginSkillObservation(metadata.action, metadata.context);
      let accepted = false;
      setBusyKey(key);
      setError(null);
      try {
        const result = await operation();
        if (!owns()) {
          measurement.settle('owner_return', 'superseded', { freshness: 'superseded' });
          return false;
        }
        if (!result.ok) {
          measurement.settle('owner_return', 'refused', { authority: 'owner_return' });
          throw new Error(result.error);
        }
        accepted = true;
        measurement.settle('owner_return', 'accepted', { authority: 'owner_return' });
        setConfirmKey(null);
        const observed = await refresh();
        if (owns() && !observed)
          setMutationNotice(
            'Change saved. Refresh the installed skills to check the current list.'
          );
        measurement.readback(
          !owns() ? 'superseded' : observed ? 'inventory_returned' : 'inventory_unavailable',
          { authority: 'native_inventory', freshness: owns() ? 'current_readback' : 'superseded' }
        );
        return true;
      } catch (cause) {
        if (accepted)
          measurement.readback('inventory_unavailable', { authority: 'native_inventory' });
        else
          measurement.settle('owner_return', 'failed', {
            freshness: owns() ? 'not_attested' : 'superseded',
          });
        if (owns()) setError(toUserMessage(cause, 'failure.the-agent-extension-change-failed'));
        return false;
      } finally {
        if (owns()) setBusyKey(null);
      }
    },
    [refresh, contextKey]
  );

  const resetSkillEditor = () => {
    setEditingSkillId(null);
    setSkillEditorOpen(false);
    setSkillName('');
    setSkillDescription('');
    setSkillInstructions('');
    setSkillScope('global');
  };

  const saveSkill = async (event: FormEvent) => {
    event.preventDefault();
    const existingSkill = editingSkillId
      ? skills.find((skill) => skill.id === editingSkillId)
      : null;
    const saved = await runMutation(
      'save-skill',
      () =>
        platform().agentCapabilities.saveSkill({
          ...(editingSkillId ? { id: editingSkillId } : {}),
          name: skillName,
          description: skillDescription,
          instructions: skillInstructions,
          provider: existingSkill?.provider ?? skillProvider,
          scope: skillScope,
          workspacePath: skillScope === 'workspace' ? workspacePath : null,
          enabled: existingSkill?.enabled ?? true,
        }),
      {
        action: existingSkill ? 'update' : 'install',
        context: {
          host: existingSkill?.provider ?? skillProvider,
          scope: skillScope,
          source: 'local',
        },
      }
    );
    if (saved) resetSkillEditor();
  };

  const importSkill = async () => {
    const measurement = beginSkillObservation('import', {
      host: skillProvider,
      scope: skillScope,
      source: 'local',
    });
    setError(null);
    try {
      const sourcePath = await platform().dialog.open({
        directory: true,
        multiple: false,
        title: 'Import skill folder',
      });
      if (typeof sourcePath !== 'string') {
        measurement.settle('owner_return', 'cancelled', { authority: 'surface' });
        return;
      }
      await runMutation(
        'import-skill',
        () =>
          platform().agentCapabilities.importSkill({
            sourcePath,
            provider: skillProvider,
            scope: skillScope,
            workspacePath: skillScope === 'workspace' ? workspacePath : null,
          }),
        { action: 'import', observation: measurement }
      );
    } catch (cause) {
      measurement.settle('owner_return', 'failed');
      setError(toUserMessage(cause, 'failure.could-not-import-the-skill-folder'));
    }
  };

  const toggleInstalledSkill = async (row: InstalledSkillRow) => {
    const enabled = !row.enabled;
    await runMutation(
      `installed-skill:${row.key}`,
      async () => {
        if (row.managedSkill && row.managedSkill.enabled !== enabled) {
          return platform().agentCapabilities.setSkillEnabled({
            id: row.managedSkill.id,
            enabled,
          });
        }
        if (row.nativeSkill) {
          const { control, snapshot } = row.nativeSkill;
          if ((control.dnaforgePolicy?.enabled !== false) === enabled) return { ok: true };
          const hasWorkspaceOverride = control.dnaforgePolicy?.scope === 'workspace';
          const scope = hasWorkspaceOverride ? 'workspace' : cliPolicyScope;
          return platform().agentCapabilities.setProviderSkillEnabled({
            selection: {
              snapshotId: snapshot.snapshotId,
              provider: control.provider,
              capabilityId: control.id,
            },
            enabled,
            scope,
            workspacePath: scope === 'workspace' ? workspacePath : null,
          });
        }
        return { ok: true };
      },
      {
        action: enabled ? 'enable' : 'disable',
        context: {
          host: row.managedSkill?.provider ?? row.nativeSkill?.control.provider ?? 'unknown',
          scope:
            row.managedSkill?.scope ??
            (row.nativeSkill?.control.dnaforgePolicy?.scope === 'workspace'
              ? 'workspace'
              : cliPolicyScope),
          source: row.managedSkill?.origin ?? 'provider_native',
        },
      }
    );
  };

  const editInstalledSkill = useCallback((skill: InstalledSkillRow) => {
    const managedSkill = skill.managedSkill;
    if (!managedSkill) return;
    setEditingSkillId(managedSkill.id);
    setSkillEditorOpen(true);
    setSkillName(managedSkill.name);
    setSkillDescription(managedSkill.description);
    setSkillInstructions(managedSkill.instructions);
    setSkillProvider(managedSkill.provider);
    setSkillScope(managedSkill.scope);
  }, []);

  const removeInstalledSkill = useCallback(
    (skill: InstalledSkillRow) => {
      const id = skill.managedSkill?.id;
      if (!id) return;
      const key = `skill:${id}`;
      if (confirmKey !== key) {
        setConfirmKey(key);
        return;
      }
      void runMutation(key, () => platform().agentCapabilities.removeSkill({ id }), {
        action: 'remove',
        context: {
          host: skill.managedSkill?.provider,
          scope: skill.managedSkill?.scope,
          source: skill.managedSkill?.origin,
        },
      });
    },
    [confirmKey, runMutation]
  );

  const inheritInstalledSkill = useCallback(
    (skill: InstalledSkillRow) => {
      const nativeSkill = skill.nativeSkill;
      if (!nativeSkill || !workspacePath) return;
      void runMutation(
        `native-skill-inherit:${nativeSkill.control.id}`,
        () =>
          platform().agentCapabilities.setProviderSkillEnabled({
            selection: {
              snapshotId: nativeSkill.snapshot.snapshotId,
              provider: nativeSkill.control.provider,
              capabilityId: nativeSkill.control.id,
            },
            inheritGlobal: true,
            scope: 'workspace',
            workspacePath,
          }),
        {
          action: 'inherit',
          context: {
            host: nativeSkill.control.provider,
            scope: 'workspace',
            source: 'provider_native',
          },
        }
      );
    },
    [runMutation, workspacePath]
  );

  const loadUnifiedCatalogReview = useCallback(
    async (catalog: CatalogSkillReference, rowKey: string) => {
      const context = contextKey;
      const intent = intentKey;
      if (contextRef.current !== context || intentRef.current !== intent) return null;
      const pendingKey = JSON.stringify([rowKey, context, intent, catalog.snapshot.snapshotId]);
      if (detailPending.current === pendingKey) return null;
      detailPending.current = pendingKey;
      const request = ++detailRequest.current;
      const owns = () =>
        contextRef.current === context &&
        intentRef.current === intent &&
        detailRequest.current === request &&
        selectedKeyRef.current === rowKey;
      reviewRef.current = null;
      setUnifiedCatalogReview((review) => (review ? { ...review, token: null } : null));
      setSkillDetailLoadingKey(rowKey);
      setSkillDetailError(null);
      const measurement = beginSkillObservation('review', {
        host: skillProvider,
        scope: skillScope,
        source: 'catalog',
      });
      try {
        const result = await platform().agentCapabilities.reviewCatalogSkill({
          snapshotId: catalog.snapshot.snapshotId,
          skillId: catalog.entry.id,
        });
        if (!owns()) {
          measurement.settle('owner_return', 'superseded', { freshness: 'superseded' });
          return null;
        }
        if (!result.ok) {
          measurement.settle('owner_return', 'refused');
          throw new Error(result.error);
        }
        if (
          result.skill.packId !== catalog.pack.id ||
          result.skill.skillId !== catalog.entry.id ||
          result.skill.revision !== catalog.snapshot.revision
        )
          throw new Error('This skill source changed. Refresh and review it again.');
        const review: CatalogReview = {
          key: rowKey,
          token: result.reviewToken,
          skill: result.skill,
          contextKey: context,
          intentKey: intent,
          snapshotId: catalog.snapshot.snapshotId,
        };
        reviewRef.current = review;
        setUnifiedCatalogReview(review);
        measurement.settle('owner_return', 'reviewed', { authority: 'owner_return' });
        return review;
      } catch (cause) {
        measurement.settle('owner_return', 'failed', {
          freshness: owns() ? 'not_attested' : 'superseded',
        });
        if (owns())
          setSkillDetailError(toUserMessage(cause, 'failure.could-not-load-the-complete-skill'));
        return null;
      } finally {
        if (detailRequest.current === request) {
          detailPending.current = null;
          setSkillDetailLoadingKey(null);
        }
      }
    },
    [contextKey, intentKey, skillProvider, skillScope]
  );

  const selectUnifiedSkill = useCallback(
    async (row: UnifiedSkillRow) => {
      selectedKeyRef.current = row.key;
      detailRequest.current += 1;
      detailPending.current = null;
      reviewRef.current = null;
      setSelectedUnifiedSkillKey(row.key);
      setSkillEditorOpen(false);
      setSkillImportOpen(false);
      setSkillDetailError(null);
      setNativeSkillInspection(null);
      setUnifiedCatalogReview(null);

      if (row.catalog) {
        await loadUnifiedCatalogReview(row.catalog, row.key);
        return;
      }
      const nativeSkill = row.installed?.nativeSkill;
      if (!nativeSkill) return;

      const request = ++detailRequest.current;
      const context = contextKey;
      const owns = () =>
        contextRef.current === context &&
        request === detailRequest.current &&
        selectedKeyRef.current === row.key;
      setSkillDetailLoadingKey(row.key);
      try {
        const result = await platform().agentCapabilities.inspectSkill({
          selection: {
            snapshotId: nativeSkill.snapshot.snapshotId,
            provider: nativeSkill.control.provider,
            capabilityId: nativeSkill.control.id,
          },
        });
        if (!owns()) return;
        if (!result.ok) throw new Error(result.error);
        setNativeSkillInspection({ key: row.key, skill: result.skill });
      } catch (cause) {
        if (owns())
          setSkillDetailError(toUserMessage(cause, 'failure.could-not-read-the-complete-skill'));
      } finally {
        if (owns()) setSkillDetailLoadingKey(null);
      }
    },
    [loadUnifiedCatalogReview, contextKey]
  );

  const addUnifiedCatalogSkill = useCallback(
    async (catalog: CatalogSkillReference, selectedRowKey?: string, initialAdd = false) => {
      if (installAttempt.current) return;
      const rowKey = selectedRowKey ?? `catalog:${catalog.pack.id}:${catalog.entry.id}`;
      selectedKeyRef.current = rowKey;
      setSelectedUnifiedSkillKey(rowKey);
      setSkillEditorOpen(false);
      setSkillImportOpen(false);
      const previousAttempt =
        catalogAttempt?.key === rowKey && catalogAttempt.intentKey === intentKey
          ? catalogAttempt
          : null;

      if (
        previousAttempt?.state === 'unknown' ||
        (previousAttempt?.state === 'committed' &&
          previousAttempt.revision === catalog.snapshot.revision)
      )
        return;
      const consumedReview =
        unifiedCatalogReview?.key === rowKey && unifiedCatalogReview.token === null;
      const changedReview =
        unifiedCatalogReview?.key === rowKey &&
        (unifiedCatalogReview.snapshotId !== catalog.snapshot.snapshotId ||
          unifiedCatalogReview.skill.revision !== catalog.snapshot.revision);
      let reviewed = reviewRef.current;
      if (
        !reviewed?.token ||
        reviewed.key !== rowKey ||
        reviewed.contextKey !== contextKey ||
        reviewed.intentKey !== intentKey ||
        contextRef.current !== contextKey ||
        intentRef.current !== intentKey ||
        reviewed.snapshotId !== catalog.snapshot.snapshotId
      ) {
        reviewed = await loadUnifiedCatalogReview(catalog, rowKey);

        if (!initialAdd || previousAttempt || consumedReview || changedReview) return;
      }
      const review = reviewed;
      if (
        !review?.token ||
        installAttempt.current ||
        reviewRef.current !== review ||
        selectedKeyRef.current !== rowKey ||
        contextRef.current !== contextKey ||
        intentRef.current !== intentKey
      )
        return;
      const measurement = beginSkillObservation('install', {
        host: skillProvider,
        scope: skillScope,
        source: 'catalog',
      });
      let accepted = false;
      const attempt = {};
      installAttempt.current = attempt;
      inventoryRequest.current += 1;
      setLoading(false);
      const owns = () =>
        installAttempt.current === attempt &&
        contextRef.current === contextKey &&
        intentRef.current === intentKey;

      reviewRef.current = null;
      setUnifiedCatalogReview({ ...review, token: null });
      setBusyKey(`install-catalog:${catalog.entry.id}`);
      setSkillDetailError(null);
      setError(null);
      setMutationNotice(null);
      try {
        const result = await platform().agentCapabilities.installCatalogSkill({
          reviewToken: review.token,
          provider: skillProvider,
          scope: skillScope,
          workspacePath: skillScope === 'workspace' ? workspacePath : null,
        });
        if (!owns()) {
          measurement.settle('owner_return', 'superseded', { freshness: 'superseded' });
          return;
        }
        if (!result.ok) {
          measurement.settle('owner_return', result.stage === 'review' ? 'refused' : 'failed', {
            authority: 'owner_return',
          });
          setCatalogAttempt({
            key: rowKey,
            intentKey,
            revision: review.skill.revision,
            state: 'error',
            stage: result.stage,
          });
          if (selectedKeyRef.current === rowKey)
            setSkillDetailError(toUserMessage(result.error, 'assistant.failed'));
          return;
        }
        accepted = true;
        measurement.settle('owner_return', 'accepted', { authority: 'owner_return' });
        setCatalogAttempt({
          key: rowKey,
          intentKey,
          revision: review.skill.revision,
          state: 'committed',
        });
        if (result.cleanupIncomplete)
          setMutationNotice('Skill installed. Temporary download cleanup is incomplete.');
        let readback: AgentManagedSkill[] = [];
        const observed = await refresh((rows) => {
          readback = rows;
        });
        const confirmed = readback.some(
          (skill) =>
            skill.id === result.skillId &&
            skill.source?.revision === review.skill.revision &&
            skill.provider === skillProvider &&
            skill.scope === skillScope &&
            skill.workspacePath === (skillScope === 'workspace' ? workspacePath : null)
        );
        if (owns() && (!observed || !confirmed))
          setMutationNotice(
            'Skill installed. Refresh the installed skills to check the current list.' +
              (result.cleanupIncomplete ? ' Temporary download cleanup is incomplete.' : '')
          );
        measurement.readback(
          !owns()
            ? 'superseded'
            : observed && confirmed
              ? 'inventory_matched'
              : 'inventory_unavailable',
          {
            authority: 'native_inventory',
            freshness: owns() ? 'current_readback' : 'superseded',
            installed: observed && confirmed ? 'installed' : 'not_attested',
          }
        );
      } catch (cause) {
        if (accepted)
          measurement.readback('inventory_unavailable', { authority: 'native_inventory' });
        else
          measurement.settle('owner_return', 'failed', {
            freshness: owns() ? 'not_attested' : 'superseded',
          });
        if (owns()) {
          setCatalogAttempt({
            key: rowKey,
            intentKey,
            revision: review.skill.revision,
            state: 'unknown',
          });
          setMutationNotice(
            'Installation outcome unknown. Refresh installed skills before trying again.'
          );
          if (selectedKeyRef.current === rowKey)
            setSkillDetailError(
              toUserMessage(cause, 'failure.the-installation-outcome-could-not-be-read')
            );
        }
      } finally {
        if (installAttempt.current === attempt) {
          installAttempt.current = null;
          setBusyKey(null);
        }
      }
    },
    [
      catalogAttempt,
      unifiedCatalogReview,
      contextKey,
      intentKey,
      loadUnifiedCatalogReview,
      refresh,
      skillProvider,
      skillScope,
      workspacePath,
    ]
  );

  const refreshObservedSkills = async () => {
    const measurement = beginSkillObservation('discover', { source: 'mixed' });
    const current = contextKey;
    const observed = await refresh();
    measurement.readback(
      contextRef.current !== current
        ? 'superseded'
        : observed
          ? 'inventory_returned'
          : 'inventory_unavailable',
      {
        authority: 'native_inventory',
        freshness: contextRef.current === current ? 'current_readback' : 'superseded',
      }
    );
    return observed;
  };

  if (view === 'overview') {
    const sharedStatus = error ? (
      <p role="alert" className="rounded-md bg-error/5 px-3 py-2 text-xs text-error">
        {toUserMessage(error, 'assistant.failed')}
      </p>
    ) : null;

    return (
      <div
        data-analytics-block
        className="ph-no-capture space-y-4"
        data-testid="agent-extensions-panel"
      >
        {sharedStatus}
        <div data-testid="capability-skills">
          <p className="mb-4 text-xs leading-5 text-fg-muted">
            {loading
              ? 'Loading skills…'
              : `${installedSkillRows.length.toLocaleString()} installed · ${enabledSkillCount.toLocaleString()} enabled`}
          </p>
          {renderSkillsManager(false)}
        </div>
      </div>
    );
  }

  function renderSkillActions(showClose: boolean) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setEditingSkillId(null);
            setSkillName('');
            setSkillDescription('');
            setSkillInstructions('');
            setSkillProvider(preferredProvider ?? 'all');
            setSkillScope('global');
            selectedKeyRef.current = null;
            detailRequest.current += 1;
            detailPending.current = null;
            reviewRef.current = null;
            setSelectedUnifiedSkillKey(null);
            setSkillImportOpen(false);
            setSkillEditorOpen(true);
            setSkillDetailError(null);
          }}
          className={SETTINGS_PRIMARY_BUTTON_CLASS}
        >
          New skill
        </button>
        <button
          type="button"
          onClick={() => {
            setEditingSkillId(null);
            setSkillProvider(preferredProvider ?? 'all');
            setSkillScope('global');
            selectedKeyRef.current = null;
            detailRequest.current += 1;
            detailPending.current = null;
            reviewRef.current = null;
            setSelectedUnifiedSkillKey(null);
            setSkillEditorOpen(false);
            setSkillImportOpen(true);
            setSkillDetailError(null);
          }}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
          aria-label="Import skill folder"
        >
          Import folder
        </button>
        {showClose && onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to AI settings"
            title="Close skills"
            className={`${SETTINGS_SECONDARY_BUTTON_CLASS} inline-flex h-9 w-9 items-center justify-center p-0`}
          >
            <XIcon size={14} />
          </button>
        ) : null}
      </>
    );
  }

  function renderSkillsManager(showHeading = true) {
    const selectedRow =
      unifiedSkillRows.find((candidate) => candidate.key === selectedUnifiedSkillKey) ?? null;
    const selectedCatalogReview =
      selectedRow &&
      unifiedCatalogReview?.key === selectedRow.key &&
      unifiedCatalogReview.contextKey === contextKey
        ? unifiedCatalogReview
        : null;
    const selectedNativeInspection =
      selectedRow && nativeSkillInspection?.key === selectedRow.key
        ? nativeSkillInspection.skill
        : null;
    const selectedManagedSkill = selectedRow?.installed?.managedSkill ?? null;
    const selectedNativeSkill = selectedRow?.installed?.nativeSkill ?? null;
    const managedDocument = selectedManagedSkill
      ? `---
name: ${selectedManagedSkill.name}
description: ${selectedManagedSkill.description}
---

${selectedManagedSkill.instructions}`
      : null;
    const selectedDocument =
      selectedCatalogReview?.skill.document ??
      selectedNativeInspection?.document ??
      managedDocument;
    const selectedFiles =
      selectedCatalogReview?.skill.files ?? selectedNativeInspection?.files ?? [];
    const selectedSourcePath =
      selectedNativeInspection?.sourcePath ??
      (selectedManagedSkill ? `${selectedManagedSkill.directoryPath}/SKILL.md` : null);
    const selectedCatalogSource = selectedCatalogReview?.skill ?? null;
    const selectedCatalogInstallation = selectedCatalogSource
      ? (skills.find(
          (skill) =>
            skill.origin === 'catalog' &&
            skill.source?.packId === selectedCatalogSource.packId &&
            skill.source.skillPath === selectedCatalogSource.skillId &&
            skill.provider === skillProvider &&
            skill.scope === skillScope &&
            skill.workspacePath === (skillScope === 'workspace' ? workspacePath : null)
        )?.source ?? null)
      : null;
    const selectedCatalogIsCurrent =
      selectedCatalogSource &&
      selectedCatalogInstallation?.revision === selectedCatalogSource.revision;
    const currentAttempt =
      catalogAttempt &&
      catalogAttempt.key === selectedRow?.key &&
      catalogAttempt.intentKey === intentKey
        ? catalogAttempt
        : null;
    const committedRevision =
      currentAttempt?.state === 'committed' &&
      currentAttempt.revision === selectedCatalogSource?.revision;
    const reviewReady = Boolean(
      selectedCatalogReview?.token &&
      selectedCatalogReview.intentKey === intentKey &&
      selectedCatalogReview.snapshotId === selectedRow?.catalog?.snapshot.snapshotId
    );

    const closeSkillSidePanel = () => {
      const measurement = beginSkillObservation('cancel', {
        host: skillProvider,
        scope: skillScope,
        source: 'local',
      });
      measurement.settle('owner_return', 'cancelled', { authority: 'surface' });
      setSkillEditorOpen(false);
      setSkillImportOpen(false);
      setEditingSkillId(null);
    };

    const detail = skillEditorOpen ? (
      <section
        role="region"
        aria-label="Skill editor"
        className="min-h-[28rem] bg-bg-subtle/30 p-5"
      >
        <h3 className="text-sm font-semibold text-fg">
          {editingSkillId ? 'Edit skill' : 'New custom skill'}
        </h3>
        <form onSubmit={(event) => void saveSkill(event)} className="mt-4 grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Name
            <input
              aria-label="Name"
              placeholder="primer-review"
              value={skillName}
              onChange={(event) => setSkillName(event.target.value.toLowerCase())}
              className={`${fieldClass} h-9`}
              required
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Use when
            <textarea
              aria-label="Use when"
              placeholder="Review primer designs before ordering."
              value={skillDescription}
              onChange={(event) => setSkillDescription(event.target.value)}
              className={`${fieldClass} min-h-20 resize-y`}
              required
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Instructions
            <textarea
              aria-label="Instructions"
              placeholder="Write the complete workflow the agent should follow."
              value={skillInstructions}
              onChange={(event) => setSkillInstructions(event.target.value)}
              className={`${fieldClass} min-h-56 resize-y font-mono leading-5`}
              required
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Available to
            <SettingsSelect
              ariaLabel="Available to"
              value={skillProvider}
              onValueChange={(next) => setSkillProvider(next as AgentManagedProvider)}
              options={PROVIDERS}
              disabled={Boolean(editingSkillId)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Scope
            <SettingsSelect
              ariaLabel="Scope"
              value={skillScope}
              onValueChange={(next) => setSkillScope(next as AgentManagedSkillScope)}
              options={[
                { value: 'global', label: 'Every workspace' },
                { value: 'workspace', label: 'This workspace', disabled: !workspacePath },
              ]}
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={closeSkillSidePanel}
              disabled={busyKey !== null}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busyKey !== null || (skillScope === 'workspace' && !workspacePath)}
              className={SETTINGS_PRIMARY_BUTTON_CLASS}
            >
              {editingSkillId ? 'Save skill' : 'Create skill'}
            </button>
          </div>
        </form>
      </section>
    ) : skillImportOpen ? (
      <section
        role="region"
        aria-label="Import skill"
        className="min-h-[28rem] bg-bg-subtle/30 p-5"
      >
        <h3 className="text-sm font-semibold text-fg">Import skill folder</h3>
        <p className="mt-2 text-xs leading-5 text-fg-muted">
          Choose a folder containing SKILL.md. Its supporting files are imported with it.
        </p>
        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Available to
            <SettingsSelect
              ariaLabel="Imported skill provider"
              value={skillProvider}
              onValueChange={(next) => setSkillProvider(next as AgentManagedProvider)}
              options={PROVIDERS}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-fg">
            Scope
            <SettingsSelect
              ariaLabel="Imported skill availability"
              value={skillScope}
              onValueChange={(next) => setSkillScope(next as AgentManagedSkillScope)}
              options={[
                { value: 'global', label: 'Every workspace' },
                { value: 'workspace', label: 'This workspace', disabled: !workspacePath },
              ]}
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={closeSkillSidePanel}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busyKey !== null || (skillScope === 'workspace' && !workspacePath)}
              onClick={() => void importSkill().then(() => setSkillImportOpen(false))}
              className={SETTINGS_PRIMARY_BUTTON_CLASS}
            >
              Choose folder…
            </button>
          </div>
        </div>
      </section>
    ) : selectedRow ? (
      <section
        role="region"
        aria-label="Skill details"
        className="min-h-[28rem] bg-bg-subtle/30 p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-base font-semibold text-fg">{selectedRow.name}</h3>
            <p className="mt-1 text-xs text-fg-muted">{selectedRow.sourceLabel}</p>
          </div>
          <span className="rounded-full bg-black/[0.05] px-2 py-1 text-[10px] font-medium text-fg-muted dark:bg-white/[0.07]">
            {selectedRow.state === 'available'
              ? 'Available'
              : selectedRow.state === 'enabled'
                ? 'Enabled'
                : 'Disabled'}
          </span>
        </div>

        <dl className="mt-4 grid gap-x-5 gap-y-2 rounded-md bg-black/[0.025] p-3 text-[11px] dark:bg-white/[0.035] sm:grid-cols-[6rem_minmax(0,1fr)]">
          <dt className="text-fg-subtle">Available to</dt>
          <dd className="text-fg">{selectedRow.hostLabel}</dd>
          <dt className="text-fg-subtle">Source</dt>
          <dd className="break-words text-fg">{selectedRow.sourceLabel}</dd>
          {selectedCatalogSource && (
            <>
              <dt className="text-fg-subtle">Repository</dt>
              <dd className="min-w-0">
                <a
                  href={selectedCatalogSource.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-accent hover:underline"
                >
                  {selectedCatalogSource.repositoryUrl}
                </a>
              </dd>
              <dt className="text-fg-subtle">Revision</dt>
              <dd className="font-mono text-fg">{selectedCatalogSource.revision.slice(0, 12)}</dd>
              <dt className="text-fg-subtle">Version</dt>
              <dd className="text-fg">{selectedCatalogSource.version ?? 'Not declared'}</dd>
              <dt className="text-fg-subtle">Path</dt>
              <dd className="break-all font-mono text-fg">
                {selectedCatalogSource.skillId}/SKILL.md
              </dd>
              <dt className="text-fg-subtle">License</dt>
              <dd className="text-fg">{selectedCatalogSource.license ?? 'Not declared'}</dd>
              {selectedCatalogSource.additionalLicenses.map((license) => (
                <Fragment key={license.key}>
                  <dt className="text-fg-subtle">{license.label}</dt>
                  <dd className="text-fg">{license.value}</dd>
                </Fragment>
              ))}
              <dt className="text-fg-subtle">Compatibility</dt>
              <dd className="text-fg">
                {selectedCatalogSource.compatibility ?? 'No requirements declared'}
              </dd>
              <dt className="text-fg-subtle">Allowed tools</dt>
              <dd className="font-mono text-fg">
                {selectedCatalogSource.allowedTools ?? 'Not restricted'}
              </dd>
            </>
          )}
          {!selectedCatalogSource && selectedSourcePath && (
            <>
              <dt className="text-fg-subtle">Path</dt>
              <dd className="break-all font-mono text-fg">{selectedSourcePath}</dd>
            </>
          )}
        </dl>

        {selectedNativeSkill && (
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5 text-xs font-medium text-fg">
              Changes apply to
              <SettingsSelect
                ariaLabel="Native skill setting scope"
                value={cliPolicyScope}
                onValueChange={(next) => setCliPolicyScope(next as AgentProviderSkillPolicyScope)}
                options={[
                  { value: 'global', label: 'Every workspace' },
                  { value: 'workspace', label: 'This workspace', disabled: !workspacePath },
                ]}
              />
            </label>
            {selectedNativeSkill.control.dnaforgePolicy?.scope === 'workspace' && (
              <button
                type="button"
                onClick={() => inheritInstalledSkill(selectedRow.installed!)}
                disabled={busyKey !== null || !workspacePath}
                className={`${SETTINGS_SECONDARY_BUTTON_CLASS} justify-self-start`}
                aria-label={`Use everywhere setting for ${selectedRow.name}`}
              >
                Use everywhere setting
              </button>
            )}
          </div>
        )}

        {skillDetailLoadingKey === selectedRow.key && (
          <p className="mt-5 text-xs text-fg-muted">Loading complete skill…</p>
        )}
        {skillDetailError && (
          <p role="alert" className="mt-4 rounded-md bg-error/10 px-3 py-2 text-xs text-error">
            {toUserMessage(skillDetailError, 'assistant.failed')}
          </p>
        )}
        {selectedDocument && (
          <div className="mt-5">
            <h4 className="text-xs font-semibold text-fg">SKILL.md</h4>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-black/[0.025] p-4 font-mono text-[11px] leading-5 text-fg dark:bg-white/[0.035]">
              {selectedDocument}
            </pre>
          </div>
        )}
        {selectedFiles.length > 0 && (
          <div className="mt-5">
            <h4 className="text-xs font-semibold text-fg">Files</h4>
            <ul className="mt-2 space-y-1">
              {selectedFiles.map((file) => (
                <li
                  key={file.path}
                  className="flex items-start justify-between gap-4 rounded-md bg-black/[0.025] px-3 py-2 text-[11px] dark:bg-white/[0.035]"
                >
                  <span className="min-w-0 break-all font-mono text-fg">{file.path}</span>
                  <span className="shrink-0 text-fg-subtle">
                    {file.byteCount.toLocaleString()} bytes
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {selectedRow.catalog && (
          <div className="mt-4 grid gap-2">
            {selectedCatalogReview &&
            (!reviewReady ||
              selectedCatalogReview.skill.revision !== selectedRow.catalog.snapshot.revision) ? (
              <p className="text-xs text-fg-muted">
                Review this source again before installing. A changed revision requires another
                Install confirmation.
              </p>
            ) : null}
            <button
              type="button"
              aria-label="Review skill again"
              disabled={busyKey !== null || skillDetailLoadingKey === selectedRow.key}
              onClick={() => void loadUnifiedCatalogReview(selectedRow.catalog!, selectedRow.key)}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              {selectedCatalogReview ? 'Review again' : 'Review skill'}
            </button>
            {currentAttempt?.state === 'error' && currentAttempt.stage ? (
              <p className="text-xs text-fg-muted">
                Installation stopped during {currentAttempt.stage}. Review again before retrying.
              </p>
            ) : null}
          </div>
        )}
        {selectedCatalogReview && selectedRow.catalog && (
          <div className="mt-5 grid gap-3 pt-2">
            {selectedCatalogInstallation ? (
              <p className="text-xs text-fg-muted">
                Installed revision {selectedCatalogInstallation.revision.slice(0, 12)}
                {selectedCatalogIsCurrent ? ' is current.' : ' will be replaced.'}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-fg">
                Install for
                <SettingsSelect
                  ariaLabel="Install skill for"
                  value={skillProvider}
                  onValueChange={(next) => setSkillProvider(next as AgentManagedProvider)}
                  options={PROVIDERS}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-fg">
                Scope
                <SettingsSelect
                  ariaLabel="Install skill availability"
                  value={skillScope}
                  onValueChange={(next) => setSkillScope(next as AgentManagedSkillScope)}
                  options={[
                    { value: 'global', label: 'Every workspace' },
                    { value: 'workspace', label: 'This workspace', disabled: !workspacePath },
                  ]}
                />
              </label>
            </div>
            <button
              type="button"
              aria-label={
                selectedCatalogIsCurrent
                  ? `${selectedRow.name} is installed`
                  : selectedCatalogInstallation
                    ? `Update ${selectedRow.name}`
                    : `Install ${selectedRow.name}`
              }
              disabled={
                busyKey !== null ||
                !reviewReady ||
                Boolean(committedRevision) ||
                currentAttempt?.state === 'unknown' ||
                !selectedCatalogReview.skill.installable ||
                Boolean(selectedCatalogIsCurrent) ||
                (skillScope === 'workspace' && !workspacePath)
              }
              onClick={() => void addUnifiedCatalogSkill(selectedRow.catalog!, selectedRow.key)}
              className={`${SETTINGS_PRIMARY_BUTTON_CLASS} justify-self-end`}
            >
              {busyKey?.startsWith('install-catalog:')
                ? 'Installing…'
                : committedRevision || selectedCatalogIsCurrent
                  ? 'Installed'
                  : selectedCatalogInstallation
                    ? 'Update skill'
                    : 'Install skill'}
            </button>
          </div>
        )}

        {selectedManagedSkill && (
          <div className="mt-5 flex flex-wrap justify-end gap-2 pt-2">
            {selectedManagedSkill.origin === 'local' && (
              <button
                type="button"
                onClick={() => editInstalledSkill(selectedRow.installed!)}
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
                aria-label={`Edit skill ${selectedRow.name}`}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => removeInstalledSkill(selectedRow.installed!)}
              disabled={busyKey !== null}
              className={SETTINGS_DANGER_BUTTON_CLASS}
              aria-label={
                confirmKey === `skill:${selectedManagedSkill.id}`
                  ? `Confirm remove skill ${selectedRow.name}`
                  : `Remove skill ${selectedRow.name}`
              }
            >
              {confirmKey === `skill:${selectedManagedSkill.id}` ? 'Confirm remove' : 'Remove'}
            </button>
          </div>
        )}
      </section>
    ) : (
      <section
        role="region"
        aria-label="Skill details"
        className="grid min-h-[28rem] place-items-center bg-bg-subtle/30 p-8"
      >
        <p className="max-w-xs text-center text-xs leading-5 text-fg-muted">
          Select a skill to inspect its complete instructions, files, and source.
        </p>
      </section>
    );

    return (
      <div
        data-analytics-block
        className={`ph-no-capture flex min-h-0 max-w-none flex-col overflow-hidden ${
          showHeading ? 'h-full' : 'h-[42rem] max-h-[calc(100vh-8rem)]'
        }`}
        data-testid="agent-skill-manager-page"
      >
        {showHeading ? (
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-fg">Skills</h2>
              <p className="mt-1 text-xs text-fg-muted">
                {loading
                  ? 'Loading skills…'
                  : `${installedSkillRows.length.toLocaleString()} installed · ${enabledSkillCount.toLocaleString()} enabled`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">{renderSkillActions(true)}</div>
          </div>
        ) : null}

        {showHeading && error ? (
          <p role="alert" className="mt-4 rounded-md bg-error/10 px-3 py-2 text-xs text-error">
            {toUserMessage(error, 'assistant.failed')}
          </p>
        ) : null}
        {mutationNotice ? (
          <p role="status" className="mt-3 text-xs text-fg-muted">
            {mutationNotice}
          </p>
        ) : null}
        {error || mutationNotice ? (
          <button
            type="button"
            disabled={loading || busyKey !== null}
            className={SETTINGS_SECONDARY_BUTTON_CLASS}
            onClick={() =>
              void refreshObservedSkills().then((observed) => {
                if (observed && contextRef.current === contextKey) setMutationNotice(null);
              })
            }
          >
            Refresh installed skills
          </button>
        ) : null}
        <UnifiedSkillBrowser
          rows={unifiedSkillRows}
          query={skillQuery}
          selectedKey={selectedUnifiedSkillKey}
          busy={busyKey !== null}
          loading={loading || !currentContext}
          catalogState={currentContext ? catalogState : 'idle'}
          catalogFailures={currentContext ? catalogFailures : []}
          onRetryCatalog={() => {
            if (!packsLoaded) void refresh();
            else setCatalogRetry((current) => current + 1);
          }}
          actions={showHeading ? undefined : renderSkillActions(false)}
          detail={detail}
          onQueryChange={setSkillQuery}
          onSelect={(row) => void selectUnifiedSkill(row)}
          onClearSelection={() => {
            if (
              reviewRef.current?.token &&
              reviewRef.current.contextKey === contextKey &&
              reviewRef.current.intentKey === intentKey
            ) {
              const observation = beginSkillObservation('cancel', {
                host: skillProvider,
                scope: skillScope,
                source: 'catalog',
              });
              observation.settle('owner_return', 'cancelled', { authority: 'surface' });
            }
            selectedKeyRef.current = null;
            detailRequest.current += 1;
            detailPending.current = null;
            reviewRef.current = null;
            setSelectedUnifiedSkillKey(null);
            setUnifiedCatalogReview(null);
            setNativeSkillInspection(null);
            setSkillDetailError(null);
            setSkillEditorOpen(false);
            setSkillImportOpen(false);
          }}
          onToggle={(row) => void toggleInstalledSkill(row)}
          onAdd={(catalog, rowKey) => void addUnifiedCatalogSkill(catalog, rowKey, true)}
        />
      </div>
    );
  }

  return renderSkillsManager();
}
