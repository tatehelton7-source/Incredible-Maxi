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

/** Renders a single model row line (with or without the highlight marker). */
function renderModelLine(row: Extract<Row, { kind: "model" }>, isCursor: boolean, width: number): string {
  const marker = isCursor ? chalk.cyan("▸") : " ";
  const dot = statusDot(row.model.status);
  const text = modelLine(row.model);
  const providerTag = chalk.dim(row.model.provider.toUpperCase());
  const rendered = `${marker} ${dot} ${isCursor ? chalk.bold(text) : text}  ${providerTag}`;
  return padLine(rendered, width);
}

/** Builds the full menu as an array of lines (one per terminal row). */
function buildLines(rows: Row[], cursor: number, width: number, refreshing: boolean): string[] {
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
    lines.push(renderModelLine(row, i === cursor, width));
  }

  lines.push(boxDivider(width));
  const refreshTag = refreshing ? chalk.yellow(" (refreshing…)") : "";
  lines.push(padLine(chalk.dim(`↑↓ Select   ENTER Use   C Configure   R Refresh   Q Quit${refreshTag}`), width));
  lines.push(boxBottom(width));

  return lines;
}

/**
 * Full redraw: clears the screen and writes the entire menu. Used for the
 * initial draw and for refresh (R). Returns the built lines so the caller can
 * know the total row count for incremental updates.
 */
function render(rows: Row[], cursor: number, width: number, refreshing: boolean): string[] {
  const lines = buildLines(rows, cursor, width, refreshing);
  clearScreen();
  process.stdout.write(lines.join("\n") + "\n");
  return lines;
}

/**
 * Incremental update of a single model row. Positions the cursor to the row's
 * terminal line and rewrites just that line (plus clear-to-end-of-line so a
 * shorter line never leaves trailing characters). This is what makes the
 * highlight "slide" without repainting the whole menu.
 *
 * Row `i` occupies lines[1 + i]; line 0 (boxTop) is terminal row 1, so the
 * terminal row for row `i` is `i + 2`.
 */
function updateModelLine(row: Extract<Row, { kind: "model" }>, isCursor: boolean, width: number, rowIndex: number): void {
  const terminalRow = rowIndex + 2;
  process.stdout.write(`\x1b[${terminalRow};1H${renderModelLine(row, isCursor, width)}\x1b[K`);
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
      const lines = render(rows, cursor, width, refreshing);
      const totalLines = lines.length;

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
          const prev = cursor;
          cursor = nextModelIndex(rows, cursor, -1);
          updateModelLine(rows[prev] as Extract<Row, { kind: "model" }>, false, width, prev);
          updateModelLine(rows[cursor] as Extract<Row, { kind: "model" }>, true, width, cursor);
          process.stdout.write(`\x1b[${totalLines};1H`);
          return;
        }
        if (key.name === "down" && cursor !== -1) {
          const prev = cursor;
          cursor = nextModelIndex(rows, cursor, 1);
          updateModelLine(rows[prev] as Extract<Row, { kind: "model" }>, false, width, prev);
          updateModelLine(rows[cursor] as Extract<Row, { kind: "model" }>, true, width, cursor);
          process.stdout.write(`\x1b[${totalLines};1H`);
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
