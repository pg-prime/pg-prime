/**
 * `import { schema } from '../schema.js'` inside a `.ts` file the kit loads (design/12 F2 item j).
 *
 * Node's native type stripping compiles a `.ts` file but does **not** rewrite its specifiers: it
 * resolves them literally, so `'../schema.js'` looks for `schema.js` on disk and fails with
 * `ERR_MODULE_NOT_FOUND` in a project that has never run `tsc`. That specifier is not a mistake —
 * it is the one TypeScript's own `nodenext` resolution requires, the one `tsc` emits, and
 * therefore the one every schema module, config and seed in a compiled project already writes.
 *
 * Three ways out were on the table (design/12 F2 item j):
 *
 *   1. **a resolve hook** — this file;
 *   2. **documenting `.ts` specifiers** as the convention for kit-loaded files. Rejected: it
 *      needs TypeScript ≥ 5.7 with `allowImportingTsExtensions` *and*
 *      `rewriteRelativeImportExtensions` before `tsc` will accept it, it makes the seed's import
 *      spelling differ from every other import in the same project, and a project that later
 *      compiles to JavaScript then has to change it back;
 *   3. **rewriting `.js` → `.ts` in the file's text**. Rejected outright: the kit does not edit
 *      the user's source.
 *
 * So: a resolve hook, and the narrowest one that can work. It fires only when the specifier is
 * **relative**, ends in a JavaScript extension, that file does **not** exist, and the TypeScript
 * file beside it does. Every resolution that already succeeded keeps succeeding — including
 * every one inside `@pg-prime/kit` itself, which ships as built `.js` — so a compiled project
 * cannot observe the hook at all, and an uncompiled one gets the resolution `tsc` promised it.
 *
 * `module.registerHooks` (Node ≥ 22.15) runs the hook **in this thread**, with no worker and no
 * separate hooks file to ship. On 22.12–22.14 it does not exist, {@link enableTsSpecifiers}
 * returns `false`, and the import fails with a raw `ERR_MODULE_NOT_FOUND` from Node — so
 * `config/load.ts` recognises exactly that shape and replaces it with `tsSpecifierAdvice`'s
 * sentence, which names the file, the `.js` that is not there, the `.ts` that is, and the two ways
 * out. (An earlier version of this paragraph claimed `stripTypesAdvice`'s sentence covered it. It
 * does not: that one is reached only for the four type-stripping error codes, and
 * `ERR_MODULE_NOT_FOUND` is not one of them — design/13 §5, E's F3.)
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** JavaScript extension → the TypeScript extension Node can strip types from. */
const SIBLING: readonly (readonly [string, string])[] = [
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
];

interface ResolveContext {
  readonly parentURL?: string | undefined;
}
interface ResolveResult {
  readonly url: string;
}
type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult;
interface HookRegistrar {
  readonly registerHooks?: (options: {
    resolve?: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => ResolveResult;
  }) => unknown;
}

const onDisk = (url: URL): boolean => {
  try {
    return existsSync(fileURLToPath(url));
  } catch {
    // a non-file URL (data:, http:) — not ours to redirect
    return false;
  }
};

/**
 * The same rule asked of a RESOLVED url — which is all an `ERR_MODULE_NOT_FOUND` gives you
 * (`err.url`). Returns the TypeScript sibling's url, or `null` when this is not the case at hand.
 *
 * The disk half lives here and {@link typeScriptSibling} delegates to it, so the hook and the
 * error message cannot come to different conclusions about the same file.
 */
export function typeScriptSiblingUrl(url: string): string | null {
  const pair = SIBLING.find(([js]) => url.endsWith(js));
  if (pair === undefined) return null;
  let asIs: URL;
  let candidate: URL;
  try {
    asIs = new URL(url);
    candidate = new URL(`${url.slice(0, -pair[0].length)}${pair[1]}`);
  } catch {
    return null;
  }
  // The `.js` winning is the whole safety property: a project that compiled keeps its own build.
  if (onDisk(asIs) || !onDisk(candidate)) return null;
  return candidate.href;
}

/** The rewrite, as a pure function, so a test can ask what it would do without a Node hook. */
export function typeScriptSibling(specifier: string, parentURL: string | undefined): string | null {
  if (parentURL === undefined) return null;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const pair = SIBLING.find(([js]) => specifier.endsWith(js));
  if (pair === undefined) return null;
  let resolved: string;
  try {
    resolved = new URL(specifier, parentURL).href;
  } catch {
    return null;
  }
  if (typeScriptSiblingUrl(resolved) === null) return null;
  return `${specifier.slice(0, -pair[0].length)}${pair[1]}`;
}

let installed: Promise<boolean> | null = null;

/**
 * Install the hook once per process. Safe to call from every entry point that imports a user
 * module, and a no-op on a Node that has no `registerHooks`.
 *
 * @returns `true` when the hook is in force. `false` is Node 22.12–22.14, and it is the fact
 *   `config/load.ts` needs to tell "this `.js` genuinely does not exist" from "this Node cannot
 *   redirect it to the `.ts` beside it".
 */
export async function enableTsSpecifiers(): Promise<boolean> {
  installed ??= (async (): Promise<boolean> => {
    const nodeModule = (await import("node:module")) as unknown as HookRegistrar;
    if (typeof nodeModule.registerHooks !== "function") return false;
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        const sibling = typeScriptSibling(specifier, context.parentURL);
        return nextResolve(sibling ?? specifier, context);
      },
    });
    return true;
  })();
  return installed;
}
