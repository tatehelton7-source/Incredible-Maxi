import { grepTool, globTool } from "../tools/files.js";

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

export async function searchCode(
  query: string,
  cwd: string,
  options?: { include?: string; maxResults?: number }
): Promise<SearchResult[]> {
  const result = await grepTool.execute({
    pattern: query,
    cwd,
    include: options?.include,
  });

  if (!result.success || !result.output) return [];

  const lines = result.output.split("\n").filter(Boolean);
  const results: SearchResult[] = [];

  for (const line of lines) {
    const match = line.match(/^([^:]+):(\d+):\s*(.*)$/);
    if (match) {
      results.push({
        file: match[1],
        line: parseInt(match[2], 10),
        content: match[3],
      });
    }
  }

  const max = options?.maxResults || 50;
  return results.slice(0, max);
}

export async function searchFiles(pattern: string, cwd: string): Promise<string[]> {
  const result = await globTool.execute({
    pattern,
    cwd,
  });

  if (!result.success || !result.output) return [];
  return result.output.split("\n").filter(Boolean);
}

export async function semanticSearch(
  _query: string,
  _cwd: string
): Promise<SearchResult[]> {
  throw new Error("Semantic search not implemented — requires embedding model (future work)");
}
