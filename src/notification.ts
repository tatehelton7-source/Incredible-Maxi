import chalk from "chalk";

export interface NotificationOptions {
  enabled?: boolean;
}

export class NotificationSystem {
  private enabled: boolean;

  constructor(options: NotificationOptions = {}) {
    this.enabled = options.enabled ?? true;
    
    // Check for NO_COLOR
    if (process.env.NO_COLOR) {
      this.enabled = false;
    }
  }

  /**
   * Notify that a subagent has started
   */
  started(subagentName: string): void {
    if (!this.enabled) return;
    console.log(chalk.cyan(`  ▶ Subagent "${subagentName}" started`));
  }

  /**
   * Notify that a subagent has completed
   */
  completed(subagentName: string, durationMs: number): void {
    if (!this.enabled) return;
    const durationSec = (durationMs / 1000).toFixed(1);
    console.log(chalk.green(`  ✓ Subagent "${subagentName}" completed in ${durationSec}s`));
  }

  /**
   * Notify that the model has been switched
   */
  modelSwitched(provider: string, model: string): void {
    if (!this.enabled) return;
    console.log(chalk.yellow(`  ⟳ Model switched to ${provider}/${model}`));
  }

  /**
   * Notify that a model issue has been detected
   */
  modelIssue(errorMessage: string): void {
    if (!this.enabled) return;
    console.log(chalk.red(`  ⚠ Model issue: ${errorMessage}`));
  }

  /**
   * Notify a general info message
   */
  info(message: string): void {
    if (!this.enabled) return;
    console.log(chalk.blue(`  ℹ ${message}`));
  }

  /**
   * Notify a warning message
   */
  warn(message: string): void {
    if (!this.enabled) return;
    console.log(chalk.yellow(`  ⚠ ${message}`));
  }

  /**
   * Notify an error message
   */
  error(message: string): void {
    if (!this.enabled) return;
    console.log(chalk.red(`  ✗ ${message}`));
  }

  /**
   * Enable or disable notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

export function createNotificationSystem(options?: NotificationOptions): NotificationSystem {
  return new NotificationSystem(options);
}