import { describe, it, expect } from "vitest";
import { scrubEnv } from "../src/tools/env.js";

describe("scrubEnv", () => {
  it("removes keys matching sensitive patterns", () => {
    const input: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-123",
      ANTHROPIC_API_TOKEN: "tok-456",
      GITHUB_TOKEN: "ghp-789",
      AWS_SECRET: "secret-abc",
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    const result = scrubEnv(input);
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_API_TOKEN).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.AWS_SECRET).toBeUndefined();
  });

  it("keeps non-sensitive keys", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
    };
    const result = scrubEnv(input);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.LANG).toBe("en_US.UTF-8");
    expect(result.TERM).toBe("xterm-256color");
  });

  it("does not mutate the input object", () => {
    const input: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-123",
      PATH: "/usr/bin",
    };
    scrubEnv(input);
    expect(input.OPENAI_API_KEY).toBe("sk-123");
    expect(input.PATH).toBe("/usr/bin");
  });

  it("returns a new object, not the same reference", () => {
    const input: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const result = scrubEnv(input);
    expect(result).not.toBe(input);
  });

  it("defaults to process.env when no argument is given", () => {
    const result = scrubEnv();
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});
