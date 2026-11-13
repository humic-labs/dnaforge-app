import { describe, expect, it, vi } from 'vitest';
import { createHostedToolApprovalAuthority } from './tool-approval-authority';

const VALID_TICKET_EXPIRY = '2999-01-01T00:00:00.000Z';

describe('Hosted tool approval authority', () => {
  it('binds approval requirements to one exact tool call and consumes them once', () => {
    const authority = createHostedToolApprovalAuthority();
    authority.register({
      toolCallId: 'call-1',
      toolName: 'get_workspace',
      input: { scope: 'current' },
      ticket: 'signed.ticket',
      requiresUserApproval: true,
      expiresAt: VALID_TICKET_EXPIRY,
    });

    expect(authority.consume('call-1', 'get_workspace', { scope: 'current' })).toEqual(
      expect.objectContaining({
        requiresUserApproval: true,
        assertUsable: expect.any(Function),
      })
    );
    expect(() => authority.consume('call-1', 'get_workspace', { scope: 'current' })).toThrow(
      /missing/i
    );
    expect(() =>
      authority.register({
        toolCallId: 'call-1',
        toolName: 'get_workspace',
        input: { scope: 'current' },
        ticket: 'signed.ticket',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      })
    ).toThrow(/duplicate/i);
  });

  it('fails closed on a mismatched name and burns the mismatched ticket', () => {
    const authority = createHostedToolApprovalAuthority();
    authority.register({
      toolCallId: 'call-2',
      toolName: 'get_workspace',
      input: {},
      ticket: 'signed.ticket',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });

    expect(() => authority.consume('call-2', 'list_files', {})).toThrow(/does not match/i);
    expect(() => authority.consume('call-2', 'get_workspace', {})).toThrow(/missing/i);
  });

  it('rejects duplicate tool-call ids instead of replacing their policy', () => {
    const authority = createHostedToolApprovalAuthority();
    authority.register({
      toolCallId: 'call-3',
      toolName: 'get_workspace',
      input: {},
      ticket: 'signed.ticket',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });

    expect(() =>
      authority.register({
        toolCallId: 'call-3',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.ticket',
        requiresUserApproval: true,
        expiresAt: VALID_TICKET_EXPIRY,
      })
    ).toThrow(/duplicate/i);
  });

  it('binds the exact gateway-normalized arguments before local dispatch', () => {
    const authority = createHostedToolApprovalAuthority();
    authority.register({
      toolCallId: 'call-args',
      toolName: 'create_design',
      input: { assemblyMethod: 'gibson', name: 'Design A', open: true },
      ticket: 'signed.ticket',
      requiresUserApproval: true,
      expiresAt: VALID_TICKET_EXPIRY,
    });

    expect(() =>
      authority.consume('call-args', 'create_design', {
        name: 'Design B',
        assemblyMethod: 'gibson',
        open: true,
      })
    ).toThrow(/arguments.*match/i);
    expect(() =>
      authority.consume('call-args', 'create_design', {
        name: 'Design A',
        assemblyMethod: 'gibson',
        open: true,
      })
    ).toThrow(/missing/i);
  });

  it('accepts schema-equivalent defaults while retaining the original signed arguments', async () => {
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'call-defaults',
      toolName: 'create_reference',
    }));
    const normalizeInput = vi.fn((toolName: string, input: unknown) => {
      if (toolName !== 'create_reference') return input;
      const value = input as Record<string, unknown>;
      return { ...value, deepLinkParams: value.deepLinkParams ?? {} };
    });
    const authority = createHostedToolApprovalAuthority({ normalizeInput, recordObservation });
    const signedInput = {
      entityType: 'sequence',
      displayLabel: 'Hosted source reference',
      filePath: 'pUC19.gb',
    };
    authority.register({
      toolCallId: 'call-defaults',
      toolName: 'create_reference',
      input: signedInput,
      ticket: 'signed.defaults',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });

    const decision = authority.consume('call-defaults', 'create_reference', {
      ...signedInput,
      deepLinkParams: {},
    });
    await expect(
      decision.assertUsable({ ...signedInput, deepLinkParams: {} })
    ).resolves.toBeUndefined();
    await expect(
      decision.assertUsable({ ...signedInput, filePath: 'different.gb', deepLinkParams: {} })
    ).rejects.toThrow(/arguments.*match/i);
    await decision.recordObservation({ ok: true, result: { referenceId: 'reference-1' } });

    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ input: signedInput }),
      { ok: true, result: { referenceId: 'reference-1' } }
    );
  });

  it('requires every accepted step in one turn to use the same gateway catalog', () => {
    const authority = createHostedToolApprovalAuthority();
    authority.acceptCatalogVersion('catalog-v1');
    authority.acceptCatalogVersion('catalog-v1');

    expect(() => authority.acceptCatalogVersion('catalog-v2')).toThrow(/catalog.*changed/i);
  });

  it('records one exact observation and verifies the receipt identity', async () => {
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'call-receipt',
      toolName: 'get_workspace',
    }));
    const authority = createHostedToolApprovalAuthority({ recordObservation });
    authority.register({
      toolCallId: 'call-receipt',
      toolName: 'get_workspace',
      input: {},
      ticket: 'signed.receipt',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const decision = authority.consume('call-receipt', 'get_workspace', {});
    const observation = { ok: true, result: { folders: [] } };

    await decision.recordObservation(observation);
    await decision.recordObservation({ result: { folders: [] }, ok: true });
    expect(recordObservation).toHaveBeenCalledTimes(1);
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: 'signed.receipt' }),
      observation
    );
    await expect(
      decision.recordObservation({ ok: true, result: { folders: ['different'] } })
    ).rejects.toThrow(/first receipt/i);
  });

  it('binds claim, completion, and observation to the same one-shot mutation ticket', async () => {
    const claimMutation = vi.fn(async () => ({
      claimId: '00000000-0000-4000-8000-000000000099',
      status: 'claimed' as const,
      toolName: 'create_design',
      alreadyApplied: false,
    }));
    const completeMutation = vi.fn(async () => ({ status: 'completed' as const }));
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'call-write',
      toolName: 'create_design',
    }));
    const authority = createHostedToolApprovalAuthority({
      claimMutation,
      completeMutation,
      recordObservation,
    });
    const input = { name: 'Design A' };
    authority.register({
      toolCallId: 'call-write',
      toolName: 'create_design',
      input,
      ticket: 'signed.write',
      requiresUserApproval: true,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const decision = authority.consume('call-write', 'create_design', input);

    await decision.claimMutation('approval-1');
    expect(authority.completedMutationClaimId('call-write')).toBeUndefined();
    await decision.completeMutation('audit-1');
    expect(authority.completedMutationClaimId('call-write')).toBe(
      '00000000-0000-4000-8000-000000000099'
    );
    await decision.recordObservation({ ok: true, result: { designId: 'design-1' } });

    expect(claimMutation).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: 'signed.write' }),
      'approval-1',
      'tool-claim:call-write'
    );
    expect(completeMutation).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-4000-8000-000000000099',
      'tool-claim:call-write',
      'audit-1'
    );
    expect(recordObservation).toHaveBeenCalledWith(
      expect.anything(),
      { ok: true, result: { designId: 'design-1' } },
      '00000000-0000-4000-8000-000000000099'
    );
  });
});
