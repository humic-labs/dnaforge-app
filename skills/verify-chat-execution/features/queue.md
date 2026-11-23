# Send, queue and advance

## Sub-features

Send one message; queue repeated Enter; advance through a clicked queued target; run two conversations independently; capture the route and native model settings at submission.

## How to get to it (user POV)

Open an AI conversation and type in the composer. Submit while a response is pending to queue a follow-up. Click a queued row to advance through it.

## Driving it with Vitest and native CDP

The skill's focused driver runs `chat-queue.integration.test.ts` and `chat-queue.test.ts`. Assert FIFO user-message order, durable acceptance callback ordering and isolation. The native driver sends through actual composer controls, holds the HTTP provider response while queuing and checks native chat rows after terminal response.

For native Claude and Codex, submit a follow-up while a response is pending, then change the selected model before the queue advances. Compare the model selected at submission with the model in the second native request and the second chat turn. Both sends should have exactly one user message. The focused regression in `run-chat-turn.cli.test.ts` holds the first response at the provider boundary to make this ordering reproducible.

## Gotchas

The queue-only tests replace the turn runner. Integration tests use real queue/runner but replace database IPC and provider transport. Native acceptance crosses those local boundaries with HTTP-only provider fixtures.
