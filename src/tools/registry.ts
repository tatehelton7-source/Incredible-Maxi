import type { MaxiConfig } from "../providers/types.js";
import type { Tool } from "./types.js";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  globTool,
  grepTool,
} from "./files.js";
import { bashTool } from "./bash.js";
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitBranchTool,
  gitCheckoutTool,
} from "../git.js";
import { fetchAndExtract } from "./web.js";
import { webSearch } from "./webSearchProviders.js";
import { detectLanguage, runToolchain } from "./language.js";

export function buildToolRegistry(config: MaxiConfig): Tool[] {
  const tools: Tool[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    bashTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitAddTool,
    gitCommitTool,
    gitBranchTool,
    gitCheckoutTool,
    {
      name: "webSearch",
      description: "Search the web (Tavily if configured, else DuckDuckGo)",
      execute: async (args) =>
        webSearch(config, args.query as string, (args.maxResults as number) || 5),
    },
    {
      name: "fetchUrl",
      description: "Fetch a URL and extract readable markdown content",
      execute: async (args) =>
        fetchAndExtract(args.url as string, (args.maxChars as number) || 8000),
    },
    {
      name: "detectLanguage",
      description: "Detect the programming language of a project",
      execute: async (args) => {
        const result = await detectLanguage((args.cwd as string) || process.cwd());
        return {
          success: true,
          output: `Language: ${result.language} (confidence: ${result.confidence})`,
        };
      },
    },
    {
      name: "runToolchain",
      description: "Run a build/test/lint/run command for the detected language",
      execute: async (args) =>
        runToolchain(
          args.command as string,
          (args.cwd as string) || process.cwd(),
          args.timeout as number | undefined
        ),
    },
  ];

  return tools;
}