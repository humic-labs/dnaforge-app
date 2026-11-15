# Agent stop-state features

| Feature                                 | User action                           | Proof                                                               |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| [Stop observation](stop-observation.md) | Stop a running or starting local turn | Active stopping and terminal outcome stay distinct                  |
| [Recovery](recovery.md)                 | Reopen the app after stopping         | Legacy data migrates and a stale request settles once               |
| [Continuation](continuation.md)         | Send the next turn                    | Only a committed eligible session resumes the provider conversation |
