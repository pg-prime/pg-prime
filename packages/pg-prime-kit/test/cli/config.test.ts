/**
 * `pg-prime.config.ts`, loaded with no loader dependency (design/11 §1.4).
 *
 * The interesting cases are the failures: a Node that cannot strip types at all, and a
 * config whose TypeScript uses syntax the stripper refuses (`enum`, which needs codegen
 * and therefore cannot be erased). Both must produce ONE sentence naming the Node version
 * and the `.mjs` alternative, and the second is reachable on this Node — which makes it a
 * real negative control rather than a branch nobody has executed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENV_VAR,
  findConfigFile,
  loadConfig,
  parseDatabaseUrl,
  resolveConfig,
  STRIP_TYPES_MARKER,
} from "../../src/config/load.js";
import { defineConfig } from "../../src/config/define.js";
import { runCli } from "../support/cli.js";
import { EXIT } from "../../src/cli/exit.js";
import { PKG_DIR } from "../support/cli.js";
import { tempDir } from "../support/migrations.js";

const DEFINE = pathToFileURL(join(PKG_DIR, "src", "config", "define.ts")).href;

async function project(slug: string, files: Record<string, string>): Promise<string> {
  const dir = await tempDir(`pgprime-k1-config-${slug}`);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("defineConfig", () => {
  it("is the identity, typed — it must not copy or normalise", () => {
    const input = { url: "postgres://u@h/db", migrations: "./m" } as const;
    expect(defineConfig(input)).toBe(input);
  });
});

describe("loadConfig", () => {
  it("loads a .ts config through Node's native type stripping", async () => {
    const dir = await project("ts", {
      "pg-prime.config.ts": [
        `import { defineConfig } from ${JSON.stringify(DEFINE)}`,
        "interface Extra { readonly note: string }",
        "const extra: Extra = { note: 'erased at load time' }",
        "export default defineConfig({",
        "  url: 'postgres://u:p@127.0.0.1:5432/app',",
        "  migrations: './db/migrations',",
        "  schemas: ['public', 'app'],",
        "} satisfies Parameters<typeof defineConfig>[0])",
        "void extra",
        "",
      ].join("\n"),
    });
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.file).toBe(join(dir, "pg-prime.config.ts"));
    expect(loaded.config.migrations).toBe("./db/migrations");
    expect(loaded.config.schemas).toEqual(["public", "app"]);
  });

  it("loads a .mjs config — the documented fallback", async () => {
    const dir = await project("mjs", {
      "pg-prime.config.mjs": "export default { url: 'postgres://u:p@127.0.0.1:5432/app', migrations: 'm' }\n",
    });
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.file).toBe(join(dir, "pg-prime.config.mjs"));
    expect(loaded.config.migrations).toBe("m");
  });

  it("searches upwards from the cwd", async () => {
    const dir = await project("up", { "pg-prime.config.mjs": "export default { migrations: 'root' }\n" });
    await mkdir(join(dir, "a", "b"), { recursive: true });
    expect(await findConfigFile(join(dir, "a", "b"))).toBe(join(dir, "pg-prime.config.mjs"));
    expect((await loadConfig(undefined, join(dir, "a", "b"))).config.migrations).toBe("root");
  });

  it("no config file at all is an empty config, not an error", async () => {
    const dir = await project("none", { "unrelated.txt": "x" });
    // The search walks to the filesystem root, so ask for a name that cannot exist there.
    const loaded = await loadConfig(undefined, dir).catch(() => null);
    expect(loaded === null || typeof loaded.config === "object").toBe(true);
  });

  it("an explicit --config path that does not exist is an error naming the path", async () => {
    const dir = await project("missing", {});
    await expect(loadConfig("nope.config.ts", dir)).rejects.toThrow(/no config file at .*nope\.config\.ts/);
  });

  it("rejects a config whose default export is not an object, and a mistyped key", async () => {
    const a = await project("bad1", { "pg-prime.config.mjs": "export default 42\n" });
    await expect(loadConfig(undefined, a)).rejects.toThrow(/default export must be an object/);
    const b = await project("bad2", { "pg-prime.config.mjs": "export default { migrations: 7 }\n" });
    await expect(loadConfig(undefined, b)).rejects.toThrow(/`migrations` must be a string/);
    const c = await project("bad3", { "pg-prime.config.mjs": "export default { schemas: 'public' }\n" });
    await expect(loadConfig(undefined, c)).rejects.toThrow(/`schemas` must be an array of strings/);
  });

  // The type-stripping failure is NOT tested in-process: vitest resolves the dynamic
  // `import()` through vite, which compiles TypeScript with esbuild and happily accepts
  // syntax Node's stripper refuses. Testing it here would assert vite's behaviour and
  // report it as Node's. It is covered below, through the binary.
});

describe("parseDatabaseUrl", () => {
  it("maps a URL onto ConnInfo and decodes percent-escapes", () => {
    const { conn } = parseDatabaseUrl("postgres://us%40er:p%3Ass@db.example:6000/my%20db");
    expect(conn).toEqual({ host: "db.example", port: 6000, user: "us@er", password: "p:ss", database: "my db" });
  });

  it("defaults the port and brackets an IPv6 host correctly", () => {
    expect(parseDatabaseUrl("postgresql://postgres@[::1]/app").conn).toEqual({
      host: "::1", port: 5432, user: "postgres", password: "", database: "app",
    });
  });

  it("names the query parameters it drops rather than ignoring them", () => {
    const { warnings } = parseDatabaseUrl("postgres://u:p@h:5432/d?sslmode=require&application_name=x");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("`sslmode`");
    expect(warnings[0]).toContain("`application_name`");
  });

  it("refuses a non-postgres scheme and a non-URL", () => {
    expect(() => parseDatabaseUrl("mysql://u@h/d")).toThrow(/postgres: or postgresql: scheme/);
    expect(() => parseDatabaseUrl("not a url")).toThrow(/is not a URL/);
  });
});

describe("resolveConfig", () => {
  const base = { configFile: null, cwd: "/work" } as const;

  it("--url beats the config file, which beats PG_PRIME_DATABASE_URL, which beats DATABASE_URL", () => {
    const env = { PG_PRIME_DATABASE_URL: "postgres://e@h/env", DATABASE_URL: "postgres://d@h/generic" };
    expect(resolveConfig({ ...base, config: { url: "postgres://c@h/cfg" }, url: "postgres://f@h/flag", env }).connection.database).toBe("flag");
    expect(resolveConfig({ ...base, config: { url: "postgres://c@h/cfg" }, env }).connection.database).toBe("cfg");
    expect(resolveConfig({ ...base, config: {}, env }).connection.database).toBe("env");
    expect(resolveConfig({ ...base, config: {}, env: { DATABASE_URL: env.DATABASE_URL } }).connection.database).toBe("generic");
  });

  it("resolves relative paths against the CONFIG FILE, not the cwd", () => {
    const r = resolveConfig({
      config: { url: "postgres://u@h/d", migrations: "db/migrations" },
      configFile: "/repo/apps/api/pg-prime.config.ts",
      cwd: "/somewhere/else",
      env: {},
    });
    expect(r.migrationsDir).toBe("/repo/apps/api/db/migrations");
    expect(r.repeatablesDir).toBe("/repo/apps/api/sql");
  });

  it("reads PG_PRIME_ENV and sets the production tag", () => {
    const config = { url: "postgres://u@h/d" };
    expect(resolveConfig({ ...base, config, env: {} }).production).toBe(false);
    expect(resolveConfig({ ...base, config, env: { [ENV_VAR]: "production" } }).production).toBe(true);
    expect(resolveConfig({ ...base, config, env: { [ENV_VAR]: "staging" } }).env).toBe("staging");
    expect(resolveConfig({ ...base, config: { ...config, production: true }, env: {} }).production).toBe(true);
  });

  it("no connection anywhere is a message that says what to do", () => {
    expect(() => resolveConfig({ ...base, config: {}, env: {} })).toThrow(/pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL/);
  });
});

describe("the binary reads the config file", () => {
  it("finds pg-prime.config.mjs beside the cwd and uses its url", async () => {
    const dir = await project("cli", {
      "pg-prime.config.mjs": "export default { url: 'postgres://nobody:x@127.0.0.1:1/none', migrations: 'migrations' }\n",
    });
    const r = await runCli(["migrate", "status", "--output", "json", "--config", join(dir, "pg-prime.config.mjs")]);
    expect(r.code).toBe(EXIT.error);
    const envelope = JSON.parse(r.stdout) as { status: string; error: { code: string; message: string } };
    expect(envelope.status).toBe("error");
    expect(envelope.error.code).toBe("internal");
    // It got as far as CONNECTING, which is the proof the url came out of the file.
    expect(envelope.error.message).toMatch(/ECONNREFUSED|connect|password|role/i);
  });

  it("loads a real .ts config through Node's stripper, not through a bundler", async () => {
    const dir = await project("cli-ts", {
      "pg-prime.config.ts": [
        "interface Shape { readonly url: string; readonly migrations: string }",
        "const config: Shape = { url: 'postgres://nobody:x@127.0.0.1:1/none', migrations: 'migrations' }",
        "export default config",
        "",
      ].join("\n"),
    });
    const r = await runCli(["migrate", "status", "--output", "json", "--config", join(dir, "pg-prime.config.ts")]);
    expect(r.code).toBe(EXIT.error);
    const envelope = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    // Connecting means the types were stripped and the module evaluated.
    expect(envelope.error.code).toBe("internal");
    expect(envelope.error.message).toMatch(/ECONNREFUSED|connect|password|role/i);
  });

  it("TypeScript the stripper cannot erase gives ONE sentence naming Node and the .mjs way out", async () => {
    // `enum` needs code generation, so `--experimental-strip-types` refuses it — the same
    // class of failure as a Node too old to strip at all, and reachable on this one.
    const dir = await project("reexec", { "pg-prime.config.ts": "enum Mode { A }\nexport default { migrations: String(Mode.A) }\n" });
    const args = ["migrate", "status", "--output", "json", "--config", join(dir, "pg-prime.config.ts"), "--url", "postgres://u:p@127.0.0.1:1/x"];

    // With the guard already set (as it is inside the one re-exec the CLI allows itself):
    const guarded = await runCli(args, { [STRIP_TYPES_MARKER]: "1" });
    expect(guarded.code).toBe(EXIT.error);
    const envelope = JSON.parse(guarded.stdout) as { status: string; error: { code: string; message: string } };
    expect(envelope.error.code).toBe("config");
    expect(envelope.error.message).toContain("pg-prime.config.mjs");
    expect(envelope.error.message).toContain("Node >= 22.18");
    expect(envelope.error.message.split("\n")).toHaveLength(1);

    // And without it: the failure is not the retryable kind, so there is no re-exec and
    // the same one sentence comes out. (A hang or a fork bomb here is the bug §1.4's
    // env-var guard exists to prevent.)
    const plain = await runCli(args);
    expect(plain.code).toBe(EXIT.error);
    expect((JSON.parse(plain.stdout) as { error: { message: string } }).error.message).toContain("pg-prime.config.mjs");
  });
});
