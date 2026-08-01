# Maxi

A lightweight, multi-language AI coding CLI. Standalone — runs outside OpenCode.

## Quick Start

```bash
npm install
npm run dev    # run directly with tsx
npm run build  # compile to dist/
npm start      # run compiled
```

## Usage

### Interactive Mode

```bash
maxi
```

Opens an interactive REPL with codebase context. Commands:
- `/help` — show available commands
- `/clear` — clear conversation history
- `/files` — show indexed file tree
- `/agent <name> <prompt>` — run a specific agent
- `/exit` — quit

### One-Shot Mode

```bash
maxi "Explain the architecture of this project"
maxi --provider anthropic --model claude-sonnet-4-5 "Write a function to parse JSON"
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --provider <name>` | LLM provider (openai, anthropic, omniroute) | openai |
| `-m, --model <name>` | Model ID | gpt-4o |
| `-h, --help` | Show help | |
| `-V, --version` | Show version | |

## Configuration

### Environment Variables

```bash
OPENAI_API_KEY        # OpenAI API key
ANTHROPIC_API_KEY     # Anthropic API key
OMNIROUTER_BASE_URL   # OmniRoute gateway URL (optional)
OMNIROUTER_API_KEY    # OmniRoute API key (optional)
MAXI_PROVIDER         # Default provider (optional)
MAXI_MODEL             # Default model (optional)
```

### Config File

Create `maxi.config.json` in your project root:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o",
  "openaiApiKey": "sk-...",
  "agents": ["./agents"],
  "skills": ["./skills"],
  "plugins": [
    { "type": "ts", "path": "./plugins/my-plugin.js" },
    { "type": "wasm", "path": "./plugins/wasm-plugin.json" },
    { "type": "subprocess", "path": "./plugins/python-plugin.json" }
  ],
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["@upstash/context7-mcp"]
    }
  },
  "systemPrompt": "You are Maxi, a helpful AI coding assistant."
}
```

## Architecture

```
Maxi CLI (TypeScript / Node.js)
├── Core Runtime
│   ├── REPL Engine (interactive chat + one-shot mode)
│   ├── Provider Layer (Vercel AI SDK → direct providers OR OmniRoute endpoint)
│   ├── Tool Registry (file ops, bash, search, git, language toolchains)
│   └── Context Engine (codebase indexing, token-aware context window)
├── Agent System
│   ├── Agent Orchestrator (parallel agents, task routing, delegation)
│   ├── Skill Framework (define/load/run skills from markdown config)
│   └── Agent Definitions (markdown with YAML frontmatter)
├── Plugin System
│   ├── TS Plugin Loader (dynamic import)
│   ├── WASM Plugin Runtime (plugins compiled from Rust/C++/Go/Zig)
│   └── Subprocess Plugin Bridge (plugins in Python/C++/any language via stdio)
├── MCP Integration
│   ├── MCP Client (connect to external MCP servers as tools)
│   └── MCP Server (expose Maxi's tools via MCP)
└── Multi-Language Support
    ├── Language Detector (identify project language from marker files)
    ├── Toolchain Runner (cmake, pip, cargo, go, npm, etc.)
    └── Native Bridge (FFI / WASM / child_process)
```

### Agent Configuration

Agents are defined as markdown files with YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews code for quality and security
model: gpt-4o
tools:
  - readFile
  - grep
  - gitDiff
maxIterations: 5
---

You are a code reviewer. Analyze code for:
- Security vulnerabilities
- Performance issues
- Code style violations
- Best practices
```

### Skill Configuration

Skills are markdown files with YAML frontmatter:

```markdown
---
name: security-scan
description: Run security scanning tools
tools:
  - bash
  - grep
enabled: true
---

Run security scanning tools (Semgrep, gitleaks, npm audit) and
summarize findings with severity levels and remediation suggestions.
```

### Plugin Development

#### TypeScript Plugin

```typescript
import type { MaxiPlugin } from "maxi";

const myPlugin: MaxiPlugin = {
  name: "my-plugin",
  version: "1.0.0",
  description: "A custom Maxi plugin",
  tools: [
    {
      name: "myTool",
      description: "Does something useful",
      execute: async (args) => {
        return { success: true, output: "Done!" };
      },
    },
  ],
};

export default myPlugin;
```

#### Subprocess Plugin (Python)

Create a JSON config file:

```json
{
  "name": "python-scanner",
  "version": "1.0.0",
  "description": "Python-based security scanner",
  "command": "python",
  "args": ["scanner.py"],
  "tools": [
    { "name": "scan", "description": "Scan for vulnerabilities" }
  ]
}
```

The Python script communicates via stdio using JSON-RPC 2.0.

## Provider Configuration

Maxi supports multiple LLM providers through the Vercel AI SDK:

- **OpenAI** (direct): `--provider openai --model gpt-4o`
- **Anthropic** (direct): `--provider anthropic --model claude-sonnet-4-5`
- **OmniRoute** (gateway): `--provider omniroute --model gpt-4o` (requires `OMNIROUTER_BASE_URL`)

Switch between providers at any time via CLI flags or config file.

## License

MIT
