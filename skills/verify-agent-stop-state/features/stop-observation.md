# Stop observation

## Sub-features

Active Stop, repeated Stop, Stop during admission, confirmed provider
cancellation, unconfirmed observation ending and late cancellation of renderer
tools.

## How to get to it (user POV)

Start a local agent turn and press Stop. The desktop owner receives
`AgentSessionManager.requestStop` through the agent-session command contract.

## Driving it with Vitest

Run the skill's Drive command. The first four cases invoke `startSession` and
`requestStop`, controlling only the provider boundary's promise. Active stopping
has no completion timestamp or terminal event. Provider confirmation remains
`cancelled`; unconfirmed observation becomes terminal `stop_unconfirmed`. The
existing provider result and cancel response still use `stop_requested`.
Cancelling leftover renderer work cannot mutate a committed terminal record.

## Gotchas

An aborted signal proves intent, not a provider stop. A finished local observer
does not prove physical process termination. Read the saved intermediate record
as well as the final row and single analytics event.
