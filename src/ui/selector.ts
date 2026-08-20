import chalk from "chalk";
import type { RegistrySnapshot } from "../models/registry.js";
import type { ModelInfo } from "../models/types.js";
import { withExclusiveKeypress } from "./keypress-lock.js";
import {
  terminalWidth,
  clearScreen,
  boxTop,
  boxDivider,
  boxBottom,
  padLine,
  statusDot,
  statusLabel,
} from "./render.js";

export type SelectorResult =
  | { action: "select"; provider: string; model: string }
  | { action: "configure" }
  | { action: "quit" }
  /** stdin isn't a TTY (piped input, CI, etc.) — caller must fall back to config defaults, never wait on this. */
  | { action: "non_interactive" };

type Row =
  | { kind: "header"; label: string }
  | { kind: "info"; label: string }
  | { kind: "model"; model: ModelInfo }
  | { kind: "blank" };

function modelLine(m: ModelInfo): string {
  const meta: string[] = [];
  if (m.parameterSize) meta.push(m.parameterSize);
  if (m.quantization) meta.push(m.quantization);
  const metaStr = meta.length ? chalk.dim(` (${meta.join(" · ")})`) : "";
  return `${m.displayName}${metaStr}`;
}

function buildRows(snapshot: RegistrySnapshot): Row[] {
  const rows: Row[] = [];

  const byProvider = (models: ModelInfo[]) => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return map;
  };

  const localByProvider = byProvider(snapshot.local);
  const apiByProvider = byProvider(snapshot.api);
  const KNOWN_LOCAL = ["ollama", "lmstudio", "vllm", "llamacpp"];

  const localSourceIds = Object.keys(snapshot.sourceLabels).filter(
    (id) => localByProvider.has(id) || KNOWN_LOCAL.includes(id)
  );
  const apiSourceIds = Object.keys(snapshot.sourceLabels).filter((id) => !localSourceIds.includes(id));

  if (localSourceIds.length) {
    rows.push({ kind: "header", label: "LOCAL MODELS" });
    for (const id of localSourceIds) {
      const models = localByProvider.get(id) ?? [];
      if (models.length === 0) {
        const status = snapshot.sourceStatus[id];
        rows.push({
          kind: "info",
          label: `${statusDot(status)} ${snapshot.sourceLabels[id]} ${chalk.dim(`— ${statusLabel(status)}`)}`,
        });
      } else {
        for (const m of models) rows.push({ kind: "model", model: m });
      }
    }
    rows.push({ kind: "blank" });
  }

  if (apiSourceIds.length) {
    rows.push({ kind: "header", label: "API MODELS" });
    for (const id of apiSourceIds) {
      const models = apiByProvider.get(id) ?? [];
      const status = snapshot.sourceStatus[id];
      if (models.length === 0) {
        rows.push({
          kind: "info",
          label: `${statusDot(status)} ${snapshot.sourceLabels[id]} ${chalk.dim(`— ${statusLabel(status)}`)}`,
        });
      } else {
        rows.push({
          kind: "info",
          label: `${chalk.bold(snapshot.sourceLabels[id])} ${chalk.dim(`— ${statusLabel(status)}`)}`,
        });
        for (const m of models) rows.push({ kind: "model", model: m });
      }
    }
  }

  return rows;
}

function firstModelIndex(rows: Row[]): number {
  return rows.findIndex((r) => r.kind === "model");
}

function nextModelIndex(rows: Row[], current: number, dir: 1 | -1): number {
  let i = current;
  for (let step = 0; step < rows.length; step++) {
    i = (i + dir + rows.length) % rows.length;
    if (rows[i].kind === "model") return i;
  }
  return current;
}

function render(rows: Row[], cursor: number, width: number, refreshing: boolean): void {
  clearScreen();
  const lines: string[] = [];
  lines.push(boxTop("MAXI // MODEL SELECT", width));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === "blank") {
      lines.push(padLine("", width));
      continue;
    }
    if (row.kind === "header") {
      lines.push(padLine(chalk.bold.cyan(row.label), width));
      continue;
    }
    if (row.kind === "info") {
      lines.push(padLine(`  ${row.label}`, width));
      continue;
    }
    const isCursor = i === cursor;
    const marker = isCursor ? chalk.cyan("▸") : " ";
    const dot = statusDot(row.model.status);
    const text = modelLine(row.model);
    const providerTag = chalk.dim(row.model.provider.toUpperCase());
    const rendered = `${marker} ${dot} ${isCursor ? chalk.bold(text) : text}  ${providerTag}`;
    lines.push(padLine(rendered, width));
  }

  lines.push(boxDivider(width));
  const refreshTag = refreshing ? chalk.yellow(" (refreshing…)") : "";
  lines.push(padLine(chalk.dim(`↑↓ Select   ENTER Use   C Configure   R Refresh   Q Quit${refreshTag}`), width));
  lines.push(boxBottom(width));

  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Runs the interactive model selector. Safe to call both at startup (before
 * any readline.Interface exists) and mid-session from repl.ts's /models
 * command — withExclusiveKeypress() detaches/restores any existing
 * readline.Interface's own keypress listener so the two never collide.
 */
export async function runSelectorUI(
  snapshot: RegistrySnapshot,
  onRefresh: () => Promise<RegistrySnapshot>
): Promise<SelectorResult> {
  if (!process.stdin.isTTY) {
    return { action: "non_interactive" };
  }

  let rows = buildRows(snapshot);
  let cursor = firstModelIndex(rows);
  const width = terminalWidth();

  return withExclusiveKeypress<SelectorResult>(() => {
    return new Promise((resolve) => {
      let refreshing = false;
      render(rows, cursor, width, refreshing);

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKeypress);
      };

      const onKeypress = async (_str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          cleanup();
          resolve({ action: "quit" });
          return;
        }
        if (key.name === "q") {
          cleanup();
          resolve({ action: "quit" });
          return;
        }
        if (key.name === "up" && cursor !== -1) {
          cursor = nextModelIndex(rows, cursor, -1);
          render(rows, cursor, width, refreshing);
          return;
        }
        if (key.name === "down" && cursor !== -1) {
          cursor = nextModelIndex(rows, cursor, 1);
          render(rows, cursor, width, refreshing);
          return;
        }
        if (key.name === "return" && cursor !== -1) {
          const row = rows[cursor];
          if (row.kind === "model") {
            cleanup();
            resolve({ action: "select", provider: row.model.provider, model: row.model.id });
            return;
          }
        }
        if (key.name === "c") {
          cleanup();
          resolve({ action: "configure" });
          return;
        }
        if (key.name === "r" && !refreshing) {
          refreshing = true;
          render(rows, cursor, width, refreshing);
          try {
            const fresh = await onRefresh();
            rows = buildRows(fresh);
            if (cursor === -1 || rows[cursor]?.kind !== "model") {
              cursor = firstModelIndex(rows);
            }
          } finally {
            refreshing = false;
            render(rows, cursor, width, refreshing);
          }
        }
      };

      process.stdin.on("keypress", onKeypress);
    });
  });
}
