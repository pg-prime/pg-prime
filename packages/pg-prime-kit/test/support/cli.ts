/**
 * Spawning the real binary (R17).
 *
 * Nothing here calls a command function: the thing under test is `dist/cli.js` with an
 * argv, because that is what an orchestrator runs and because argv parsing, config
 * loading, envelope rendering and the exit code are all part of the contract.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectionString, type ConnInfo } from "../../src/db/pg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_DIR: string = resolve(here, "../..");
export const CLI: string = join(PKG_DIR, "dist", "cli.js");

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

export type BackgroundCli = ChildProcess & { output: () => string; done: Promise<number> };

/**
 * Spawn without waiting — the R15 resume test kills this one, and the lock test races it.
 *
 * `done` is created HERE rather than by the caller attaching `once("close")` later:
 * `close` fires once, and a caller that attaches after the child has already exited waits
 * for an event that will never come again. That is a hang, not a failure, and it cost one
 * three-minute test timeout to find.
 */
export function spawnCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): BackgroundCli {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout?.on("data", (c: Buffer) => (buffer += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (buffer += c.toString("utf8")));
  const done = new Promise<number>((r) => child.on("close", (code) => r(code ?? -1)));
  return Object.assign(child, { output: (): string => buffer, done });
}

export const urlOf = (conn: ConnInfo): string => connectionString(conn);

/** Parse the `--output json` envelope, with the raw text in the failure message. */
export function envelopeOf(result: CliResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `stdout was not one JSON document (exit ${String(result.code)}): ${err instanceof Error ? err.message : String(err)}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value, or throw after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await sleep(25);
  }
}
