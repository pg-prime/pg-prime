/**
 * The kit's quoter is a PORT of `pg-prime`'s, and it used to be a weaker one: it accepted
 * the empty string, a NUL, a lone surrogate and a 200-byte name, and its `quoteLiteral`
 * doubled `'` without switching to `E'…'` when a backslash was present — the exact gap
 * behind Kysely's GHSA-8cpq-38p9-67gx. Everything it emits goes straight into DDL.
 *
 * The oracles here are hand-written PostgreSQL spellings (what `format('%I')` / `%L`
 * produce), never a re-derivation of the implementation.
 */

import { describe, expect, it } from "vitest";
import {
  defaultNotNullName,
  hasLoneSurrogate,
  hasNul,
  isValidIdent,
  makeObjectName,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  utf8ByteLength,
  InvalidIdentifierError,
  MAX_IDENT_BYTES,
} from "../src/sql/ident.js";

const NUL = String.fromCharCode(0);

describe("quoteIdent", () => {
  it("always quotes and doubles embedded quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent("Users")).toBe('"Users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    // PostgreSQL does NO backslash processing inside a quoted identifier
    expect(quoteIdent("back\\slash")).toBe('"back\\slash"');
    expect(quoteQualified("my schema", "OrderStatus")).toBe('"my schema"."OrderStatus"');
  });

  it("rejects rather than mangles", () => {
    expect(() => quoteIdent("")).toThrow(InvalidIdentifierError);
    expect(() => quoteIdent(`a${NUL}b`)).toThrow(InvalidIdentifierError);
    expect(() => quoteIdent(`lone${String.fromCharCode(0xd800)}`)).toThrow(InvalidIdentifierError);
    expect(() => quoteIdent("x".repeat(MAX_IDENT_BYTES + 1))).toThrow(InvalidIdentifierError);
    // the limit is UTF-8 BYTES: 32 two-byte characters is 64 bytes
    expect(() => quoteIdent("é".repeat(32))).toThrow(InvalidIdentifierError);
    expect(quoteIdent("x".repeat(MAX_IDENT_BYTES))).toBe(`"${"x".repeat(MAX_IDENT_BYTES)}"`);
  });

  it("reports the problem it found", () => {
    try {
      quoteIdent("");
      expect.unreachable("empty identifier must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIdentifierError);
      expect((err as InvalidIdentifierError).problem).toBe("empty");
      expect((err as InvalidIdentifierError).code).toBe("PG_PRIME_INVALID_IDENTIFIER");
    }
  });

  it("isValidIdent is the non-throwing mirror", () => {
    expect(isValidIdent("users")).toBe(true);
    expect(isValidIdent("")).toBe(false);
    expect(isValidIdent(42)).toBe(false);
  });
});

describe("quoteLiteral", () => {
  it("doubles quotes, and switches to E'' as soon as a backslash appears", () => {
    expect(quoteLiteral("plain")).toBe("'plain'");
    expect(quoteLiteral("it's")).toBe("'it''s'");
    // under standard_conforming_strings = off, `'a\\'` would end the literal early
    expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
    expect(quoteLiteral("a\\'b")).toBe("E'a\\\\''b'");
  });

  it("rejects what has no encoding", () => {
    expect(() => quoteLiteral(`a${NUL}`)).toThrow(RangeError);
    expect(() => quoteLiteral(String.fromCharCode(0xdc00))).toThrow(RangeError);
  });
});

describe("byte and surrogate probes", () => {
  it("counts UTF-8 bytes, not code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("detects lone surrogates and NUL", () => {
    expect(hasLoneSurrogate("😀")).toBe(false);
    expect(hasLoneSurrogate(String.fromCharCode(0xd83d))).toBe(true);
    expect(hasLoneSurrogate(String.fromCharCode(0xde00))).toBe(true);
    expect(hasNul("ok")).toBe(false);
    expect(hasNul(`o${NUL}k`)).toBe(true);
  });
});

/**
 * `makeObjectName` is a PORT, so the oracles here are names a real PostgreSQL 18 printed
 * (`select conname from pg_constraint where contype = 'n'`), never a re-derivation of the
 * implementation. Getting this wrong makes `cascadeNotNullRenames` rename a constraint to
 * a name no `CREATE TABLE` would produce, which the D10 dump oracle then reports as drift.
 */
describe("the server's own auto-naming rule", () => {
  it("is the plain concatenation when everything fits", () => {
    expect(defaultNotNullName("users", "first_name")).toBe("users_first_name_not_null");
    expect(defaultNotNullName("t", "a")).toBe("t_a_not_null");
    expect(makeObjectName("orders", "customer_id", "fkey")).toBe("orders_customer_id_fkey");
  });

  it("shortens the LONGER piece, not the concatenation, when it does not fit", () => {
    // observed on PostgreSQL 18.6: CREATE TABLE p.<30×a> (<30×b> int NOT NULL)
    expect(defaultNotNullName("a".repeat(30), "b".repeat(30))).toBe(`${"a".repeat(27)}_${"b".repeat(26)}_not_null`);
    // a right-truncation of `<30×a>_<30×b>_not_null` would have kept 30 a's and lost
    // the `_not_null` suffix entirely, which is the mutation this case exists to catch
    expect(defaultNotNullName("a".repeat(30), "b".repeat(30)).endsWith("_not_null")).toBe(true);
    expect(utf8ByteLength(defaultNotNullName("a".repeat(30), "b".repeat(30)))).toBe(MAX_IDENT_BYTES);
  });

  it("only shortens the piece that is too long", () => {
    // 60 + 1: name2 cannot shrink below the point where name1 becomes the longer one
    expect(defaultNotNullName("a".repeat(60), "b")).toBe(`${"a".repeat(52)}_b_not_null`);
  });

  it("never splits a multi-byte character while clipping", () => {
    // "é" is 2 bytes, so a byte budget landing mid-character must back off a whole one
    const name = defaultNotNullName("é".repeat(30), "b".repeat(30));
    expect(name).toBe(`${"é".repeat(13)}_${"b".repeat(26)}_not_null`);
    expect(utf8ByteLength(name)).toBeLessThanOrEqual(MAX_IDENT_BYTES);
    expect(name.includes("�")).toBe(false);
  });
});
