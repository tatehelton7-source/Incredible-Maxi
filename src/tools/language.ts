import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "./types.js";
import { scrubEnv } from "./env.js";
import { getSandboxRunner, getCurrentStepIntent, defaultStepIntent } from "./sandbox-runners.js";

const execAsync = promisify(exec);

interface DetectionResult {
  language: string;
  confidence: "high" | "medium" | "low";
  files: string[];
}

const MARKERS: Record<string, string[]> = {
  TypeScript: ["tsconfig.json"],
  JavaScript: ["package.json"],
  Rust: ["Cargo.toml"],
  Go: ["go.mod"],
  Python: ["pyproject.toml", "requirements.txt", "setup.py"],
  "C/C++": ["CMakeLists.txt", "Makefile"],
  Java: ["pom.xml", "build.gradle"],
  "C#": [".csproj", ".sln"],
  Ruby: ["Gemfile"],
  Elixir: ["mix.exs"],
  Docker: ["Dockerfile"],
};

export async function detectLanguage(cwd: string): Promise<DetectionResult> {
  const found: Record<string, string[]> = {};

  for (const [lang, markers] of Object.entries(MARKERS)) {
    for (const marker of markers) {
      const fullPath = join(cwd, marker);
      if (existsSync(fullPath)) {
        if (!found[lang]) found[lang] = [];
        found[lang].push(marker);
      }
    }
  }

  const entries = Object.entries(found);
  if (entries.length === 0) {
    return { language: "Unknown", confidence: "low", files: [] };
  }

  entries.sort((a, b) => b[1].length - a[1].length);
  const [language, files] = entries[0];

  let confidence: DetectionResult["confidence"] = "medium";
  if (language === "TypeScript" || language === "Rust" || language === "Go") {
    confidence = "high";
  } else if (files.length > 1) {
    confidence = "high";
  }

  return { language, confidence, files };
}

interface ToolchainCommands {
  build?: string;
  test?: string;
  lint?: string;
  run?: string;
}

export function getToolchainCommands(language: string): ToolchainCommands {
  const commands: Record<string, ToolchainCommands> = {
    TypeScript: { build: "npm run build", test: "npm test", lint: "npm run lint", run: "npm start" },
    JavaScript: { build: "npm run build", test: "npm test", lint: "npm run lint", run: "npm start" },
    Rust: { build: "cargo build", test: "cargo test", lint: "cargo clippy", run: "cargo run" },
    Go: { build: "go build ./...", test: "go test ./...", lint: "golangci-lint run", run: "go run ." },
    Python: { build: "pip install -e .", test: "pytest", lint: "ruff check .", run: "python main.py" },
    "C/C++": { build: "cmake --build build", test: "ctest", lint: "cppcheck", run: "./build/app" },
    Java: { build: "mvn compile", test: "mvn test", lint: "mvn checkstyle:check", run: "mvn exec:java" },
    "C#": { build: "dotnet build", test: "dotnet test", lint: "dotnet format --verify-no-changes", run: "dotnet run" },
    Ruby: { build: "bundle install", test: "bundle exec rspec", lint: "rubocop", run: "ruby main.rb" },
    Elixir: { build: "mix compile", test: "mix test", lint: "mix credo", run: "mix run" },
  };

  return commands[language] || {};
}

export async function runToolchain(
  command: string,
  cwd: string,
  timeout?: number
): Promise<ToolResult> {
  const effectiveTimeout = Math.min(timeout || 60000, 120000);
  const runner = getSandboxRunner();
  const env = scrubEnv();

  try {
    let stdout: string;
    let stderr: string;

    if (runner) {
      const step = getCurrentStepIntent() ?? defaultStepIntent();
      const result = await runner.exec(command, {
        root: cwd,
        step: { ...step, resourceLimits: { ...step.resourceLimits, timeoutMs: effectiveTimeout } },
      });
      if (result.sandboxDenial) {
        return {
          success: false,
          output: "",
          error: `Sandbox denial (${result.sandboxDenial.layer}): ${result.sandboxDenial.detail}`,
        };
      }
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      const raw = await execAsync(command, {
        cwd,
        timeout: effectiveTimeout,
        maxBuffer: 1024 * 1024 * 10,
        env,
      });
      stdout = raw.stdout;
      stderr = raw.stderr;
    }

    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { success: true, output: output || "(no output)" };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (error.killed) {
      return { success: false, output: "", error: `Toolchain command timed out after ${effectiveTimeout}ms` };
    }
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    return { success: false, output, error: `Toolchain command failed: ${error.message}` };
  }
}
