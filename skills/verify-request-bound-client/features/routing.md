# Endpoint ownership

## Sub-features

- Concurrent Jobs refreshes retain the URL each request resolved.
- Two compute health managers and an external sequence lookup coexist.
- Remote transports receive no local session, agent identity or capability headers.

## How to get to it (user POV)

The Jobs panel refreshes server jobs, compute status checks health and sequence import fetches an external record. These paths share generated API calls but can target different service endpoints.

## Driving it with Vitest

Execute the skill's drive command. The production Jobs store starts two concurrent refreshes while the main-process URL boundary returns a different endpoint for each. Each owned server must receive exactly one Jobs request. Then health checks on both managers interleave with external sequence import on the first endpoint; assert each path, request body and returned content. Finally a remote transport receives a request forwarded to the second local server; assert the original remote URL and absence of all local credentials at the receiver.

## Gotchas

The concurrent Jobs case reproduces global rebinding before request invocation; it does not claim the fetcher changes a URL after capturing configuration. The external provider is represented by a real local HTTP server with a synthetic response, not a live NCBI call. Session credentials are supplied by the native authority in the real desktop; renderer clients must never manufacture them.
