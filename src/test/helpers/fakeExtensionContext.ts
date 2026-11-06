import * as vscode from "vscode";

/**
 * In-memory `vscode.ExtensionContext` whose `workspaceState` is a Map, for
 * exercising workspace-state persistence without a real extension context.
 */
export function makeFakeContext(seed?: Record<string, unknown>): vscode.ExtensionContext {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    workspaceState: {
      get(key: string, fallback?: unknown) {
        return store.has(key) ? store.get(key) : fallback;
      },
      update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) { store.delete(key); } else { store.set(key, value); }
        return Promise.resolve();
      },
      keys(): readonly string[] { return [...store.keys()]; },
      setKeysForSync() { /* no-op */ },
    },
  } as unknown as vscode.ExtensionContext;
}
