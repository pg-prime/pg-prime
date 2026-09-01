---
"pg-prime": patch
---

Five error classes now declare the literal `code` types the reference always documented:
`UniqueViolationError` `'23505'`, `QueryCanceledError` `'57014'`, `InFailedTransactionError`
`'25P02'`, `IndeterminateCommitError` `'INDETERMINATE_COMMIT'`, `CodecMismatchError`
`'CODEC_MISMATCH'`. Type-level only (`declare`); nothing changes at runtime.
