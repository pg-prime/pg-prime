/**
 * The kit's quoter is a PORT of `pgormjs`'s, and it used to be a weaker one: it accepted
 * the empty string, a NUL, a lone surrogate and a 200-byte name, and its `quoteLiteral`
 * doubled `'` without switching to `E'…'` when a backslash was present — the exact gap
 * behind Kysely's GHSA-8cpq-38p9-67gx. Everything it emits goes straight into DDL.
 *
 * The oracles here are hand-written PostgreSQL spellings (what `format('%I')` / `%L`
 * produce), never a re-derivation of the implementation.
 */

import { describe, expect, it } from "vitest";
import {
  hasLoneSurrogate,
  hasNul,
  isValidIdent,
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
      expect((err as InvalidIdentifierError).code).toBe("PGORM_INVALID_IDENTIFIER");
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
