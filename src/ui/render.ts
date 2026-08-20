import chalk from "chalk";
import type { ModelStatus } from "../models/types.js";

/** Falls back to 64 cols when not a TTY (e.g. output piped) or columns unknown. */
export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 20 ? Math.min(process.stdout.columns, 100) : 64;
}

export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

const BOX = {
  tl: "╔", tr: "╗", bl: "╚", br: "╝",
  h: "═", v: "║",
  divL: "╠", divR: "╣",
};

/** Strips ANSI escape codes to measure the *visible* length of a chalk-colored string. */
function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function padLine(content: string, width: number): string {
  const inner = width - 4; // 2 chars border + 1 space padding each side
  const pad = Math.max(0, inner - visibleLength(content));
  return `${BOX.v} ${content}${" ".repeat(pad)} ${BOX.v}`;
}

export function boxTop(title: string, width: number): string {
  const label = ` ${title} `;
  const barLen = width - 2 - visibleLength(label);
  const left = Math.floor(barLen / 2);
  const right = barLen - left;
  return `${BOX.tl}${BOX.h.repeat(Math.max(0, left))}${label}${BOX.h.repeat(Math.max(0, right))}${BOX.tr}`;
}

export function boxDivider(width: number): string {
  return `${BOX.divL}${BOX.h.repeat(width - 2)}${BOX.divR}`;
}

export function boxBottom(width: number): string {
  return `${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`;
}

export function statusDot(status: ModelStatus): string {
  switch (status) {
    case "ready":
    case "connected":
      return chalk.green("●");
    case "auth_failed":
      return chalk.yellow("⚠");
    case "offline":
    case "not_configured":
    default:
      return chalk.dim("○");
  }
}

export function statusLabel(status: ModelStatus): string {
  switch (status) {
    case "ready": return "Ready";
    case "connected": return "Connected";
    case "auth_failed": return "Auth failed";
    case "offline": return "Offline";
    case "not_configured": return "Not configured";
    default: return status;
  }
}
