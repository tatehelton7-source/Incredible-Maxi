import { execSync } from "node:child_process";
import { scrubEnv } from "../tools/env.js";

/**
 * Enables ANSI/VT escape-sequence processing on Windows consoles.
 *
 * Legacy Windows conhost (the default console host for many terminals) does
 * NOT interpret ANSI escape codes (e.g. \x1b[2J, \x1b[<row>;<col>H) unless
 * the ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x0004) console mode flag is set.
 * Without it, escape sequences are written as literal bytes and ignored —
 * which is exactly why the model selector's clearScreen() "\x1b[2J\x1b[H"
 * appeared to do nothing and menus stacked on top of each other.
 *
 * This calls SetConsoleMode on the process's stdout handle via a small
 * PowerShell P/Invoke snippet. It is a no-op on non-Windows platforms and
 * fails silently (best-effort) if PowerShell is unavailable.
 */
export function enableVtProcessing(): void {
  if (process.platform !== "win32") return;
  if (!process.stdout.isTTY) return;

  try {
    execSync(
      'powershell -NoProfile -NonInteractive -Command "' +
        '$sig = \'[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int nStdHandle); ' +
        '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);\'; ' +
        '$type = Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native -PassThru; ' +
        '$h = [Native.Win32]::GetStdHandle(-11); ' +
        '[Native.Win32]::SetConsoleMode($h, 0x0007);' +
        '"',
      { stdio: "ignore", env: scrubEnv() }
    );
  } catch {
    // Non-fatal — VT processing is a best-effort enhancement.
  }
}
