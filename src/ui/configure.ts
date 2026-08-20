import chalk from "chalk";
import type { MaxiConfig } from "../providers/types.js";
import { saveConfigValue, isConfigGitignored } from "../config.js";
import { openaiSource } from "../models/cloud/openai.js";
import { anthropicSource } from "../models/cloud/anthropic.js";
import { nvidiaSource } from "../models/cloud/nvidia.js";
import type { ModelDiscoveryProvider } from "../models/types.js";
import { withExclusiveKeypress } from "./keypress-lock.js";
import { clearScreen, boxTop, boxDivider, boxBottom, padLine, terminalWidth } from "./render.js";

export type ConfigureResult =
  | { action: "saved"; provider: string }
  | { action: "session_only"; provider: string }
  | { action: "cancelled" };

interface ConfigurableProvider {
  id: string;
  label: string;
  source: ModelDiscoveryProvider;
  configKey: "openaiApiKey" | "anthropicApiKey" | "nvidiaApiKey";
}

const CONFIGURABLE: ConfigurableProvider[] = [
  { id: "openai", label: "OpenAI", source: openaiSource, configKey: "openaiApiKey" },
  { id: "anthropic", label: "Anthropic", source: anthropicSource, configKey: "anthropicApiKey" },
  { id: "nvidia", label: "NVIDIA", source: nvidiaSource, configKey: "nvidiaApiKey" },
];

type Key = { name?: string; ctrl?: boolean } | undefined;

async function selectProvider(): Promise<ConfigurableProvider | null> {
  let cursor = 0;
  const width = terminalWidth();

  const draw = () => {
    clearScreen();
    const lines = [boxTop("CONNECT PROVIDER", width)];
    CONFIGURABLE.forEach((p, i) => {
      const marker = i === cursor ? chalk.cyan("▸") : " ";
      lines.push(padLine(`${marker} ${i === cursor ? chalk.bold(p.label) : p.label}`, width));
    });
    lines.push(boxDivider(width));
    lines.push(padLine(chalk.dim("↑↓ Select   ENTER Choose   ESC Back"), width));
    lines.push(boxBottom(width));
    process.stdout.write(lines.join("\n") + "\n");
  };

  return withExclusiveKeypress<ConfigurableProvider | null>(
    () =>
      new Promise((resolve) => {
        draw();
        const cleanup = () => process.stdin.removeListener("keypress", onKeypress);
        const onKeypress = (_str: string, key: Key) => {
          if (!key) return;
          if (key.name === "up") {
            cursor = (cursor - 1 + CONFIGURABLE.length) % CONFIGURABLE.length;
            draw();
          } else if (key.name === "down") {
            cursor = (cursor + 1) % CONFIGURABLE.length;
            draw();
          } else if (key.name === "return") {
            cleanup();
            resolve(CONFIGURABLE[cursor]);
          } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
            cleanup();
            resolve(null);
          }
        };
        process.stdin.on("keypress", onKeypress);
      })
  );
}

/** readline doesn't mask input by default — manually echo '*' per keystroke instead. */
async function promptMaskedInput(label: string): Promise<string | null> {
  process.stdout.write(chalk.cyan(`  ${label}`));
  return withExclusiveKeypress<string | null>(
    () =>
      new Promise((resolve) => {
        let buffer = "";
        const cleanup = () => process.stdin.removeListener("keypress", onKeypress);
        const onKeypress = (str: string, key: Key) => {
          if (key?.ctrl && key.name === "c") {
            cleanup();
            process.stdout.write("\n");
            resolve(null);
            return;
          }
          if (key?.name === "return") {
            cleanup();
            process.stdout.write("\n");
            resolve(buffer.length ? buffer : null);
            return;
          }
          if (key?.name === "escape") {
            cleanup();
            process.stdout.write("\n");
            resolve(null);
            return;
          }
          if (key?.name === "backspace") {
            if (buffer.length) {
              buffer = buffer.slice(0, -1);
              process.stdout.write("\b \b");
            }
            return;
          }
          if (str && !key?.ctrl) {
            buffer += str;
            process.stdout.write("*");
          }
        };
        process.stdin.on("keypress", onKeypress);
      })
  );
}

async function promptYesNo(label: string, defaultYes = true): Promise<boolean> {
  process.stdout.write(chalk.cyan(`  ${label}`));
  return withExclusiveKeypress<boolean>(
    () =>
      new Promise((resolve) => {
        const cleanup = () => process.stdin.removeListener("keypress", onKeypress);
        const onKeypress = (str: string, key: Key) => {
          if (key?.name === "return") {
            cleanup();
            process.stdout.write("\n");
            resolve(defaultYes);
            return;
          }
          const lower = str?.toLowerCase();
          if (lower === "y") {
            cleanup();
            process.stdout.write("\n");
            resolve(true);
          } else if (lower === "n") {
            cleanup();
            process.stdout.write("\n");
            resolve(false);
          }
        };
        process.stdin.on("keypress", onKeypress);
      })
  );
}

async function pause(label = "  Press any key to continue…"): Promise<void> {
  process.stdout.write(chalk.dim(label));
  return withExclusiveKeypress<void>(
    () =>
      new Promise((resolve) => {
        const cleanup = () => process.stdin.removeListener("keypress", onKeypress);
        const onKeypress = () => {
          cleanup();
          process.stdout.write("\n");
          resolve();
        };
        process.stdin.on("keypress", onKeypress);
      })
  );
}

/**
 * Runs the "C Configure" flow: pick a cloud provider, enter its API key,
 * validate live against that provider's own discovery source (so "connected"
 * here means the same thing "connected" means in the selector, not just
 * "a key was typed"), then ask explicitly before writing anything to disk.
 */
export async function runConfigureUI(config: MaxiConfig): Promise<ConfigureResult> {
  if (!process.stdin.isTTY) return { action: "cancelled" };

  const choice = await selectProvider();
  if (!choice) return { action: "cancelled" };

  const apiKey = await promptMaskedInput(`${choice.label} API key: `);
  if (!apiKey) return { action: "cancelled" };

  console.log(chalk.dim("\n  Validating…"));
  const testConfig: MaxiConfig = { ...config, [choice.configKey]: apiKey };
  const status = await choice.source.probeStatus(testConfig);

  if (status !== "connected") {
    console.log(chalk.red(`  Connection failed (${status}). Key not saved.`));
    await pause();
    return { action: "cancelled" };
  }

  console.log(chalk.green("  ✓ Connection successful\n"));

  if (!isConfigGitignored()) {
    console.log(
      chalk.yellow(
        "  Note: maxi.config.json doesn't appear to be gitignored. Saving here writes your key in plaintext to that file."
      )
    );
  }

  const save = await promptYesNo("Save to maxi.config.json? [Y/n] ");
  if (save) {
    saveConfigValue(choice.configKey, apiKey);
    config[choice.configKey] = apiKey; // apply immediately, don't require a restart
    console.log(chalk.green(`  Saved. ${choice.label} is now configured.`));
    await pause();
    return { action: "saved", provider: choice.id };
  }

  config[choice.configKey] = apiKey; // active for this process only
  console.log(chalk.dim("  Not saved to disk — active for this session only."));
  await pause();
  return { action: "session_only", provider: choice.id };
}
