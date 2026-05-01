import * as vscode from "vscode";
import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import type { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { handleGetFilesForCodeTelescope } from "../commands/codeTelescopeCommand";

const FINDER_TYPE = "ext.frehu.fresh-file-explorer.freshFiles";

/**
 * Minimal type for the Code Telescope public API.
 * Defined locally to keep the integration loose.
 * https://github.com/guilhermec-costa/code-telescope/blob/master/backend/integration/api/api.d.ts
 */
interface CodeTelescopeAPI {
  registerFinder(registration: {
    provider: {
      fuzzyAdapterType: string;
      previewAdapterType: string;
      dataAdapterType: string;
      finderName?: string;
      finderDescription?: string;
      querySelectableOptions(): Promise<unknown>;
      onSelect(item: string): void | Promise<void>;
      getPreviewData(item: string): Promise<{ kind: string; content: string; language?: string; metadata?: { filePath?: string } }>;
    };
    dataAdapter: {
      typeName: string;
      parseOptions(data: unknown): unknown[];
      getSearchText(option: unknown): string;
      getSelectionValue(option: unknown): unknown;
    } & (
      | { htmlWrapperPreset: "file-icon" | "simple" }
      | { htmlWrapperPreset: "codicon"; getCodiconName: (option: unknown) => string }
      | { getHtmlWrapper: (option: unknown, highlightedContent: string) => string }
    );
  }): vscode.Disposable;
  openFinder(type: string): Promise<void>;
}

/**
 * Registers the Fresh Files finder with Code Telescope via its programmatic API.
 * Returns the disposable, or undefined if Code Telescope is not installed or
 * the integration setting is disabled.
 *
 * No extensionDependency is declared — this is a loose, opt-in integration.
 */
export async function registerCodeTelescopeFinder(
  freshFileProvider: FreshFileProvider,
): Promise<vscode.Disposable | undefined> {
  if (!ConfigService.getCodeTelescopeIntegration()) {
    return undefined;
  }

  const telescopeExt = vscode.extensions.getExtension<CodeTelescopeAPI>("guichina.code-telescope");
  if (!telescopeExt) {
    return undefined;
  }

  const api = await telescopeExt.activate();

  const disposable = api.registerFinder({
    provider: {
      fuzzyAdapterType: FINDER_TYPE,
      previewAdapterType: "preview.buffer",
      dataAdapterType: FINDER_TYPE,
      finderName: "Fresh Files",
      finderDescription: "Recently changed files tracked by Fresh File Explorer",

      async querySelectableOptions() {
        return handleGetFilesForCodeTelescope(freshFileProvider) ?? [];
      },

      async onSelect(item: string) {
        const file = JSON.parse(item) as { absolutePath: string };
        await vscode.window.showTextDocument(vscode.Uri.file(file.absolutePath));
      },

      async getPreviewData(item: string) {        
        const file = JSON.parse(item) as { absolutePath: string, relativePath: string };
        let content: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file.absolutePath));
          content = Buffer.from(bytes).toString("utf-8");
        } catch {
          content = `(Could not read file: ${file.absolutePath})`;
        }

        return { kind: "text", content, metadata: { filePath: file.relativePath } };
      },
    },

    dataAdapter: {
      typeName: FINDER_TYPE,

      parseOptions(data) {
        return data as unknown[];
      },

      getSearchText(option) {
        return (option as { relativePath: string }).relativePath;
      },

      getSelectionValue(option) {
        return JSON.stringify(option);
      },

      getHtmlWrapper(option: unknown, highlightedContent: string) {
        // NOTE: we can't import our helper function, so it's copied here
        const STATUS_LABELS: Record<string, string> = {
          // Standard statuses (from git log --name-status, single-char)
          M: "modified",
          A: "added",
          D: "deleted",
          R: "renamed",
          C: "copied",
          T: "type changed",
          "??": "untracked",
          "!!": "ignored",
          // Raw porcelain XY codes — unstaged only (X == ' ')
          " M": "modified",
          " D": "deleted",
          " A": "added",
          " T": "type changed",
          // Raw porcelain XY codes — staged only (Y == ' ')
          "M ": "modified (staged)",
          "A ": "added (staged)",
          "D ": "deleted (staged)",
          "R ": "renamed (staged)",
          "C ": "copied (staged)",
          "T ": "type changed (staged)",
          // Raw porcelain XY codes — staged + unstaged
          MM: "modified (staged + unstaged)",
          AM: "added (staged) + modified",
          AD: "added (staged) + deleted",
          MD: "modified (staged) + deleted",
          RM: "renamed (staged) + modified",
          // Merge conflict statuses
          UU: "conflict (both modified)",
          AA: "conflict (both added)",
          DD: "conflict (both deleted)",
          AU: "conflict (added by us)",
          UA: "conflict (added by them)",
          DU: "conflict (deleted by us)",
          UD: "conflict (deleted by them)",
        };

        function getStatusLabel(status: string): string {
          if (STATUS_LABELS[status]) {
            return STATUS_LABELS[status];
          }

          if (status.length === 2 && status !== "??" && status !== "!!") {
            const key = status[1] !== " " ? status[1] : status[0];
            if (STATUS_LABELS[key]) {
              return STATUS_LABELS[key];
            }
          }
          if (status.length > 1 && (status[0] === "R" || status[0] === "C") && /^\d+$/.test(status.slice(1))) {
            return STATUS_LABELS[status[0]] ?? status[0].toLowerCase();
          }
          return status.toLowerCase();
        }

        const o = option as {
          status: string | undefined;
          isPending: boolean;
          author: string | undefined;
          commitHash: string | undefined;
          commitMessage: string | undefined;
        };

        const statusLabel = getStatusLabel(o.status ?? "");
        const author = o.author ?? "";
        const hash = o.commitHash ? o.commitHash.slice(0, 7) : "";
        const msg = o.commitMessage ? (o.commitMessage.length > 35 ? o.commitMessage.slice(0, 35) + "…" : o.commitMessage) : "";
        const metaParts = [statusLabel, author, hash].filter(Boolean);
        const meta = metaParts.join("  ·  ");
        const msgHtml = msg ? `<span style="opacity:0.45;font-size:0.8em;margin-left:10px;white-space:nowrap;flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${msg}</span>` : "";
        const metaHtml = meta ? `<span style="opacity:0.55;font-size:0.8em;margin-left:auto;padding-left:12px;white-space:nowrap;flex-shrink:0">${meta}</span>` : "";
        return `<span style="display:flex;align-items:center;width:100%;min-width:0"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1">${highlightedContent}</span>${msgHtml}${metaHtml}</span>`;
      },
    },
  });

  log("Code Telescope integration: registered fresh files finder via API");
  return disposable;
}

/**
 * Opens the fresh files finder in Code Telescope.
 * Returns false if Code Telescope is not available or the integration is disabled,
 * so the caller can fall back to the built-in quick pick.
 */
export async function openFreshFilesTelescope(): Promise<boolean> {
  if (!ConfigService.getCodeTelescopeIntegration()) {
    return false;
  }

  const telescopeExt = vscode.extensions.getExtension<CodeTelescopeAPI>("guichina.code-telescope");
  if (!telescopeExt) {
    return false;
  }

  const api = await telescopeExt.activate();
  await api.openFinder(FINDER_TYPE);
  return true;
}
