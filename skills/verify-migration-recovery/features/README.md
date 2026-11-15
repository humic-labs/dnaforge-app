# Migration recovery feature map

| Feature                   | Workflow                | Production authority                                 | Observable result                                          |
| ------------------------- | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Preserved local ZIP retry | [Recovery](recovery.md) | Migration state machine, coordinator and store       | Same run and source resume parsing and complete            |
| Failed unlock rollback    | [Recovery](recovery.md) | Migration state machine, staging workspace and store | Exact ready snapshot restored, next unlock succeeds        |
| Conditional persistence   | [Recovery](recovery.md) | Migration store                                      | Stale snapshots and ordinary terminal-state edits rejected |
