import {
  toUserMessage,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';
import {
  IDT_MODIFICATION_CATALOG,
  displayIdtToken,
  idtModificationPlacements,
  type OligoNotationDiagnostic,
  type ParsedIdtOligoNotation,
} from './oligo-modifications';
import type { validatePrimerSequence } from './primer-validation';

export function oligoDiagnosticUserMessage(diagnostic: OligoNotationDiagnostic): UserMessage {
  const code = diagnostic.vendorCode;
  if (diagnostic.code === 'unknown-modification' && code)
    return userMessageWithValues('primer.unknownModification', { code: userMessageValue(code) });
  if (diagnostic.code === 'invalid-placement' && code) {
    const entry = IDT_MODIFICATION_CATALOG.find((item) => item.vendorCode === code);
    const placements = entry ? idtModificationPlacements(entry) : [];
    if (placements.length === 1) {
      if (placements[0] === 'internal')
        return userMessageWithValues('primer.internalPlacement', {
          code: userMessageValue(displayIdtToken(code)),
        });
      return userMessageWithValues('primer.invalidPlacement', {
        code: userMessageValue(displayIdtToken(code)),
        position: userMessageValue(placements[0] === 'five-prime' ? '5′ end' : '3′ end'),
      });
    }
  }
  if (diagnostic.code === 'incompatible-order-type' && code)
    return userMessageWithValues('primer.incompatibleModificationType', {
      code: userMessageValue(displayIdtToken(code)),
    });
  if (diagnostic.code === 'unclosed-token') return userMessage('primer.unclosedModification');
  if (diagnostic.code === 'missing-natural-base') return userMessage('primer.sequenceRequired');
  if (diagnostic.code === 'invalid-base') return userMessage('primer.sequenceInvalid');
  return toUserMessage(diagnostic.message, 'primer.modification.check');
}

export function firstOligoErrorUserMessage(parsed: ParsedIdtOligoNotation): UserMessage | null {
  if (parsed.errors.length === 0) return null;
  const diagnostic = parsed.diagnostics.find((item) => item.severity === 'error');
  return diagnostic
    ? oligoDiagnosticUserMessage(diagnostic)
    : toUserMessage(parsed.errors[0], 'primer.modification.check');
}

export function primerSequenceUserMessage(
  result: ReturnType<typeof validatePrimerSequence>
): UserMessage | null {
  if (result.valid) return null;
  const issue = result.errors?.[0];
  if (issue?.reason === 'empty') return userMessage('primer.sequenceRequired');
  if (issue?.reason === 'too_short' && Number.isFinite(issue.min))
    return userMessageWithValues('primer.sequenceTooShort', { count: userMessageValue(issue.min) });
  if (issue?.reason === 'too_long' && Number.isFinite(issue.max))
    return userMessageWithValues('primer.sequenceTooLong', { count: userMessageValue(issue.max) });
  if (issue?.position !== undefined)
    return userMessageWithValues('primer.invalidBasePosition', {
      position: userMessageValue(issue.position + 1),
    });
  return userMessage('primer.sequenceInvalid');
}
