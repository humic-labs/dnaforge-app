# Acknowledging revised source records

## Acceptance boundary

Native HTTP and file-backed SQLite acceptance passed for verified original
source fields, nested archive evidence, occupied source-claimed destinations,
stale refusal, metadata-only acknowledgement, explicit rollback, lost response,
exact receipt recovery, archive adoption and restart. A captured real v14
inventory and its v11 source history replayed without changing stored bytes.

The real desktop showed previous source 80 µL at A, revised source 90 µL at C,
and actual stock 63 µL at B in separate columns. Acknowledgement preserved all
physical facts, its 60 µL hold and four stocktake observations. Further use left
62 µL; reimport did not replenish it. Full desktop restart preserved the
accepted 90 µL source baseline, actual 62 µL, exact state, history and archive
bytes.

Evidence, original captures and video are under
`/Users/peterciaccia/projects/.agent-evidence/DNA-3198-inventory-source-revisions/20261116/`.
Desktop source input used explicit pasted text. Native file dialogs remain
unqualified; this does not claim Benchling export compatibility.

The workflow acknowledges revised receive-table source records without changing
physical facts. It does not receive stock, record a measurement, rename a
vessel, change quality, move an item, release a hold or alter an observation.

## Natural task

Start with stock received as 80 µL at position A. Use and move it so current
inventory differs from the original source. Keep an active hold and stocktake
observations. Provide a revised external row claiming 90 µL at position C, with
a changed name and quality.

Preview three distinct views: previous source baseline, revised source record
and actual inventory. Recover the previous source fields from the retained
accepted request, including an adopted archive when necessary. Verify their
hash; never infer them from current stock. If the source preimage is
unavailable, show that explicitly and refuse an unsupported comparison.

Resolve the same scientific and physical identities. Supply an explicit reason
and the expected previous row hash for each acknowledgement. Apply one atomic
metadata transition. Verify original binding fields remain intact, a source
revision is appended, and every physical fact, hold and observation is
unchanged.

Reimport the revised receive table: no change. Use stock again and reimport: the
source must not replenish it. Refuse scientific rebinding, vessel replacement,
vessel-kind changes, unbound rows and stale concurrent acknowledgement with zero
effects. A deliberately accepted rollback appends another revision rather than
removing history.

Lose the response and recover the original receipt after restart. Export, adopt
and reopen; preserve the revision chain, original request bytes and physical
identities. Imported acknowledgement actors remain recorded attribution.

## Compatibility

Existing receive-v1 request/options shapes and plan digests remain valid. Adding
a default empty source-revision list must not change the historical receive-plan
hash. Use a dedicated acknowledgement request and the existing journal; no dummy
stock commands or second journal. Replay uses saved verified source fields and
native receipt context rather than live file or registry lookups.

New revisions retain normalized source fields, their hash, the previous hash,
original source destination decision, reason and native actor/time. Validate the
complete chain. Source keys and physical IDs survive adoption; only typed
scientific references and recorded actor attribution follow their existing
mapping rules.
