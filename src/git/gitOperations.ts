import * as cp from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";

import { ConfigService } from "../config/configService";

const gitPathDecoder = new TextDecoder("utf-8");
const gitPathEncoder = new TextEncoder();

/**
 * Execute a git command with arguments safely (no shell interpolation).
 * This is CRITICAL for security - avoids shell injection from filenames.
 * @param args Array of git arguments (e.g., ['show', 'HEAD:file.txt'])
 * @param cwd The working directory
 * @param options Optional settings: timeout (ms)
 * @returns The command output as a string
 */
export function execGitWithArgs(args: string[], cwd: string, options: { timeout?: number } = {}): Promise<string> {
  const { timeout } = options;
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(error.message);
    });

    child.on("close", code => {
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Execute a git command with arguments safely, returning Buffer (for binary files).
 * This is CRITICAL for security - avoids shell injection from filenames.
 * @param args Array of git arguments
 * @param cwd The working directory
 * @param options Optional settings: timeout (ms)
 * @returns The command output as a Buffer
 */
export function execGitWithArgsBuffer(
  args: string[],
  cwd: string,
  options: { timeout?: number } = {},
): Promise<Buffer> {
  const { timeout } = options;
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(error.message);
    });

    child.on("close", code => {
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * Decode a git path that may be quoted and contain octal escape sequences.
 * Git quotes paths with special characters and escapes unicode as octal (e.g., \303\261 for ñ).
 * @param gitPath The path from git output
 * @returns The decoded path
 */
export function decodeGitPath(gitPath: string): string {
  // Remove surrounding quotes if present
  if (gitPath.startsWith('"') && gitPath.endsWith('"')) {
    gitPath = gitPath.slice(1, -1);
  }

  // No backslash -> no octal escapes — should be most cases
  if (!gitPath.includes("\\")) {
    return gitPath;
  }

  // Decode octal escape sequences (e.g., \303\261 -> bytes -> UTF-8 string)
  // Git escapes non-ASCII bytes as \NNN octal sequences
  const bytes: number[] = [];
  let i = 0;
  while (i < gitPath.length) {
    if (gitPath[i] === "\\" && i + 3 < gitPath.length) {
      // Check if this is an octal escape (\NNN where N is 0-7)
      const octal = gitPath.substring(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 4;
        continue;
      }
    }
    // Regular character - convert to byte(s)
    const char = gitPath.charCodeAt(i);
    if (char < 128) {
      bytes.push(char);
    } else {
      // Multi-byte UTF-8 character that wasn't escaped (shouldn't happen, but handle it)
      const encoded = gitPathEncoder.encode(gitPath[i]);
      bytes.push(...encoded);
    }
    i++;
  }

  // Decode the bytes as UTF-8
  return gitPathDecoder.decode(new Uint8Array(bytes));
}

/** Run a git command purely to probe success: `true` if it exits 0, `false` if it throws. */
export async function gitProbeSucceeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await execGitWithArgs(args, cwd, { timeout: ConfigService.getGitTimeoutMs() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists on disk
 */
export function fileExists(filePath: string): Promise<boolean> {
  return new Promise(resolve => {
    fs.access(filePath, fs.constants.F_OK, err => {
      resolve(!err);
    });
  });
}

/**
 * Create git URIs using the same format as VS Code's git extension
 */
export function gitUri(uri: vscode.Uri, ref: string) {
  return uri.with({
    scheme: "git",
    query: JSON.stringify({ path: uri.fsPath, ref: ref }),
  });
}
