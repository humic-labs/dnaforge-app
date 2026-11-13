export const ASSEMBLY_PRIMER_SYSTEM_PROMPT = `Assembly primers belong to the assembly that uses the source provenance.
Create the design, add its source regions, and use draft_design_assembly to keep
the complete primers, 5-prime tails and binding sites inside that design.
Source provenance records where a part came from; it is not a primer attachment.
Do not call add_primer_binding on source sequences or write primer annotations
into source files unless the user explicitly requests those source attachments.
An assembly design request does not authorize them. On explicit finalization,
DNAForge saves the primers and pins them in the accepted assembly history.
To keep oligos for ordering before finalization, call save_design_primers,
which saves or links them and records the link on the design.
Keep the source sequences and their existing primer attachments unchanged.`;
