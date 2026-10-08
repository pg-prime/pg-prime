# packages/pg-prime/src/codec/registry.ts

## Purpose
`Registry`, the shipped `CodecRegistry`: OID and name lookup, per-RowDescription decode plans, and
`resolveDynamic`, which reads user and extension type OIDs from the live catalogue. Seeds itself from
`builtinCodecs`/`ALTERNATE_CODECS`/`unknownCodec` (`src/codec/builtins.ts`) and `EXTENSION_CODECS`
(`src/codec/extensions.ts`). `pgPrime()` in `packages/pg-prime/src/query/run.ts:219` builds one per instance;
`metaOf` (`packages/pg-prime/src/query/meta.ts:106`), `packages/pg-prime/src/compile/decode.ts:104` and `packages/pg-prime/src/query/run.ts:628` fall
back to `defaultRegistry()`; `packages/pg-prime/src/query/executor.ts:651` calls `planFor`.

## Public API
- `Registry(codecs = builtinCodecs())` — class; `register`s each codec, then adds alternates,
  `unknown` and extension codecs by name only.
- `.forOid(oid)` / `.byName(name)` — lookups; `undefined` when absent.
- `.register(codec, { override? })` — adds by OID and name; throws on an OID claimed by another name
  unless `override: true`; bumps `generation`.
- `.resolved` / `.generation` — no pending dynamic requests / mutation counter.
- `.setServerParameters(p)` — GUCs placed in every `CodecContext` this registry builds.
- `.clone()` — copy with the same OID/name maps and server parameters, nothing pending.
- `.onUnknownOid(handler | undefined)` — callback for a column OID with no codec.
- `.planFor(fields)` / `.jsonPlanFor(codecs)` — positional decoders with `null` short-circuited.
- `.jsonCastFor(codec)` — `'::text'` when `jsonEncode === 'text'`, else `''`.
- `.resolveDynamic(connection, requests)` — resolves `enum`/`domain`/`base` requests; throws otherwise.
- `enumCodec(name, oid, labels, sqlName = name)` — identity codec with a membership check.
- `createRegistry()` — `new Registry()`; `defaultRegistry()` — lazy process-wide singleton.

## Flow
1. `planFor` maps each `PgField` to a closure: unknown OID calls `onUnknownOid` and returns raw;
   otherwise `null` → `null`, string → `decodeText`, bytes → `decodeBinary` or throw
   (`packages/pg-prime/src/codec/registry.ts:158`).
2. `resolveDynamic` marks every request pending, then runs one `pg_type` query filtered by
   `typname = any($1::text[])` (`packages/pg-prime/src/codec/registry.ts:217`, `packages/pg-prime/src/codec/registry.ts:446`).
3. Each request matches exactly one row: qualified requests on `(nspname, typname)`, unqualified
   ones on `pg_type_is_visible`; zero or several matches throw (`packages/pg-prime/src/codec/registry.ts:257`).
4. Enum labels come from `pg_enum` in `enumsortorder` for the matched OIDs
   (`packages/pg-prime/src/codec/registry.ts:284`).
5. Per request: `typtype` must match `kind` (`packages/pg-prime/src/codec/registry.ts:309`); enum
   labels must equal `enumLabels` when given (`packages/pg-prime/src/codec/registry.ts:327`).
6. `enum` builds `enumCodec`; `domain` copies the base codec with the domain OID, `paramOid: 705`
   and the domain's own `typarray`; `base` copies the registered codec with the catalogue OID
   (`packages/pg-prime/src/codec/registry.ts:325`, `packages/pg-prime/src/codec/registry.ts:336`,
   `packages/pg-prime/src/codec/registry.ts:366`).
7. Registers the codec, then `arrayCodec` over `typarray` with `typdelim` unless `arrayOf: false`,
   and clears the pending key (`packages/pg-prime/src/codec/registry.ts:401`).

## Gotchas
- Nothing in `src` calls `resolveDynamic`; the application must call it per physical database.
  Until it runs, enum/extension columns decode as raw text through `planFor`.
- A throw inside `resolveDynamic` leaves keys pending, so `resolved` stays `false`; a throw in the
  per-request loop keeps the requests before it registered (`packages/pg-prime/src/codec/registry.ts:307`).
- `composite`, `range` and `multirange` requests throw "not implemented"
  (`packages/pg-prime/src/codec/registry.ts:395`).
- Re-registering a name under a new OID evicts the old OID mapping
  (`packages/pg-prime/src/codec/registry.ts:100`).
- A custom constructor list still gets alternates, `unknown`, `citext` and `vector` by name
  (`packages/pg-prime/src/codec/registry.ts:32`).
- `clone()` does not copy `generation` or the `onUnknownOid` handler
  (`packages/pg-prime/src/codec/registry.ts:123`).
- `resolveDynamic` on `defaultRegistry()` overwrites user-type OIDs for every caller in the process;
  use `clone()` or `createRegistry()` per database (`packages/pg-prime/src/codec/registry.ts:525`).
- The query runtime builds its own `CodecContext`; `setServerParameters` only matters for direct
  `planFor`/`jsonPlanFor` callers (`packages/pg-prime/src/codec/registry.ts:62`).
- PostgreSQL reports a scalar domain column under its base OID, so the domain codec matters for
  parameters and the derived `domain[]` codec (`packages/pg-prime/src/codec/registry.ts:345`).
- Enum and domain `sqlName` is quoted and schema-qualified; the registry key stays the bare name
  (`packages/pg-prime/src/codec/registry.ts:468`).
- `enumCodec` throws `PgEncodeError` on encode and `PgDecodeError` on decode for non-members.

## Tests
- `packages/pg-prime/test/codec/registry.test.ts` — `planFor` hot path and `onUnknownOid`,
  register/byName/jsonCastFor, `resolveDynamic` for enum/domain/arrays, `enumCodec`.
- `packages/pg-prime/test/codec/resolve-schema.test.ts` — qualified vs `search_path` resolution,
  ambiguity, `clone()`, domain array OID.
- Run (live project): `pnpm --filter pg-prime exec vitest run test/codec/registry.test.ts test/codec/resolve-schema.test.ts`.
- Not covered: partial registration after a mid-batch throw; `clone()` dropping `onUnknownOid`.
