/**
 * Environment scrubbing helper.
 *
 * Returns a copy of the process environment with sensitive credential keys
 * removed, so they are never leaked to child processes. Non-sensitive keys
 * (PATH, HOME, etc.) are preserved.
 */

const SENSITIVE_KEY_RE = /(_API_KEY|API_TOKEN|_TOKEN|_SECRET)$/i;

/**
 * Return a shallow copy of `env` with keys matching /(_API_KEY|API_TOKEN|_TOKEN|_SECRET)$/i
 * removed. Pure function — never mutates the input.
 */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
