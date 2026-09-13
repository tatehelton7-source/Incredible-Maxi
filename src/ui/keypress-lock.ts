import * as readline from "node:readline";

/**
 * Node's readline.Interface attaches its own 'keypress' listener to stdin
 * (for line editing, history, backspace, etc.) whenever stdin is a TTY. If
 * we simply add a second 'keypress' listener on top of that — which is what
 * a naive TUI implementation would do — both handlers fire on every
 * keystroke: arrow keys would simultaneously move our selection cursor AND
 * page through the Interface's input history, and typed characters would
 * leak into the Interface's line buffer.
 *
 * This runs `fn` with EXCLUSIVE keypress access: it detaches every existing
 * 'keypress' listener from stdin, ensures raw mode + keypress emission are
 * on, runs `fn`, then restores the previous listeners and raw-mode state
 * exactly as they were — regardless of whether `fn` throws.
 *
 * Safe to call with zero pre-existing listeners (the index.ts startup path,
 * before any Repl/readline.Interface exists) — restoration is then a no-op.
 */
export async function withExclusiveKeypress<T>(fn: () => Promise<T>): Promise<T> {
  const input = process.stdin;

  if (!input.isTTY) {
    // No TTY to take over — callers must check this themselves and skip the
    // TUI entirely (see selector.ts's non-interactive guard), but fail safe
    // here too rather than hanging on setRawMode.
    return fn();
  }

  readline.emitKeypressEvents(input); // idempotent — safe if already called

  const previousListeners = input.listeners("keypress") as ((str: string, key: readline.Key) => void)[];
  for (const listener of previousListeners) {
    input.removeListener("keypress", listener);
  }

  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();

  try {
    return await fn();
  } finally {
    input.setRawMode(wasRaw);
    if (wasPaused) {
      input.pause();
    } else {
      input.resume();
    }
    for (const listener of previousListeners) {
      input.on("keypress", listener);
    }
  }
}
