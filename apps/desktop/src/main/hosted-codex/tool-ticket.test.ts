import { describe, expect, it } from 'vitest';

import { createToolTicketMinter, ToolTicketError } from './tool-ticket';

const CALL = 'call_c6zsMA54Lxz7R8MK7LnKt00Q';

describe('createToolTicketMinter', () => {
  it('accepts a ticket presented for the call it was minted for', () => {
    const minter = createToolTicketMinter();
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'exec_command',
      requiresUserApproval: true,
    });
    expect(() =>
      minter.verify(ticket.token, { providerCallId: CALL, toolName: 'exec_command' })
    ).not.toThrow();
  });

  it('binds the call, so a read ticket cannot be presented for another call', () => {
    const minter = createToolTicketMinter();
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'exec_command',
      requiresUserApproval: true,
    });
    const rejection = (): void =>
      minter.verify(ticket.token, { providerCallId: 'call_other', toolName: 'exec_command' });
    expect(rejection).toThrow(ToolTicketError);
    expect(rejection).toThrow(/different call/u);
  });

  it('binds the tool, so a ticket cannot be moved from one tool to another', () => {
    const minter = createToolTicketMinter();
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'view_image',
      requiresUserApproval: true,
    });
    expect(() =>
      minter.verify(ticket.token, { providerCallId: CALL, toolName: 'exec_command' })
    ).toThrow(/different tool/u);
  });

  it('refuses a ticket from another run', () => {
    const first = createToolTicketMinter();
    const second = createToolTicketMinter();
    const ticket = first.mint({
      providerCallId: CALL,
      toolName: 'exec_command',
      requiresUserApproval: true,
    });
    expect(() =>
      second.verify(ticket.token, { providerCallId: CALL, toolName: 'exec_command' })
    ).toThrow(/signed by this run/u);
  });

  it('refuses a token whose payload was edited', () => {
    const minter = createToolTicketMinter();
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'view_image',
      requiresUserApproval: true,
    });
    const [, signature] = ticket.token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ c: CALL, t: 'exec_command', a: false, x: Date.now() + 60_000 }),
      'utf8'
    )
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    expect(() =>
      minter.verify(`${forged}.${signature}`, { providerCallId: CALL, toolName: 'exec_command' })
    ).toThrow(/signed by this run/u);
  });

  it('refuses a ticket that has expired', () => {
    let clock = 1_000_000;
    const minter = createToolTicketMinter({ now: () => clock });
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'exec_command',
      requiresUserApproval: true,
      ttlMs: 1_000,
    });
    clock += 1_001;
    expect(() =>
      minter.verify(ticket.token, { providerCallId: CALL, toolName: 'exec_command' })
    ).toThrow(/no longer presentable/u);
  });

  it('reports a substituted tool as substitution rather than as staleness', () => {
    let clock = 1_000_000;
    const minter = createToolTicketMinter({ now: () => clock });
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'view_image',
      requiresUserApproval: true,
      ttlMs: 1_000,
    });
    clock += 1_001;
    expect(() =>
      minter.verify(ticket.token, { providerCallId: CALL, toolName: 'exec_command' })
    ).toThrow(/different tool/u);
  });

  it('mints a token the wire contract accepts', () => {
    const minter = createToolTicketMinter();
    const ticket = minter.mint({
      providerCallId: CALL,
      toolName: 'exec_command',
      requiresUserApproval: true,
    });
    expect(ticket.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(ticket.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(ticket.providerCallId).toBe(CALL);
    expect(ticket.toolName).toBe('exec_command');
  });
});
