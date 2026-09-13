import ora from "ora";
import chalk from "chalk";

// Valid ora built-in themes
type OraTheme = "dots" | "line" | "bounce" | "clock" | "earth" | "moon" | "simple" | "arrow" | "hamburger" | "growVertical" | "growHorizontal" | "noise" | "bouncingBar" | "bouncingBall" | "smiley" | "monkey" | "hearts" | "clock" | "earth" | "moon" | "runner" | "aesthetic" | "christmas" | "grenade" | "point" | "layer" | "betaWave" | "fingerDance" | "fistBump" | "soccerHeader" | "mindblown" | "orangePulse" | "bluePulse" | "orangeRedPulse" | "timeTravel" | "aesthetic" | "christmas" | "grenade" | "point" | "layer" | "betaWave" | "fingerDance" | "fistBump" | "soccerHeader" | "mindblown" | "orangePulse" | "bluePulse" | "orangeRedPulse" | "timeTravel";

// Custom themes for thinking animations
const customSpinners: Record<string, { frames: string[]; interval: number }> = {
  pulse: {
    frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
    interval: 80,
  },
  rotate: {
    frames: ["|", "/", "-", "\\"],
    interval: 80,
  },
  wave: {
    frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
    interval: 60,
  },
};

export type SpinnerTheme = OraTheme | "pulse" | "rotate" | "wave";

export interface SpinnerOptions {
  text?: string;
  theme?: SpinnerTheme;
}

export class Spinner {
  private spinner: ReturnType<typeof ora>;
  private enabled: boolean;
  private theme: SpinnerTheme;

  constructor(options: { enabled?: boolean; theme?: SpinnerTheme } = {}) {
    this.enabled = options.enabled ?? true;
    this.theme = options.theme ?? "dots";
    
    // Check for NO_COLOR or non-TTY
    if (process.env.NO_COLOR || !process.stdout.isTTY) {
      this.enabled = false;
    }
    
    const spinnerConfig = this.getSpinnerConfig(this.theme);
    this.spinner = ora({
      text: "",
      spinner: spinnerConfig as any,
      color: "cyan",
      discardStdin: false,
    });
  }

  private getSpinnerConfig(theme: SpinnerTheme): any {
    // Check if it's a custom theme
    if (customSpinners[theme]) {
      return customSpinners[theme];
    }
    // Return built-in theme name
    return theme as string;
  }

  start(text?: string): void {
    if (!this.enabled) return;
    if (text) this.spinner.text = text;
    this.spinner.start();
  }

  stop(): void {
    if (!this.enabled) return;
    this.spinner.stop();
  }

  succeed(text?: string): void {
    if (!this.enabled) return;
    if (text) this.spinner.succeed(text);
    else this.spinner.succeed();
  }

  fail(text?: string): void {
    if (!this.enabled) return;
    if (text) this.spinner.fail(text);
    else this.spinner.fail();
  }

  update(text: string): void {
    if (!this.enabled) return;
    this.spinner.text = text;
  }

  setTheme(theme: SpinnerTheme): void {
    this.theme = theme;
    const spinnerConfig = this.getSpinnerConfig(theme);
    this.spinner.spinner = spinnerConfig as any;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export function createSpinner(options?: { enabled?: boolean; theme?: SpinnerTheme }): Spinner {
  return new Spinner(options);
}