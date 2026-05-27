import { randomBytes } from "crypto";

/**
 * Generate a cryptographically random nonce for Content Security Policy.
 * 16 bytes → 22-char base64 (no padding) — well over the 128-bit minimum
 * the CSP spec recommends.
 */
export function getNonce(): string {
  return randomBytes(16).toString("base64");
}
