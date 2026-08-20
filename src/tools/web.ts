import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ToolResult } from "./types.js";

export type { ToolResult } from "./types.js";

export const webAccessLog: Array<{
  timestamp: string;
  type: "search" | "fetch";
  query?: string;
  url?: string;
}> = [];

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const PRIVATE_RANGES = [
  { start: ipToInt("10.0.0.0"),     end: ipToInt("10.255.255.255") },
  { start: ipToInt("172.16.0.0"),   end: ipToInt("172.31.255.255") },
  { start: ipToInt("192.168.0.0"),  end: ipToInt("192.168.255.255") },
  { start: ipToInt("127.0.0.0"),    end: ipToInt("127.255.255.255") },
  { start: ipToInt("169.254.0.0"),  end: ipToInt("169.254.255.255") },
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIP(ip: string): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.includes(":")) return false;
  const num = ipToInt(ip);
  return PRIVATE_RANGES.some((range) => num >= range.start && num <= range.end);
}

async function validateURL(url: string): Promise<{ valid: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: `Blocked scheme: ${parsed.protocol}` };
  }

  try {
    const { Resolver } = await import("node:dns/promises");
    const resolver = new Resolver();
    // Use Google + Cloudflare DNS to bypass local resolver issues
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);
    const addresses = await resolver.resolve(parsed.hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { valid: false, error: `Blocked: ${parsed.hostname} resolves to private IP ${addr}` };
      }
    }
  } catch {
    return { valid: false, error: `DNS resolution failed for ${parsed.hostname}` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Safe fetch with redirect validation
// ---------------------------------------------------------------------------

async function safeFetch(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number }
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  let current = url;

  for (let hop = 0; hop < 5; hop++) {
    const check = await validateURL(current);
    if (!check.valid) throw new Error(`Blocked: ${check.error}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location")!, current).toString();
        continue;
      }

      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many redirects");
}

// ---------------------------------------------------------------------------
// Decompression-bomb protection
// ---------------------------------------------------------------------------

async function readWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) throw new Error("Response has no body");

  const reader = res.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel();
      throw new Error("Response exceeded size limit after decoding");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Fetch and extract
// ---------------------------------------------------------------------------

export async function fetchAndExtract(url: string, maxChars = 8000): Promise<ToolResult> {
  try {
    const res = await safeFetch(url, { timeoutMs: 10000, maxBytes: 2_000_000 });
    const html = await readWithCap(res, 2_000_000);

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return { success: false, output: "", error: "Could not extract readable content from page" };
    }

    const turndown = new TurndownService();
    const content = article.content ?? "";
    let markdown = turndown.turndown(content);

    if (markdown.length > maxChars) {
      markdown = markdown.substring(0, maxChars) + `\n\n[truncated at ${maxChars} chars]`;
    }

    webAccessLog.push({ timestamp: new Date().toISOString(), type: "fetch", url });
    return { success: true, output: markdown };
  } catch (err) {
    return { success: false, output: "", error: `Fetch failed: ${(err as Error).message}` };
  }
}
