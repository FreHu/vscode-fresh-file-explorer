import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { execGitWithArgs } from "../git/gitOperations";
import { asAbsolutePath } from "../pathTypes";
import { findRepoForFile } from "../types";
import { normalizePath } from "../utils";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";
import { log } from "../extension/logger";

/**
 * Normalize a Git remote URL to a plain HTTPS URL without credentials or .git suffix.
 *
 * Handles:
 * - SCP-style SSH:        git@github.com:user/repo.git
 * - SSH scheme:           ssh://git@github.com/user/repo.git
 * - HTTPS with creds:     https://token@github.com/user/repo.git
 * - Azure DevOps SSH:     git@ssh.dev.azure.com:v3/org/project/repo
 * - Legacy visualstudio:  https://org.visualstudio.com/project/_git/repo
 */
export function normalizeRemoteUrl(raw: string): string {
  let url = raw.trim().replace(/\r?\n$/, "");

  // Azure DevOps special SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const adoSshMatch = url.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/);
  if (adoSshMatch) {
    const [, org, project, repo] = adoSshMatch;
    return `https://dev.azure.com/${org}/${project}/_git/${repo.replace(/\.git$/, "")}`;
  }

  // SCP-style SSH: git@host:path
  const scpMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    const [, host, repoPath] = scpMatch;
    url = `https://${host}/${repoPath}`;
  }

  // ssh:// scheme → https://
  if (url.startsWith("ssh://")) {
    url = url.replace(/^ssh:\/\/(?:git@)?/, "https://");
  }

  // Strip user@ credentials from HTTPS URL (e.g. https://user@host or https://user:token@host)
  url = url.replace(/^(https?:\/\/)[^@]+@/, "$1");

  // Legacy Azure DevOps: https://org.visualstudio.com/project/_git/repo
  const vstsMatch = url.match(/^https:\/\/([^.]+)\.visualstudio\.com\/(.*)$/);
  if (vstsMatch) {
    const [, org, rest] = vstsMatch;
    url = `https://dev.azure.com/${org}/${rest}`;
  }

  // Strip trailing .git
  url = url.replace(/\.git$/, "");

  // Strip trailing slash
  url = url.replace(/\/$/, "");

  return url;
}

type HostKind = "github" | "gitlab" | "bitbucket" | "azuredevops" | "unknown";

/** Identify the type of git host from a normalized HTTPS URL. */
export function detectHostKind(normalizedUrl: string): HostKind {
  if (/github\.com/i.test(normalizedUrl)) {
    return "github";
  }
  if (/gitlab\.com|\/\/gitlab\./i.test(normalizedUrl)) {
    return "gitlab";
  }
  if (/bitbucket\.org/i.test(normalizedUrl)) {
    return "bitbucket";
  }
  if (/dev\.azure\.com|visualstudio\.com/i.test(normalizedUrl)) {
    return "azuredevops";
  }
  return "unknown";
}

/**
 * Build a browser URL for a specific file or directory in a remote repository.
 *
 * @param normalizedRemoteUrl  Canonical HTTPS URL (no .git, no credentials)
 * @param branch               Branch name
 * @param filePathInRepo       Forward-slash path relative to repo root (empty string = repo root)
 * @param isDirectory          Whether the path is a directory
 * @returns Browser URL, or undefined if host is unrecognised
 */
export function buildRemoteFileUrl(
  normalizedRemoteUrl: string,
  branch: string,
  filePathInRepo: string,
  isDirectory: boolean,
): string | undefined {
  const kind = detectHostKind(normalizedRemoteUrl);
  const encodedBranch = encodeURIComponent(branch);
  // Keep path segments intact but encode individual components
  const encodedPath = filePathInRepo
    .split("/")
    .map(seg => encodeURIComponent(seg))
    .join("/");

  switch (kind) {
    case "github": {
      if (!filePathInRepo) {
        // Repo root
        return normalizedRemoteUrl;
      }
      const treeOrBlob = isDirectory ? "tree" : "blob";
      return `${normalizedRemoteUrl}/${treeOrBlob}/${encodedBranch}/${encodedPath}`;
    }
    case "gitlab": {
      if (!filePathInRepo) {
        return normalizedRemoteUrl;
      }
      const treeOrBlob = isDirectory ? "tree" : "blob";
      return `${normalizedRemoteUrl}/-/${treeOrBlob}/${encodedBranch}/${encodedPath}`;
    }
    case "bitbucket": {
      if (!filePathInRepo) {
        return `${normalizedRemoteUrl}/src/${encodedBranch}/`;
      }
      const trailingSlash = isDirectory ? "/" : "";
      return `${normalizedRemoteUrl}/src/${encodedBranch}/${encodedPath}${trailingSlash}`;
    }
    case "azuredevops": {
      // Azure DevOps uses query params; no separate tree/blob concept
      const filePath = filePathInRepo ? `/${encodedPath}` : "/";
      return `${normalizedRemoteUrl}?path=${filePath}&version=GB${encodedBranch}`;
    }
    default:
      return undefined;
  }
}

export async function handleCopyRemoteUrl(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  const allItems =
    selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const fileItems = allItems.filter(i => i?.resourceUri);
  if (fileItems.length === 0) {
    return;
  }

  const urls: string[] = [];
  const failed: string[] = [];

  for (const fileItem of fileItems) {
    const filePath = asAbsolutePath(normalizePath(fileItem.resourceUri.fsPath));
    const folder = findWorkspaceFolderForPath(filePath, freshFileProvider.workspaceFolders);
    if (!folder) {
      log(`Copy Remote URL: could not find workspace folder for ${filePath}`, "warn");
      failed.push(path.basename(filePath));
      continue;
    }

    const relativePath = normalizePath(path.relative(folder.path, filePath));
    const repoLocation = findRepoForFile(folder, relativePath);
    if (!repoLocation) {
      log(`Copy Remote URL: could not find repo for ${filePath}`, "warn");
      failed.push(path.basename(filePath));
      continue;
    }

    const repoRoot = repoLocation.repoFullPath;

    try {
      // Fetch remote URL and branch in parallel
      const [rawRemote, rawBranch] = await Promise.all([
        execGitWithArgs(["remote", "get-url", "origin"], repoRoot, { timeout: 5000 }),
        execGitWithArgs(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, { timeout: 5000 }),
      ]);

      const normalizedRemote = normalizeRemoteUrl(rawRemote);
      const branch = rawBranch.trim();
      const fileUrl = buildRemoteFileUrl(
        normalizedRemote,
        branch,
        repoLocation.filePathInRepo,
        fileItem.isDirectory,
      );

      if (fileUrl) {
        urls.push(fileUrl);
      } else {
        log(`Copy Remote URL: unrecognised host for ${normalizedRemote}`, "warn");
        failed.push(path.basename(filePath));
      }
    } catch (err) {
      log(`Copy Remote URL: git error for ${filePath}: ${err}`, "warn");
      failed.push(path.basename(filePath));
    }
  }

  if (urls.length > 0) {
    await vscode.env.clipboard.writeText(urls.join("\n"));
  }

  if (failed.length > 0) {
    vscode.window.showWarningMessage(
      `Copy Remote URL: could not resolve URL for: ${failed.join(", ")}`,
    );
  }
}
