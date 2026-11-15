# Sync transition feature map

| Feature                         | Workflow                | Proof                                                                       |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| Upload and retry                | [Queue](queue.md)       | Accepted-operation identity, exact lease acknowledgement and durable retry  |
| Disable and conflict resolution | [Queue](queue.md)       | Eligible work canceled, uncertain retries retained, atomic conflict cutover |
| Pull and recovery observations  | [Recovery](recovery.md) | Error persisted, later observation settles it, quarantine blocks execution  |
