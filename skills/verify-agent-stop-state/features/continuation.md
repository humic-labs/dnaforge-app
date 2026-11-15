# Continuation

## Sub-features

No continuation during active stopping, eligible follow-up after unconfirmed
observation ends, and refusal of an incomplete terminal record.

## How to get to it (user POV)

Send another local turn in the same conversation after stopping the previous
one. The session owner looks up the preceding provider conversation before
admission.

## Driving it with Vitest

Run the skill's Drive command. The continuation case starts and stops a real
session, advances the renderer-owned chat turn and exposes a provider
conversation identifier while the provider fixture remains pending. Lookup must
return null. After the provider observation ends and the manager commits, lookup
must return that identifier. Another case checks that a terminal label without
its completion timestamp is insufficient.

## Gotchas

Chat-turn status and provider conversation identifiers cannot establish session
settlement. The session's committed terminal outcome owns eligibility.
