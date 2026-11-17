---
'@pg-prime/context': patch
---

A `propagation: 'savepoint'` transaction with `localSettings` or timeouts makes two fewer round trips: `pg-prime` 0.2.5's `savepoint()` already puts those settings back after `RELEASE`, so the host no longer snapshots and restores them a second time.
