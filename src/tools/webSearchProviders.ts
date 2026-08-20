import type { MaxiConfig } from "../providers/types.js";
import { webAccessLog } from "./web.js";
import type { ToolResult } from "./web.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };

  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content.substring(0, 300),
  }));
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Maxi/0.1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: ${res.status}`);
  }

  const html = await res.text();
  const results: SearchResult[] = [];

  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ title: string; url: string }> = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null && links.length < maxResults) {
    const rawUrl = match[1];
    const decoded = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    links.push({ title: match[2].replace(/<[^>]*>/g, "").trim(), url: decoded });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  return results;
}

export async function resolveSearchProvider(config: MaxiConfig): Promise<"tavily" | "duckduckgo"> {
  return config.tavilyApiKey ? "tavily" : "duckduckgo";
}

export async function webSearch(
  config: MaxiConfig,
  query: string,
  maxResults = 5
): Promise<ToolResult> {
  try {
    const provider = await resolveSearchProvider(config);
    let results: SearchResult[];

    if (provider === "tavily") {
      results = await searchTavily(config.tavilyApiKey!, query, maxResults);
    } else {
      results = await searchDuckDuckGo(query, maxResults);
    }

    webAccessLog.push({ timestamp: new Date().toISOString(), type: "search", query });

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");

    return { success: true, output: formatted || "No results found." };
  } catch (err) {
    return { success: false, output: "", error: `Search failed: ${(err as Error).message}` };
  }
}