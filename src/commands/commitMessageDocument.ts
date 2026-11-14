import * as vscode from "vscode";

import { execGitWithArgs } from "../git/gitOperations";
import { ConfigService } from "../config/configService";

export interface CommitDetails {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  commitDate: string;
  refs: string;
  message: string;
}

const FIELD_SEP = "\x1f";
const FORMAT = ["%H", "%an", "%ae", "%aI", "%cn", "%cI", "%D", "%B"].join(FIELD_SEP);

export function parseCommitDetails(output: string): CommitDetails {
  const [hash, authorName, authorEmail, authorDate, committerName, commitDate, refs, ...rest] = output.split(FIELD_SEP);
  return {
    hash: hash.trim(), authorName, authorEmail, authorDate, committerName, commitDate,
    refs: refs.trim(), message: rest.join(FIELD_SEP).trim(),
  };
}

/** Message first (the `git-commit` grammar highlights line one as the subject), metadata after as comments. */
export function renderCommitDocument(d: CommitDetails): string {
  const meta = [
    `commit ${d.hash}`,
    `Author: ${d.authorName} <${d.authorEmail}>`,
    `Date:   ${d.authorDate}`,
  ];
  if (d.committerName !== d.authorName || d.commitDate !== d.authorDate) {
    meta.push(`Commit: ${d.committerName}, ${d.commitDate}`);
  }
  if (d.refs) { meta.push(`Refs:   ${d.refs}`); }
  return `${d.message}\n\n${meta.map(l => `# ${l}`).join("\n")}\n`;
}

/** Serves `fresh-commit-message:/<shortHash>/COMMIT_EDITMSG?<repo>#<hash>`. */
export class CommitMessageContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "fresh-commit-message";

  static uriFor(repoRoot: string, commitHash: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: CommitMessageContentProvider.scheme,
      path: `/${commitHash.slice(0, 7)}/Commit message`,
      query: repoRoot,
      fragment: commitHash,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const commitHash = uri.fragment.replace(/^base:/, "");
    const output = await execGitWithArgs(["show", "-s", `--format=${FORMAT}`, commitHash], uri.query, {
      timeout: ConfigService.getGitTimeoutMs(),
    });
    return renderCommitDocument(parseCommitDetails(output));
  }
}
