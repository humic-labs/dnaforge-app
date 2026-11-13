import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DNAFORGE_CLI_SYSTEM_PROMPT,
  REFERENCE_PROMPT_VERSION,
  REFERENCE_SYSTEM_PROMPT,
} from '../../../shared/ai-reference-system-prompt';
import { MOLECULAR_WORKFLOW_SYSTEM_PROMPT } from '../../../shared/ai-molecular-workflow-system-prompt';
import { BASE_SYSTEM_PROMPT, CHAT_PROMPT_VERSION, buildSystemPrompt } from './system-prompt';
import { ASSISTANT_ROUTE_CAPABILITIES } from '../assistant-route-capabilities';

describe('versioned chat system prompt', () => {
  it('shares exactly one molecular workflow across provider and native CLI instructions', () => {
    for (const prompt of [BASE_SYSTEM_PROMPT, DNAFORGE_CLI_SYSTEM_PROMPT]) {
      expect(prompt.split(MOLECULAR_WORKFLOW_SYSTEM_PROMPT)).toHaveLength(2);
      expect(prompt).toContain('color_variant_protein to preserve the source calls');
    }
  });
  it('treats a saved molecular view as the requested reference without retyping it as a residue selection', () => {
    expect(REFERENCE_SYSTEM_PROMPT).toContain(
      'A successful mol_save_view satisfies a request for a clickable saved molecular view'
    );
    expect(REFERENCE_SYSTEM_PROMPT).toContain(
      'A saved molecular view is not an existing_reference residue selection'
    );
    expect(REFERENCE_SYSTEM_PROMPT).not.toMatch(
      /reference chip; in that case a\s+completed create_reference result is mandatory/
    );
  });
  it('pins the extracted base prompt byte-for-byte', () => {
    expect(CHAT_PROMPT_VERSION).toBe('2026-10-21.1');
    expect(REFERENCE_PROMPT_VERSION).toBe('2026-11-10.1');
    expect(createHash('sha256').update(BASE_SYSTEM_PROMPT).digest('hex')).toBe(
      '45a169aa7a9eb9f8d9bc771ce2142cbd1ba01caa4799490618cc8490ce2b24d0'
    );
  });

  it('puts verified molecular view and selection names inline using stable targets', () => {
    expect(REFERENCE_SYSTEM_PROMPT).toContain('kind is "molecular_view_target"');
    expect(REFERENCE_SYSTEM_PROMPT).toContain('viewReferenceId and stable viewId');
    expect(REFERENCE_SYSTEM_PROMPT).toContain('separate Target control');
    expect(REFERENCE_SYSTEM_PROMPT).toContain('never search for a destination by label');
  });

  it('previews finalization by default and mutates only on explicit user intent', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('A request to build, design,');
    expect(BASE_SYSTEM_PROMPT).toContain('or draft an assembly stops at the drafted design.');
    expect(BASE_SYSTEM_PROMPT).toContain('preview_finalize_design_assembly');
    expect(BASE_SYSTEM_PROMPT).toContain('preview_finalize_paper_protocol');
    expect(BASE_SYSTEM_PROMPT).toContain('capture_paper_url');
    expect(BASE_SYSTEM_PROMPT).toContain('record_paper_reference_trace');
    expect(BASE_SYSTEM_PROMPT).toContain('get_paper_reference_graph');
    expect(BASE_SYSTEM_PROMPT).toContain('agent discovers multiple plausible protocols');
    expect(BASE_SYSTEM_PROMPT).toContain('candidateStatus "proposed"');
    expect(BASE_SYSTEM_PROMPT).toContain('select_protocol_candidate');
    expect(BASE_SYSTEM_PROMPT).toContain('Before marking a cited item as a hole');
    expect(BASE_SYSTEM_PROMPT).toContain('untrusted paper evidence');
    expect(BASE_SYSTEM_PROMPT).toContain('workspace-local observation');
    expect(BASE_SYSTEM_PROMPT).toContain('does not mean DNAForge fetched or read the cited');
    expect(BASE_SYSTEM_PROMPT).toContain('then STOP unless the current user');
    expect(BASE_SYSTEM_PROMPT).toContain('explicitly asks to finalize');
    expect(BASE_SYSTEM_PROMPT).toContain('Finalization does not open a tab');
    expect(BASE_SYSTEM_PROMPT).toContain(
      '"The open assembly" and "the current assembly" refer to existing app state'
    );
    expect(BASE_SYSTEM_PROMPT).toContain('Never perform the forbidden action and then undo it');
  });

  it('requires durable multi-project designs and evidence for claimed tool rejection', () => {
    expect(BASE_SYSTEM_PROMPT).toContain(
      'set destinationProject to the exact intended project name'
    );
    expect(BASE_SYSTEM_PROMPT).toContain(
      'source and destination design do not need to belong to the same project'
    );
    expect(BASE_SYSTEM_PROMPT).toContain(
      'Do not claim that DNAForge rejected an action unless a tool result'
    );
  });

  it('treats an ordinary scientific question as authorization to make and inspect a molecular view', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('An ordinary scientific question authorizes');
    expect(BASE_SYSTEM_PROMPT).toContain('chemical contacts, secondary-structure');
    expect(BASE_SYSTEM_PROMPT).toContain('mol_capture_screenshot at the actual');
    expect(BASE_SYSTEM_PROMPT).toContain('native-only edits will not survive');
    expect(BASE_SYSTEM_PROMPT).toContain('Reuse an already open relevant structure');
    expect(BASE_SYSTEM_PROMPT).toContain('Native component counts do not prove');
    expect(BASE_SYSTEM_PROMPT).toContain('An open tab alone is not a chat');
    expect(BASE_SYSTEM_PROMPT).toContain('includeColorGroupSelections:true');
    expect(BASE_SYSTEM_PROMPT).toContain('a label or color alone does not verify a selection');
    expect(BASE_SYSTEM_PROMPT).toContain(
      'Do not say a view was embedded unless mol_save_view succeeds'
    );
    expect(BASE_SYSTEM_PROMPT).not.toContain(
      'Call them only when the\n  user explicitly asks to change the scene'
    );
  });

  it('routes sequencing evidence through linked inspection before generic protein research', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('get_clone_analysis → inspect_sequence_variant');
    expect(BASE_SYSTEM_PROMPT).toContain('get_ngs_analysis → inspect_variant_call');
    expect(BASE_SYSTEM_PROMPT).toContain('import_variant_calls → inspect_variant_call');
    expect(
      BASE_SYSTEM_PROMPT.indexOf('get_clone_analysis → inspect_sequence_variant')
    ).toBeLessThan(BASE_SYSTEM_PROMPT.indexOf('Start with protein-mcp'));
  });

  it('retains numeric measurements and local provenance instead of merely describing colors', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('mol_apply_measurement');
    expect(BASE_SYSTEM_PROMPT).toContain('proteinMapping.proteinSequenceSha256');
    expect(BASE_SYSTEM_PROMPT).toContain('before/after counts and pseudocount');
    expect(BASE_SYSTEM_PROMPT).toContain('exactly one target identifier');
    expect(BASE_SYSTEM_PROMPT).toContain('Do not invent public URLs for local files');
    expect(BASE_SYSTEM_PROMPT).toContain('Verify every requested residue');
    expect(BASE_SYSTEM_PROMPT).toContain('color_variant_protein');
    expect(BASE_SYSTEM_PROMPT).toContain('proteinProduct "reference"');
  });

  it('tells the model not to mistake an empty MCP resource list for unavailable workspace tools', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('get_workspace is a TOOL — call it directly by name');
    expect(BASE_SYSTEM_PROMPT).toContain('resources/list');
    expect(BASE_SYSTEM_PROMPT).toContain(
      'does not expose canvas or workspace state as MCP resources'
    );
  });

  it('composes workspace context without changing the base prompt prefix', () => {
    expect(buildSystemPrompt([], false).startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    const single = buildSystemPrompt([{ name: 'workspace-a' } as never], true);
    expect(single.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(single).not.toContain('**Example flow:**');
    expect(single).not.toContain('**No project is open.**');
    expect(
      buildSystemPrompt([{ name: 'workspace-a' } as never, { name: 'workspace-b' } as never], true)
    ).toContain('**Open projects:**');
  });

  it('appends user-configured instructions without replacing DNAForge rules', () => {
    const prompt = buildSystemPrompt([], false, 'Use short paragraphs.');
    expect(prompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('**User-configured additional instructions:**');
    expect(prompt).toContain('Use short paragraphs.');
    expect(prompt).toContain('do not replace or\noverride the DNAForge');
  });

  it('returns an attached authoritative structure selection by reference id', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('dnaforge-chat://reference/<reference.refId>');
    expect(BASE_SYSTEM_PROMPT).toContain('does not depend on whether Mol* is mounted');
  });

  it('defines the no-roundtrip inline grammar and keeps typed objects on the rich-object tool', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('there is no tool call and no second model step');
    expect(BASE_SYSTEM_PROMPT).not.toContain('dnaforge-chat://entity/sequence/');
    expect(BASE_SYSTEM_PROMPT).toContain('stable sequence document ID');
    expect(BASE_SYSTEM_PROMPT).toContain('dnaforge-chat://entity/structure/<root>/<path-segments>');
    expect(BASE_SYSTEM_PROMPT).toContain('dnaforge-chat://workspace/<root>/<path-segments>');
    expect(BASE_SYSTEM_PROMPT).toContain(
      'create_reference` is for a sequence document or a NEW typed object'
    );
    expect(BASE_SYSTEM_PROMPT).toContain('never put an absolute path');
    expect(BASE_SYSTEM_PROMPT).toMatch(
      /Never emit\s+an entity link and a workspace link for the same target/
    );
  });

  it('exposes terminal reference fallback instructions only on a verified route', () => {
    const direct = buildSystemPrompt([], false, ASSISTANT_ROUTE_CAPABILITIES.provider);
    const hosted = buildSystemPrompt([], false, ASSISTANT_ROUTE_CAPABILITIES.hosted);
    const cli = buildSystemPrompt([], false, ASSISTANT_ROUTE_CAPABILITIES.cli);

    expect(direct).toContain('**Terminal rich-reference fallback:**');
    expect(direct).toContain('call `create_reference` as the final action');
    expect(hosted).not.toContain('**Terminal rich-reference fallback:**');
    expect(cli).not.toContain('**Terminal rich-reference fallback:**');
  });

  it('makes the route-level inline declaration rollback effective', () => {
    const disabled = buildSystemPrompt([], false, {
      inlineReferenceDeclarations: false,
      terminalReferenceFallbackSupported: false,
    });

    expect(disabled).toContain('This route has inline reference declarations disabled.');
    expect(disabled).not.toContain('dnaforge-chat://');
    expect(disabled).not.toContain('**Fast inline navigation:**');
  });

  it('scopes staged-reference reuse and prevents reordered or duplicate reference calls', () => {
    expect(BASE_SYSTEM_PROMPT).toContain(REFERENCE_SYSTEM_PROMPT);
    expect(BASE_SYSTEM_PROMPT).toContain(
      'selection:{kind:"existing_reference"} only when returning that same staged reference unchanged'
    );
    expect(BASE_SYSTEM_PROMPT).toContain('entityType must match the staged reference');
    expect(BASE_SYSTEM_PROMPT).toContain(
      'With selection:{kind:"existing_reference"}, pass only entityType, displayLabel,'
    );
    expect(BASE_SYSTEM_PROMPT).toContain('retry only that failed identity');
    expect(BASE_SYSTEM_PROMPT).toMatch(/Never repeat a\s+successful\s+create_reference call/);
    expect(BASE_SYSTEM_PROMPT).toContain('Create each requested reference identity at most once');
    expect(BASE_SYSTEM_PROMPT).toMatch(/issue create_reference calls in exactly\s+that order/);
  });

  it('requires state-changing tool failures to report whether partial effects occurred', () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain('a failed result means no state change occurred');
    expect(BASE_SYSTEM_PROMPT).toContain('stateChanged');
    expect(BASE_SYSTEM_PROMPT).toContain('partialEffects');
  });
});
