# Send, queue and advance

## Sub-features

Send one message; queue repeated Enter; advance through a clicked queued target; run two conversations independently; capture the route at submission.

## How to get to it (user POV)

Open an AI conversation and type in the composer. Submit while a response is pending to queue a follow-up. Click a queued row to advance through it.

## Driving it with Vitest and native CDP

The skill's focused driver runs `chat-queue.integration.test.ts` and `chat-queue.test.ts`. Assert FIFO user-message order, durable acceptance callback ordering and isolation. The native driver sends through actual composer controls, holds the HTTP provider response while queuing and checks native chat rows after terminal response.

## Gotchas

The queue-only tests replace the turn runner. Integration tests use real queue/runner but replace database IPC and provider transport. Native acceptance crosses those local boundaries with HTTP-only provider fixtures.
