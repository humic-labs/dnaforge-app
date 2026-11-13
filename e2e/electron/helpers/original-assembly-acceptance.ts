import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { DBChatTurn, DBMessage } from '../../../apps/desktop/src/db';
import type { HostedCodexAdmissionJournalRecord } from '../../../apps/desktop/src/main/hosted-codex/admission-journal';
import type { HostedCodexUserApprovalRequest } from '../../../apps/desktop/src/main/hosted-codex/hosted-gateway-workflow';
import type { HostedCodexTurnJournalRecord } from '../../../apps/desktop/src/main/hosted-codex/turn-journal';
import type { HostedCodexTurnEvent } from '../../../apps/desktop/src/shared/hosted-codex-ipc';
import type { HostedToolInventoryCounts } from '../../../apps/desktop/src/main/hosted-codex/tool-inventory-observation';

export const ORIGINAL_ASSEMBLY = {
  name: 'CMV-EGFP-p15A-demo',
  coreSha256: '1a7f240a82fc2ee9b278c3adbf47a3795a540af5b46b947a11f94277421dbc66',
  primerProfile: {
    model: 'santalucia98',
    targetPcrTm: 58,
    primerConcNm: 250,
    sodiumMm: 50,
    pbs: [
      { forward: { start: 0, end: 42 }, reverse: { start: 1374, end: 1398 } },
      { forward: { start: 1398, end: 1429 }, reverse: { start: 1592, end: 1621 } },
      { forward: { start: 1621, end: 1656 }, reverse: { start: 3864, end: 3881 } },
    ],
  },
  parts: [
    {
      file: 'pEGFP-N1.gb',
      start: 0,
      end: 1398,
      bp: 1398,
      sha256: '55241b921dee96a10a74f4ce7e5b82d06c6fc9df8fc0b033e04122d644b61b57',
      left20: 'TGGACGAGCTGTACAAGTAA',
      right20: 'ATCATAATCAGCCATACCAC',
    },
    {
      file: 'pEGFP-N1.gb',
      start: 1415,
      end: 1638,
      bp: 223,
      sha256: '78e3856db9250bcad4a6b90a07ee2bb3a307f2a90b0572fa045a08cdcc6e6b80',
      left20: 'GTCCAAACTCATCAATGTAT',
      right20: 'TTAATAAGATGATCTTCTTG',
    },
    {
      file: 'pACYC177.gb',
      start: 765,
      end: 3025,
      bp: 2260,
      sha256: '39dc4efb2aaa949df1e5d7be479dbca3b527fb7cc3113a2753e769d311eef8f9',
      left20: 'CACGAGGCAGACCTCAGCGC',
      right20: 'TAGTTATTAATAGTAATCAA',
    },
  ],
  files: {
    'pEGFP-N1.gb': '1ea0526c5497c43906518e5cc3a33c651fd5a7a7d5be5106f29cd27c648f1a13',
    'pACYC177.gb': '13abf6516a9e3a6f641f658bf3e52c2f13bce938a214c6af118d00112ff7fc66',
  },
} as const;

export const ORIGINAL_ASSEMBLY_PROMPT =
  'Create a circular Gibson assembly design named “CMV-EGFP-p15A-demo” from these plasmids. ' +
  'Use the CMV–EGFP cassette at bases 1–1398 of pEGFP-N1.gb, then SV40 polyA at bases ' +
  '1416–1638 of that file, then the p15A/KanR backbone at bases 766–3025 of pACYC177.gb. ' +
  'Coordinates are 1-based and inclusive; use all three regions forward, in that order. ' +
  "Use DNAForge's actual design tools and open the resulting assembly design for inspection. " +
  'Show source provenance, orientation and junctions, and any supported Gibson primer design. ' +
  'Save the design so I can reopen it. Ask before changing the stated intent or creating an ' +
  'additional finalized plasmid entity.';

type Status = 'PASS' | 'FAIL' | 'INCOMPLETE';
type Check = { criterion: string; status: Status };
type FileRead = { path: string; content: string; readAt: number };
type CompletedTool = Extract<HostedCodexTurnEvent, { kind: 'tool_completed' }>;
type SourceFile = keyof typeof ORIGINAL_ASSEMBLY.files;

export interface OriginalAssemblyObservations {
  workspaceRoot?: string;
  baseline?: { observedAt: number; artifactExisted: boolean; designIds: readonly string[] };
  sourceFiles?: Partial<Record<SourceFile, { bytes?: Uint8Array; documentId?: string }>>;
  turns?: readonly DBChatTurn[];
  messages?: readonly DBMessage[];
  reopenedMessages?: readonly DBMessage[];
  events?: readonly HostedCodexTurnEvent[];
  admissions?: readonly HostedCodexAdmissionJournalRecord[];
  journal?: HostedCodexTurnJournalRecord;
  approvals?: readonly { request: HostedCodexUserApprovalRequest; approved: boolean }[];
  saved?: FileRead;
  reopened?: FileRead;
  reopenedDesign?: unknown;
  renderedProduct?: string;
  openedDesign?: { designId: string; tabId: string };
  saveActions?: readonly { designId: string; at: number }[];
  processes?: {
    beforePid: number;
    exitedAt: number;
    exitCode: number | null;
    signal: string | null;
    afterPid: number;
    startedAt: number;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function rows(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.every(record) ? value : undefined;
}
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function dna(value: unknown): string | undefined {
  return typeof value === 'string' && /^[ACGT]+$/i.test(value) ? value.toUpperCase() : undefined;
}
function rc(value: string): string {
  return [...value]
    .reverse()
    .map((base) => 'TGCA'['ACGT'.indexOf(base)])
    .join('');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  return object
    ? `{${Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(',')}}`
    : (JSON.stringify(value) ?? 'null');
}
function parse(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
function successful(output: unknown): boolean {
  const value = record(output);
  return (
    output !== undefined &&
    (!value || (value.ok !== false && !(typeof value.error === 'string' && value.error.trim())))
  );
}
function circular(core: string, start: number, length: number): string {
  const offset = ((start % core.length) + core.length) % core.length;
  return (core + core).slice(offset, offset + length);
}
function normalizedPrompt(value: string): string {
  return value.replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

export function checkOriginalAssembly(observed: OriginalAssemblyObservations) {
  const checks: Check[] = [];
  const check = (criterion: string, value: boolean | undefined) =>
    checks.push({
      criterion,
      status: value === undefined ? 'INCOMPLETE' : value ? 'PASS' : 'FAIL',
    });
  const tools = observed.events?.filter(
    (event): event is CompletedTool => event.kind === 'tool_completed'
  );
  const creates = tools?.filter((tool) => tool.toolName === 'create_design');
  const created = creates?.length === 1 ? record(creates[0].output) : undefined;
  const designId =
    typeof created?.designId === 'string' && created.designId ? created.designId : undefined;
  const savedArtifact = observed.saved && parse(observed.saved.content);
  const savedDesign = record(savedArtifact?.design);
  const savedRegions = rows(savedDesign?.regions);
  const turn = observed.turns?.length === 1 ? observed.turns[0] : undefined;
  check(
    'one-completed-Hosted-turn',
    observed.turns === undefined
      ? undefined
      : !!turn &&
          turn.status === 'completed' &&
          turn.error === null &&
          turn.route_kind === 'hosted' &&
          turn.completed_at !== null &&
          turn.completed_at >= turn.started_at
  );
  check(
    'one-original-user-message',
    observed.messages === undefined
      ? undefined
      : observed.messages.filter((message) => message.role === 'user').length === 1 &&
          observed.messages.some(
            (message) =>
              message.role === 'user' &&
              normalizedPrompt(message.content) === normalizedPrompt(ORIGINAL_ASSEMBLY_PROMPT)
          )
  );
  check(
    'messages-bound-to-turn',
    observed.messages === undefined || !turn
      ? undefined
      : observed.messages.length > 0 &&
          observed.messages.every(
            (message) =>
              message.turn_id === turn.id && message.conversation_id === turn.conversation_id
          )
  );
  check(
    'one-create-design',
    tools === undefined
      ? undefined
      : creates?.length === 1 &&
          !!designId &&
          successful(creates[0].output) &&
          record(creates[0].input)?.name === ORIGINAL_ASSEMBLY.name
  );
  const mutationMatches = (
    tool: CompletedTool,
    effect: string,
    before: unknown,
    after: unknown
  ) => {
    const mutation = record(record(tool.output)?.mutation);
    return (
      !!mutation &&
      mutation.operationId === tool.toolCallId &&
      mutation.toolName === tool.toolName &&
      mutation.effect === effect &&
      record(mutation.target)?.type === 'design' &&
      record(mutation.target)?.id === designId &&
      mutation.resourceUri === `waypoint://design/${encodeURIComponent(designId!)}` &&
      mutation.beforeVersion === before &&
      mutation.afterVersion === after &&
      mutation.changed === (before !== after)
    );
  };
  const createVersion = record(created?.mutation)?.afterVersion;
  check(
    'create-output-semantics',
    creates === undefined
      ? undefined
      : creates.length === 1 &&
          !!created &&
          created.created !== false &&
          created.name === ORIGINAL_ASSEMBLY.name &&
          created.assemblyMethod === 'gibson' &&
          Number.isInteger(createVersion) &&
          Number(createVersion) >= 0 &&
          record(created.artifact)?.type === 'design' &&
          record(created.artifact)?.designId === designId &&
          mutationMatches(creates[0], 'created_design', null, createVersion)
  );

  for (const file of Object.keys(ORIGINAL_ASSEMBLY.files) as SourceFile[]) {
    const source = observed.sourceFiles?.[file];
    check(
      `input:${file}`,
      source?.bytes === undefined || source.documentId === undefined
        ? undefined
        : !!source.documentId && hash(source.bytes) === ORIGINAL_ASSEMBLY.files[file]
    );
  }
  check(
    'distinct-source-document-identities',
    observed.sourceFiles?.['pEGFP-N1.gb']?.documentId === undefined ||
      observed.sourceFiles?.['pACYC177.gb']?.documentId === undefined
      ? undefined
      : observed.sourceFiles['pEGFP-N1.gb']!.documentId !==
          observed.sourceFiles['pACYC177.gb']!.documentId
  );

  const adds = tools?.filter((tool) => tool.toolName === 'add_design_region');
  check(
    'three-original-add-calls',
    adds === undefined ||
      !designId ||
      ORIGINAL_ASSEMBLY.parts.some((part) => !observed.sourceFiles?.[part.file]?.documentId)
      ? undefined
      : adds.length === 3 &&
          adds.every((tool, index) => {
            const expected = ORIGINAL_ASSEMBLY.parts[index];
            const input = record(tool.input);
            return (
              !tool.isError &&
              successful(tool.output) &&
              input?.designId === designId &&
              input.documentId === observed.sourceFiles?.[expected.file]?.documentId &&
              input.start === expected.start + 1 &&
              input.end === expected.end &&
              input.wraps !== true
            );
          })
  );
  check(
    'add-output-material-and-identities',
    adds === undefined ||
      !savedRegions ||
      ORIGINAL_ASSEMBLY.parts.some((part) => !observed.sourceFiles?.[part.file]?.documentId)
      ? undefined
      : adds.length === 3 &&
          new Set(adds.map((tool) => record(tool.output)?.regionId)).size === 3 &&
          adds.every((tool, index) => {
            const part = ORIGINAL_ASSEMBLY.parts[index];
            const output = record(tool.output);
            const previous = index === 0 ? createVersion : record(adds[index - 1].output)?.version;
            return (
              !!output &&
              output.designId === designId &&
              typeof output.regionId === 'string' &&
              !!output.regionId &&
              output.regionId === savedRegions[index]?.id &&
              output.sourceDocumentId === observed.sourceFiles?.[part.file]?.documentId &&
              output.sourceStart === part.start &&
              output.sourceEnd === part.end &&
              output.sourceStart1Indexed === part.start + 1 &&
              output.sourceEnd1Indexed === part.end &&
              output.wraps === false &&
              output.length === part.bp &&
              output.regionCount === index + 1 &&
              output.previousVersion === previous &&
              Number.isInteger(output.version) &&
              Number(output.version) > Number(previous) &&
              mutationMatches(tool, 'added_design_region', previous, output.version)
            );
          })
  );
  const drafts = tools?.filter((tool) => tool.toolName === 'draft_design_assembly');
  const drafted = drafts?.length === 1 ? record(drafts[0].output) : undefined;
  check(
    'draft-output-ready-version',
    drafts === undefined || !savedDesign
      ? undefined
      : drafts.length === 1 &&
          !!drafted &&
          !drafts[0].isError &&
          successful(drafted) &&
          record(drafts[0].input)?.designId === designId &&
          drafted.designId === designId &&
          drafted.drafted === true &&
          drafted.assemblyState === 'ready' &&
          drafted.assemblyMethod === 'gibson' &&
          drafted.version === savedDesign.version &&
          drafted.previousVersion === record(adds?.[2]?.output)?.version &&
          drafted.regionCount === 3 &&
          drafted.homologyRegionCount === 3 &&
          drafted.primerPairCount === 3 &&
          drafted.validationErrorCount === 0 &&
          Array.isArray(drafted.validationErrors) &&
          !drafted.validationErrors.some((error) => record(error)?.severity === 'error') &&
          mutationMatches(
            drafts[0],
            'drafted_design_assembly',
            drafted.previousVersion,
            drafted.version
          )
  );
  const opens = tools?.filter(
    (tool) =>
      tool.toolName === 'open_tab' &&
      record(tool.input)?.type === 'design' &&
      record(tool.input)?.entityId === designId
  );
  const openedByCreate =
    creates?.length === 1 && record(creates[0].input)?.open === true && created?.opened === true;
  const openedTabId = opens?.length
    ? record(opens[opens.length - 1].output)?.tabId
    : openedByCreate
      ? created?.tabId
      : undefined;
  check(
    'actual-opened-design',
    tools === undefined || observed.openedDesign === undefined || !designId
      ? undefined
      : observed.openedDesign.designId === designId &&
          typeof openedTabId === 'string' &&
          !!openedTabId &&
          observed.openedDesign.tabId === openedTabId &&
          (opens?.every((tool) => !tool.isError && successful(tool.output)) ?? false)
  );
  const orderedNames = tools
    ?.map((tool) => tool.toolName)
    .filter((name) =>
      ['create_design', 'add_design_region', 'draft_design_assembly'].includes(name)
    );
  check(
    'original-mutation-order',
    orderedNames === undefined
      ? undefined
      : canonical(orderedNames) ===
          canonical([
            'create_design',
            'add_design_region',
            'add_design_region',
            'add_design_region',
            'draft_design_assembly',
          ])
  );
  check(
    'tool-event-history-identity',
    tools === undefined || observed.messages === undefined || !turn
      ? undefined
      : tools.length > 0 &&
          new Set(tools.map((tool) => tool.toolCallId)).size === tools.length &&
          new Set(observed.messages.map((message) => message.id)).size ===
            observed.messages.length &&
          observed.messages.filter((message) => message.role === 'tool').length === tools.length &&
          tools.every((tool) => {
            const matches = observed.messages!.filter(
              (message) => message.role === 'tool' && message.tool_call_id === tool.toolCallId
            );
            const payload = matches.length === 1 ? parse(matches[0].content) : undefined;
            return (
              tool.turnId === turn.id &&
              !!tool.toolCallId &&
              !tool.isError &&
              successful(tool.output) &&
              matches.length === 1 &&
              !!matches[0].id &&
              matches[0].tool_name === tool.toolName &&
              payload?.isError !== true &&
              !!payload &&
              Object.hasOwn(payload, 'input') &&
              Object.hasOwn(payload, 'output') &&
              canonical(payload.input) === canonical(tool.input) &&
              canonical(payload.output) === canonical(tool.output)
            );
          })
  );

  const journal = observed.journal;
  check(
    'one-main-admission',
    observed.admissions === undefined || !journal || !observed.workspaceRoot
      ? undefined
      : observed.admissions.length === 1 &&
          observed.admissions[0].admitted &&
          observed.admissions[0].identity.workflowId === journal.identity.workflowId &&
          observed.admissions[0].identity.runId === journal.identity.runId &&
          observed.admissions[0].identity.turnId === journal.identity.turnId &&
          'workspacePath' in observed.admissions[0].identity &&
          observed.admissions[0].identity.workspacePath === observed.workspaceRoot
  );
  check(
    'main-journal-tool-binding',
    journal === undefined || tools === undefined || !turn
      ? undefined
      : journal.outcome === 'completed' &&
          journal.identity.turnId === turn.id &&
          tools.every(
            (tool) =>
              tool.runId === journal.identity.runId &&
              tool.workflowId === journal.identity.workflowId
          ) &&
          canonical([...journal.gateway.completedToolCallIds].sort()) ===
            canonical(tools.map((tool) => tool.toolCallId).sort()) &&
          journal.gateway.terminalError === null &&
          journal.transport.childFailure === null
  );
  check(
    'recorded-request-bytes-and-attempts',
    journal === undefined
      ? undefined
      : journal.gateway.providerAttempts > 0 &&
          journal.gateway.providerAttempts <= 24 &&
          journal.transport.requestSizes.length > 0 &&
          journal.transport.requestSizes.every(
            (size) =>
              size.maximumBytes === 2 * 1024 * 1024 &&
              size.measuredBytes > 0 &&
              size.measuredBytes <= size.maximumBytes &&
              size.disposition === 'accepted' &&
              size.gatewayAttempted
          )
  );
  const inventoryCheck = (): boolean | undefined => {
    if (!journal || !turn) return undefined;
    if (journal.identity.turnId !== turn.id) return false;
    const requests = journal.transport.requestSizes.filter(
      (size) => size.disposition === 'accepted' && size.gatewayAttempted
    );
    if (requests.length === 0) return undefined;
    const nonnegativeInteger = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (
      requests.some((size) => !nonnegativeInteger(size.requestSequence)) ||
      new Set(requests.map((size) => size.requestSequence)).size !== requests.length
    )
      return false;
    const seen = new Set<number>();
    const inventories: HostedToolInventoryCounts[] = [];
    let incomplete = false;
    for (const stream of journal.transport.responseStreams) {
      const inventory = stream.toolInventory;
      if (stream.requestSequence !== undefined) {
        if (
          !nonnegativeInteger(stream.requestSequence) ||
          seen.has(stream.requestSequence) ||
          !requests.some((size) => size.requestSequence === stream.requestSequence)
        )
          return false;
        seen.add(stream.requestSequence);
      } else incomplete = true;
      if (inventory === undefined) {
        incomplete = true;
        continue;
      }
      if (!record(inventory)) return false;
      if (inventory.status === 'incomplete') {
        incomplete = true;
        continue;
      }
      if (inventory.status !== 'observed') return false;
      const fields = [
        'projectionSequence',
        'authorizationCatalogDefinitionCount',
        'registeredChildDefinitionCount',
        'childOfferedDefinitionCount',
        'gatewayBaseDefinitionCount',
        'gatewayForwardedDefinitionCount',
        'retainedDefinitionCount',
        'maxRetainedDefinitionCount',
        'acceptedDiscoveryPageCount',
        'lastAcceptedDiscoveryPageDefinitionCount',
        'maxAcceptedDiscoveryPageDefinitionCount',
      ] as const;
      if (
        !nonnegativeInteger(inventory.requestSequence) ||
        fields.some((field) => !nonnegativeInteger(inventory[field]))
      )
        return false;
      if (
        stream.requestSequence !== undefined &&
        inventory.requestSequence !== stream.requestSequence
      )
        return false;
      if (!requests.some((size) => size.requestSequence === inventory.requestSequence))
        return false;
      if (
        inventory.authorizationCatalogDefinitionCount === 0 ||
        inventory.registeredChildDefinitionCount === 0 ||
        inventory.registeredChildDefinitionCount > 128 ||
        inventory.childOfferedDefinitionCount === 0 ||
        inventory.childOfferedDefinitionCount > inventory.registeredChildDefinitionCount ||
        inventory.gatewayBaseDefinitionCount > inventory.childOfferedDefinitionCount ||
        inventory.childOfferedDefinitionCount - inventory.gatewayBaseDefinitionCount > 1 ||
        inventory.gatewayForwardedDefinitionCount !==
          inventory.gatewayBaseDefinitionCount + inventory.retainedDefinitionCount ||
        inventory.gatewayForwardedDefinitionCount > 48 ||
        inventory.retainedDefinitionCount > inventory.maxRetainedDefinitionCount ||
        inventory.maxRetainedDefinitionCount > 32 ||
        inventory.maxRetainedDefinitionCount > inventory.authorizationCatalogDefinitionCount ||
        inventory.lastAcceptedDiscoveryPageDefinitionCount >
          inventory.maxAcceptedDiscoveryPageDefinitionCount ||
        inventory.maxAcceptedDiscoveryPageDefinitionCount > 8 ||
        inventory.maxAcceptedDiscoveryPageDefinitionCount > inventory.maxRetainedDefinitionCount ||
        inventory.maxRetainedDefinitionCount >
          inventory.acceptedDiscoveryPageCount *
            inventory.maxAcceptedDiscoveryPageDefinitionCount ||
        (inventory.acceptedDiscoveryPageCount === 0 &&
          (inventory.maxRetainedDefinitionCount !== 0 ||
            inventory.maxAcceptedDiscoveryPageDefinitionCount !== 0 ||
            inventory.lastAcceptedDiscoveryPageDefinitionCount !== 0))
      )
        return false;
      inventories.push(inventory);
    }
    inventories.sort((left, right) => left.projectionSequence - right.projectionSequence);
    if (new Set(inventories.map((item) => item.projectionSequence)).size !== inventories.length)
      return false;
    for (let index = 0; index < inventories.length; index++) {
      const current = inventories[index],
        prior = inventories[index - 1];
      if (current.projectionSequence !== index) incomplete = true;
      if (
        prior &&
        (current.authorizationCatalogDefinitionCount !==
          prior.authorizationCatalogDefinitionCount ||
          current.registeredChildDefinitionCount !== prior.registeredChildDefinitionCount ||
          current.acceptedDiscoveryPageCount < prior.acceptedDiscoveryPageCount ||
          current.maxAcceptedDiscoveryPageDefinitionCount <
            prior.maxAcceptedDiscoveryPageDefinitionCount ||
          current.maxRetainedDefinitionCount < prior.maxRetainedDefinitionCount ||
          (current.acceptedDiscoveryPageCount === prior.acceptedDiscoveryPageCount &&
            (current.maxAcceptedDiscoveryPageDefinitionCount !==
              prior.maxAcceptedDiscoveryPageDefinitionCount ||
              current.lastAcceptedDiscoveryPageDefinitionCount !==
                prior.lastAcceptedDiscoveryPageDefinitionCount ||
              current.maxRetainedDefinitionCount !== prior.maxRetainedDefinitionCount ||
              current.retainedDefinitionCount > prior.retainedDefinitionCount)))
      )
        return false;
    }
    const summary = journal.transport.toolInventorySummary;
    if (summary === undefined) incomplete = true;
    else {
      if (!record(summary)) return false;
      if (summary.status === 'incomplete') incomplete = true;
      else {
        if (summary.status !== 'observed') return false;
        const fields = [
          'projectionCount',
          'authorizationCatalogDefinitionCount',
          'registeredChildDefinitionCount',
          'retainedDefinitionCount',
          'maxRetainedDefinitionCount',
          'acceptedDiscoveryPageCount',
          'lastAcceptedDiscoveryPageDefinitionCount',
          'maxAcceptedDiscoveryPageDefinitionCount',
        ] as const;
        if (
          fields.some((field) => !nonnegativeInteger(summary[field])) ||
          summary.authorizationCatalogDefinitionCount === 0 ||
          summary.registeredChildDefinitionCount === 0 ||
          summary.registeredChildDefinitionCount > 128 ||
          summary.retainedDefinitionCount > summary.maxRetainedDefinitionCount ||
          summary.maxRetainedDefinitionCount > 32 ||
          summary.maxRetainedDefinitionCount > summary.authorizationCatalogDefinitionCount ||
          summary.lastAcceptedDiscoveryPageDefinitionCount >
            summary.maxAcceptedDiscoveryPageDefinitionCount ||
          summary.maxAcceptedDiscoveryPageDefinitionCount > 8 ||
          summary.maxAcceptedDiscoveryPageDefinitionCount > summary.maxRetainedDefinitionCount ||
          summary.maxRetainedDefinitionCount >
            summary.acceptedDiscoveryPageCount * summary.maxAcceptedDiscoveryPageDefinitionCount ||
          summary.projectionCount < inventories.length ||
          summary.projectionCount < requests.length ||
          inventories.some((item) => item.projectionSequence >= summary.projectionCount)
        )
          return false;
        if (summary.projectionCount > requests.length) incomplete = true;
        const last = inventories[inventories.length - 1];
        if (
          last &&
          (summary.authorizationCatalogDefinitionCount !==
            last.authorizationCatalogDefinitionCount ||
            summary.registeredChildDefinitionCount !== last.registeredChildDefinitionCount ||
            summary.acceptedDiscoveryPageCount < last.acceptedDiscoveryPageCount ||
            summary.maxAcceptedDiscoveryPageDefinitionCount <
              last.maxAcceptedDiscoveryPageDefinitionCount ||
            summary.maxRetainedDefinitionCount < last.maxRetainedDefinitionCount ||
            (summary.acceptedDiscoveryPageCount === last.acceptedDiscoveryPageCount &&
              (summary.lastAcceptedDiscoveryPageDefinitionCount !==
                last.lastAcceptedDiscoveryPageDefinitionCount ||
                summary.maxAcceptedDiscoveryPageDefinitionCount !==
                  last.maxAcceptedDiscoveryPageDefinitionCount ||
                summary.maxRetainedDefinitionCount !== last.maxRetainedDefinitionCount ||
                (summary.projectionCount === inventories.length &&
                  summary.retainedDefinitionCount !== last.retainedDefinitionCount))))
        )
          return false;
      }
    }
    return incomplete || seen.size !== requests.length || inventories.length !== requests.length
      ? undefined
      : true;
  };
  check('catalog-definition-and-retained-projection-ceilings', inventoryCheck());
  const mutations = tools?.filter((tool) =>
    ['create_design', 'add_design_region', 'draft_design_assembly'].includes(tool.toolName)
  );
  check(
    'scoped-mutation-approvals',
    observed.approvals === undefined || mutations === undefined || !turn
      ? undefined
      : mutations.length === 5 &&
          mutations.every((tool) => {
            const matches = observed.approvals!.filter(
              ({ request }) => request.actionId === tool.toolCallId
            );
            return (
              matches.length === 1 &&
              matches[0].approved &&
              matches[0].request.turnId === turn.id &&
              matches[0].request.toolName === tool.toolName &&
              canonical(matches[0].request.input) === canonical(tool.input)
            );
          }) &&
          observed.approvals.every(
            ({ request, approved }) =>
              !approved ||
              tools!.some(
                (tool) =>
                  request.actionId === tool.toolCallId &&
                  request.turnId === tool.turnId &&
                  request.toolName === tool.toolName &&
                  canonical(request.input) === canonical(tool.input)
              )
          )
  );

  const scientificFields = [
    'id',
    'name',
    'topology',
    'version',
    'assemblyState',
    'assemblyMethod',
    'regions',
    'spacers',
    'homologyRegions',
    'designPrimers',
    'validationErrors',
    'pcrPolymerase',
    'acceptedAssemblyVersions',
    'activeAcceptedAssemblyVersionId',
  ];
  const material = (label: string, design: Record<string, unknown> | undefined) => {
    check(`${label}:identity`, !design || !designId ? undefined : design.id === designId);
    check(
      `${label}:ready-circular-Gibson`,
      !design
        ? undefined
        : design.name === ORIGINAL_ASSEMBLY.name &&
            design.topology === 'circular' &&
            design.assemblyMethod === 'gibson' &&
            design.assemblyState === 'ready' &&
            Number.isInteger(design.version) &&
            Number(design.version) >= 4
    );
    const regions = rows(design?.regions);
    check(`${label}:three-regions`, !design ? undefined : regions?.length === 3);
    ORIGINAL_ASSEMBLY.parts.forEach((part, index) => {
      const region = regions?.[index];
      const sequence = dna(region?.sequence);
      check(
        `${label}:part-${index + 1}`,
        !design
          ? undefined
          : !!region &&
              !!sequence &&
              sequence.length === part.bp &&
              hash(sequence) === part.sha256 &&
              region.sourceStart === part.start &&
              region.sourceEnd === part.end &&
              region.sourceType === 'pcr' &&
              region.isPlaceholder !== true
      );
      const sourceId = observed.sourceFiles?.[part.file]?.documentId;
      check(
        `${label}:source-${index + 1}`,
        !region || sourceId === undefined ? undefined : region.sourceSequenceId === sourceId
      );
      check(
        `${label}:junction-${index}`,
        !regions
          ? undefined
          : !!sequence &&
              sequence.endsWith(part.left20) &&
              dna(regions[(index + 1) % 3]?.sequence)?.startsWith(part.right20) === true
      );
    });
    const core = regions?.map((region) => dna(region.sequence) ?? '').join('');
    check(
      `${label}:core-bases`,
      !regions ? undefined : core?.length === 3881 && hash(core) === ORIGINAL_ASSEMBLY.coreSha256
    );
    check(
      `${label}:no-extra-material`,
      !design
        ? undefined
        : Array.isArray(design.spacers) &&
            design.spacers.length === 0 &&
            (design.acceptedAssemblyVersions === undefined ||
              (Array.isArray(design.acceptedAssemblyVersions) &&
                design.acceptedAssemblyVersions.length === 0)) &&
            !design.activeAcceptedAssemblyVersionId
    );
    check(
      `${label}:no-validation-errors`,
      !design
        ? undefined
        : Array.isArray(design.validationErrors) &&
            !design.validationErrors.some((item) => record(item)?.severity === 'error')
    );
    const homologies = rows(design?.homologyRegions);
    check(
      `${label}:three-homologies`,
      !design
        ? undefined
        : homologies?.length === 3 &&
            homologies.every(
              (homology, index) =>
                homology.junctionIndex === index &&
                homology.junctionPosition === [1398, 1621, 3881][index]
            )
    );
    check(
      `${label}:homology-material`,
      !design || !core
        ? undefined
        : homologies?.length === 3 &&
            homologies.every((homology, index) => {
              const encoding = record(homology.encoding);
              const left = Number(encoding?.onLeft),
                right = Number(encoding?.onRight);
              const boundary = [1398, 1621, 3881][index];
              return (
                Number.isInteger(left) &&
                Number.isInteger(right) &&
                left >= 0 &&
                right >= 0 &&
                left + right >= 15 &&
                left + right <= 60 &&
                homology.start === (boundary - left + core.length) % core.length &&
                homology.end === (boundary + right) % core.length &&
                dna(record(homology.metadata)?.sequence) ===
                  circular(core, boundary - left, left + right)
              );
            })
    );
    const primers = rows(design?.designPrimers);
    check(
      `${label}:six-primer-oligos`,
      !design || core === undefined
        ? undefined
        : primers?.length === 3 &&
            primers.every(
              (pair, index) =>
                pair.fragmentIndex === index &&
                (['forward', 'reverse'] as const).every((direction) => {
                  const primer = record(pair[direction]);
                  const pbs = record(primer?.pbs);
                  const tail = record(primer?.overhang);
                  const start = Number(pbs?.start),
                    end = Number(pbs?.end);
                  const [left, right] = [
                    [0, 1398],
                    [1398, 1621],
                    [1621, 3881],
                  ][index];
                  const expectedBinding = ORIGINAL_ASSEMBLY.primerProfile.pbs[index][direction];
                  const expectedPbs = core.slice(start, end);
                  const oligoPbs = direction === 'reverse' ? rc(expectedPbs) : expectedPbs;
                  const junctionIndex = direction === 'forward' ? (index + 2) % 3 : index;
                  const homology = homologies?.[junctionIndex];
                  const encoding = record(homology?.encoding);
                  const boundary = [1398, 1621, 3881][junctionIndex];
                  const tailLength = Number(
                    direction === 'forward' ? encoding?.onLeft : encoding?.onRight
                  );
                  const expectedTail =
                    direction === 'forward'
                      ? circular(core, boundary - tailLength, tailLength)
                      : rc(circular(core, boundary, tailLength));
                  return (
                    !!primer &&
                    !!pbs &&
                    !!tail &&
                    primer.fragmentIndex === index &&
                    primer.direction === direction &&
                    Number.isInteger(start) &&
                    Number.isInteger(end) &&
                    left <= start &&
                    start < end &&
                    end <= right &&
                    start === expectedBinding.start &&
                    end === expectedBinding.end &&
                    dna(pbs.sequence) === oligoPbs &&
                    primer.junctionIndex === junctionIndex &&
                    Number.isInteger(tailLength) &&
                    tailLength >= 0 &&
                    tailLength < core.length &&
                    tail.length === tailLength &&
                    (tail.tailLength === undefined || tail.tailLength === tailLength) &&
                    typeof tail.sequence === 'string' &&
                    tail.sequence.toUpperCase() === expectedTail &&
                    dna(primer.sequence) === `${tail.sequence.toUpperCase()}${oligoPbs}`
                  );
                })
            )
    );
  };
  const reopenedArtifact = observed.reopened && parse(observed.reopened.content);
  for (const [label, file, artifact] of [
    ['saved', observed.saved, savedArtifact],
    ['reopened-file', observed.reopened, reopenedArtifact],
  ] as const) {
    check(
      `${label}:artifact-schema`,
      file === undefined
        ? undefined
        : !!artifact &&
            artifact.schema === 'waypoint.design.v1' &&
            artifact.kind === 'assembly-design' &&
            artifact.name === ORIGINAL_ASSEMBLY.name &&
            typeof artifact.id === 'string' &&
            !!artifact.id &&
            artifact.id === record(artifact.storage)?.id &&
            artifact.id === record(artifact.design)?.id
    );
    material(label, record(artifact?.design));
  }
  material('cold-store', record(observed.reopenedDesign));
  check(
    'cold-store-matches-saved-science',
    !savedArtifact || observed.reopenedDesign === undefined
      ? undefined
      : scientificFields.every(
          (key) =>
            canonical(record(savedArtifact.design)?.[key]) ===
            canonical(record(observed.reopenedDesign)?.[key])
        )
  );
  check(
    'actual-rendered-product',
    observed.renderedProduct === undefined
      ? undefined
      : !!dna(observed.renderedProduct) &&
          hash(dna(observed.renderedProduct)!) === ORIGINAL_ASSEMBLY.coreSha256
  );
  check(
    'new-artifact-not-stale',
    observed.baseline === undefined || !turn || !designId
      ? undefined
      : !observed.baseline.artifactExisted &&
          !observed.baseline.designIds.includes(designId) &&
          observed.baseline.observedAt <= turn.started_at
  );
  check(
    'one-save-action',
    observed.saveActions === undefined || !observed.saved || !turn || !designId
      ? undefined
      : observed.saveActions.length === 1 &&
          observed.saveActions[0].designId === designId &&
          observed.saveActions[0].at >= Number(turn.completed_at) &&
          observed.saveActions[0].at <= observed.saved.readAt
  );
  const path = observed.saved?.path;
  const rel = path && observed.workspaceRoot ? relative(observed.workspaceRoot, path) : undefined;
  check(
    'actual-file-in-project',
    rel === undefined
      ? undefined
      : isAbsolute(path!) &&
          isAbsolute(observed.workspaceRoot!) &&
          rel !== '' &&
          rel !== '..' &&
          !rel.startsWith(`..${sep}`) &&
          !isAbsolute(rel) &&
          path!.endsWith('.wpdesign.json')
  );
  check(
    'same-file-bytes-after-cold-reopen',
    !observed.saved || !observed.reopened
      ? undefined
      : observed.saved.path === observed.reopened.path &&
          observed.saved.content === observed.reopened.content
  );
  const process = observed.processes;
  check(
    'normal-exit-and-cold-process',
    !process || !observed.saved || !observed.reopened
      ? undefined
      : Number.isInteger(process.beforePid) &&
          Number.isInteger(process.afterPid) &&
          process.beforePid > 0 &&
          process.afterPid > 0 &&
          process.beforePid !== process.afterPid &&
          process.exitCode === 0 &&
          process.signal === null &&
          observed.saved.readAt <= process.exitedAt &&
          process.exitedAt <= process.startedAt &&
          process.startedAt <= observed.reopened.readAt
  );
  check(
    'cold-history-preserved',
    observed.messages === undefined || observed.reopenedMessages === undefined
      ? undefined
      : observed.messages.length > 0 &&
          canonical(observed.messages) === canonical(observed.reopenedMessages)
  );
  const status: Status = checks.some((item) => item.status === 'FAIL')
    ? 'FAIL'
    : checks.some((item) => item.status === 'INCOMPLETE')
      ? 'INCOMPLETE'
      : 'PASS';
  return {
    recordedJourney: { status, checks },
    parentComplete: false as const,
    ordinaryUserGate: 'OPEN' as const,
    releaseGate: 'OPEN' as const,
    unassessed: [
      'Actual qualifying account product identity, account class and existing included allowance before submission',
      'Regular project factory/import/mount provenance and visible assembly UX',
      'Running artifact class/digest/source and actual gateway revision; ticket/claim cryptographic validation',
      'Complete project catalog delta: no additional finalized plasmid entity',
      'Actual Tm model/settings/provider provenance, primer homology physics and scientific acceptance',
      'Actual settled usage/cost, full current-source/native/model qualification and normal dev/release delivery',
    ],
  };
}
