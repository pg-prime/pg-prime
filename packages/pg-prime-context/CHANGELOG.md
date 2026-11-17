# @pg-prime/context

## 0.2.6

### Patch Changes

- [#22](https://github.com/pg-prime/pg-prime/pull/22) [`30bd5eb`](https://github.com/pg-prime/pg-prime/commit/30bd5eb6f0d896990438c5f236a3ac0cf3d59f2c) Thanks [@YohoCX](https://github.com/YohoCX)! - A `propagation: 'savepoint'` transaction with `localSettings` or timeouts makes two fewer round trips: `pg-prime` 0.2.5's `savepoint()` already puts those settings back after `RELEASE`, so the host no longer snapshots and restores them a second time.
- Updated dependencies []:
  - pg-prime@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [[`2993a2b`](https://github.com/pg-prime/pg-prime/commit/2993a2b2552aba0837d23f731a231a364f1254bc), [`680ae09`](https://github.com/pg-prime/pg-prime/commit/680ae0944dc001e12d5779bfb8f03edd71e9db62), [`577fca6`](https://github.com/pg-prime/pg-prime/commit/577fca6c5706c01b43e4ea7dfa0912fe0a2ded08), [`c5aa0c4`](https://github.com/pg-prime/pg-prime/commit/c5aa0c43043cb995cf528ae6028f26b00c4b000a)]:
  - pg-prime@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies []:
  - pg-prime@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [[`ae10bcb`](https://github.com/pg-prime/pg-prime/commit/ae10bcb575712c41afbc5831ddac66ec2da6d105)]:
  - pg-prime@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`820c13e`](https://github.com/pg-prime/pg-prime/commit/820c13e80fff4e7e010dcde70af06edabaab82db)]:
  - pg-prime@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - pg-prime@0.2.1

## 0.2.0

### Minor Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`42e0055`](https://github.com/pg-prime/pg-prime/commit/42e005573f15e3618f60e9196702ecc75c9db5f0) Thanks [@YohoCX](https://github.com/YohoCX)! - New package: `@pg-prime/context`, ambient transactions on `AsyncLocalStorage`: a `TransactionHost` with propagation and scoped settings. It peers `pg-prime >=0.2.0` and versions with the `fixed` group.

### Patch Changes

- Updated dependencies [[`a75e3a1`](https://github.com/pg-prime/pg-prime/commit/a75e3a19a2e9f615acdbc1d9e240bfc81bf9e9dd), [`6a7ed8e`](https://github.com/pg-prime/pg-prime/commit/6a7ed8e4f9e63e3437400848c0b743dad71a9708), [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80), [`60b99c8`](https://github.com/pg-prime/pg-prime/commit/60b99c86c94d5a720682e775f32913e0a1c7ce31), [`7667362`](https://github.com/pg-prime/pg-prime/commit/7667362fd19a099f294d79901e2e487efb58455e), [`7e93af3`](https://github.com/pg-prime/pg-prime/commit/7e93af378387d69d2d736276527def3d63fc9e63)]:
  - pg-prime@0.2.0
