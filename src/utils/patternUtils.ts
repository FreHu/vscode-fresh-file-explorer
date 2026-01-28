/**
 * Optimizes a list of file paths using brace expansion to reduce string length
 * while maintaining exact file matching (no wildcards that would match unwanted files).
 * 
 * Important: Avoids nested braces which ripgrep doesn't support.
 * 
 * Example: ['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts'] 
 *       -> 'src/a/{x.ts,y.ts},src/b/z.ts' (comma-separated, braces only at deepest level)
 */
export function optimizeIncludePatterns(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }

  if (paths.length === 1) {
    return paths[0];
  }

  // Group files by directory
  const dirMap = new Map<string, string[]>();

  for (const path of paths) {
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : path.substring(0, lastSlash);
    const filename = lastSlash === -1 ? path : path.substring(lastSlash + 1);

    if (!dirMap.has(dir)) {
      dirMap.set(dir, []);
    }
    dirMap.get(dir)!.push(filename);
  }

  // Build patterns - use braces only for files in the same directory
  // Join different patterns with commas (no outer braces to avoid nesting)
  const result: string[] = [];

  for (const [dir, files] of dirMap.entries()) {
    if (files.length === 1) {
      // Single file, no brace needed
      result.push(dir ? `${dir}/${files[0]}` : files[0]);
    } else {
      // Multiple files in same directory: use brace expansion
      // dir/{file1,file2,file3} instead of dir/file1,dir/file2,dir/file3
      result.push(dir ? `${dir}/{${files.join(",")}}` : `{${files.join(",")}}`);
    }
  }

  // Join with commas - no outer braces to avoid nested braces
  return result.join(",");
}
