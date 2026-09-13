import chalk from "chalk";

type ChalkFn = (...args: unknown[]) => string;

export interface Theme {
  name: string;
  prompt: ChalkFn;
  success: ChalkFn;
  warning: ChalkFn;
  error: ChalkFn;
  info: ChalkFn;
  dim: ChalkFn;
  heading: ChalkFn;
  accent: ChalkFn;
}

const themes: Record<string, Theme> = {
  default: {
    name: "default",
    prompt: chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    info: chalk.dim,
    dim: chalk.dim,
    heading: chalk.cyan.bold,
    accent: chalk.magenta,
  },
  dark: {
    name: "dark",
    prompt: chalk.hex("#7C3AED"),
    success: chalk.hex("#10B981"),
    warning: chalk.hex("#F59E0B"),
    error: chalk.hex("#EF4444"),
    info: chalk.hex("#9CA3AF"),
    dim: chalk.hex("#6B7280"),
    heading: chalk.hex("#7C3AED").bold,
    accent: chalk.hex("#EC4899"),
  },
  light: {
    name: "light",
    prompt: chalk.hex("#2563EB"),
    success: chalk.hex("#059669"),
    warning: chalk.hex("#D97706"),
    error: chalk.hex("#DC2626"),
    info: chalk.hex("#6B7280"),
    dim: chalk.hex("#9CA3AF"),
    heading: chalk.hex("#2563EB").bold,
    accent: chalk.hex("#7C3AED"),
  },
  mono: {
    name: "mono",
    prompt: chalk.white,
    success: chalk.white,
    warning: chalk.white,
    error: chalk.white,
    info: chalk.dim,
    dim: chalk.dim,
    heading: chalk.white.bold,
    accent: chalk.white,
  },
  dracula: {
    name: "dracula",
    prompt: chalk.hex("#BD93F9"),
    success: chalk.hex("#50FA7B"),
    warning: chalk.hex("#F1FA8C"),
    error: chalk.hex("#FF5555"),
    info: chalk.hex("#6272A4"),
    dim: chalk.hex("#44475A"),
    heading: chalk.hex("#BD93F9").bold,
    accent: chalk.hex("#FF79C6"),
  },
  nord: {
    name: "nord",
    prompt: chalk.hex("#88C0D0"),
    success: chalk.hex("#A3BE8C"),
    warning: chalk.hex("#EBCB8B"),
    error: chalk.hex("#BF616A"),
    info: chalk.hex("#4C566A"),
    dim: chalk.hex("#7B88A1"),
    heading: chalk.hex("#88C0D0").bold,
    accent: chalk.hex("#B48EAD"),
  },
};

export function getTheme(name: string): Theme {
  return themes[name] ?? themes.default;
}

export function listThemes(): Array<{ name: string; preview: string }> {
  return Object.values(themes).map((t) => ({
    name: t.name,
    preview: `${t.prompt("prompt")} ${t.success("ok")} ${t.warning("warn")} ${t.error("err")} ${t.accent("accent")}`,
  }));
}

export function isValidTheme(name: string): boolean {
  return name in themes;
}
