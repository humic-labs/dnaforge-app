# Interrupted extraction recovery

Use only the task-owned project and isolated native profile. This POSIX fault
journey changes permissions on a new empty fixture directory and restores them.
It does not qualify Windows permission behavior or power-loss durability.

Run
`node apps/desktop/scripts/check-table-promotion-recovery.mjs --mode prepare --out PREPARE_DIRECTORY`.
The driver saves a real inline table, denies creation inside its empty
destination, and uses the visible extraction dialog. Require a visible logged
error, unchanged saved source, no writable destination and one durable recovery
intent. The driver restores its directory permissions.

Stop only the owned native app. Restart with the same isolated profile. Run
`node apps/desktop/scripts/check-table-promotion-recovery.mjs --mode verify --source PREPARE_RECEIPT --out VERIFY_DIRECTORY`.

Require a different native process ID, discoverable Finish saving table control,
the same table identity and original value, a clean saved notebook reference,
unchanged original archive/intent bytes and no remaining pending recovery entry.
No physical dialog clicks, terminal repair or internal request IDs are needed
from the user. Keep original captures and receipts, including the expected
failure.

The focused native checks separately cover source and destination conflicts,
cutover uncertainty, exact archives, copied project profiles and duplicate
aliases. They supplement this actual app journey.
