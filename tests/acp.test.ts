import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { AcpClient, AcpServer } from "../src/acp/adapter.js";
import type { AgentOrchestrator, AgentRunResult } from "../src/agents/orchestrator.js";

/** A fake child process backed by PassThrough streams. */
function createFakeChildProcess(): {
  proc: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(),
    on: vi.fn(),
  } as unknown as ChildProcess;
  return { proc, stdin, stdout };
}

/** Build a minimal fake orchestrator. */
function createFakeOrchestrator(
  impl?: (agentName: string, prompt: string) => Promise<AgentRunResult>
): AgentOrchestrator {
  return {
    runAgent: vi.fn(async (agentName: string, prompt: string) => {
      if (impl) return impl(agentName, prompt);
      return { text: `ran ${agentName}: ${prompt}`, iterations: 1, toolCalls: 0 };
    }),
    listAgents: vi.fn(() => [
      { name: "coder", description: "writes code", systemPrompt: "be a coder" },
    ]),
  } as unknown as AgentOrchestrator;
}

describe("AcpClient", () => {
  let fake: ReturnType<typeof createFakeChildProcess>;
  let client: AcpClient;

  beforeEach(() => {
    fake = createFakeChildProcess();
    client = new AcpClient({
      command: "fake-agent",
      spawnFn: (() => fake.proc) as typeof import("node:child_process").spawn,
      stdio: { stdin: fake.stdin, stdout: fake.stdout },
    });
  });

  afterEach(async () => {
    await client.close();
  });

  it("connects and runs a task, receiving a result", async () => {
    await client.connect();

    const resultPromise = client.runTask("hello");
    // The client writes a JSON-RPC request; respond with a valid result.
    const written = fake.stdin.read()?.toString() ?? "";
    const request = JSON.parse(written);
    expect(request.method).toBe("agent/task");
    expect(request.params.prompt).toBe("hello");

    fake.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { text: "hi back", iterations: 2, toolCalls: 1 },
      }) + "\n"
    );

    const result = await resultPromise;
    expect(result.text).toBe("hi back");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
  });

  it("rejects when the agent returns an error", async () => {
    await client.connect();

    const resultPromise = client.runTask("boom");
    const written = fake.stdin.read()?.toString() ?? "";
    const request = JSON.parse(written);

    fake.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "agent exploded" },
      }) + "\n"
    );

    await expect(resultPromise).rejects.toThrow("agent exploded");
  });

  it("rejects when the agent returns a malformed result", async () => {
    await client.connect();

    const resultPromise = client.runTask("bad");
    const written = fake.stdin.read()?.toString() ?? "";
    const request = JSON.parse(written);

    fake.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { nope: true } }) + "\n"
    );

    await expect(resultPromise).rejects.toThrow("invalid task result");
  });

  it("throws when running a task before connecting", async () => {
    await expect(client.runTask("x")).rejects.toThrow("not connected");
  });

  it("exposes the agent as an AgentConfig", async () => {
    const config = client.toAgentConfig({
      name: "external",
      description: "an external ACP agent",
    });
    expect(config.name).toBe("external");
    expect(config.description).toBe("an external ACP agent");
    expect(typeof config.systemPrompt).toBe("string");
  });
});

describe("AcpServer", () => {
  let orchestrator: AgentOrchestrator;
  let stdin: PassThrough;
  let stdout: PassThrough;
  let server: AcpServer;

  beforeEach(() => {
    orchestrator = createFakeOrchestrator();
    stdin = new PassThrough();
    stdout = new PassThrough();
    server = new AcpServer({ orchestrator, stdio: { stdin, stdout } });
    server.start();
  });

  afterEach(() => {
    server.close();
  });

  it("lists agents", async () => {
    const responsePromise = new Promise<string>((resolve) => {
      stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/list", params: {} }) + "\n"
    );

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.id).toBe(1);
    expect(response.result.agents).toHaveLength(1);
    expect(response.result.agents[0].name).toBe("coder");
  });

  it("runs a task by dispatching to the orchestrator", async () => {
    const responsePromise = new Promise<string>((resolve) => {
      stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "agent/task",
        params: { agentName: "coder", prompt: "write code" },
      }) + "\n"
    );

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.id).toBe(2);
    expect(response.result.text).toContain("write code");
    expect(orchestrator.runAgent).toHaveBeenCalledWith("coder", "write code");
  });

  it("returns an error for missing params", async () => {
    const responsePromise = new Promise<string>((resolve) => {
      stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "agent/task", params: {} }) + "\n"
    );

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.error.code).toBe(-32602);
  });

  it("returns an error for unknown methods", async () => {
    const responsePromise = new Promise<string>((resolve) => {
      stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nope", params: {} }) + "\n"
    );

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.error.code).toBe(-32601);
  });

  it("returns a parse error for malformed JSON", async () => {
    const responsePromise = new Promise<string>((resolve) => {
      stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    stdin.write("not json\n");

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.error.code).toBe(-32700);
  });

  it("returns an error when the orchestrator throws", async () => {
    const failing = createFakeOrchestrator(async () => {
      throw new Error("orchestrator boom");
    });
    const s2stdin = new PassThrough();
    const s2stdout = new PassThrough();
    const s2 = new AcpServer({
      orchestrator: failing,
      stdio: { stdin: s2stdin, stdout: s2stdout },
    });
    s2.start();

    const responsePromise = new Promise<string>((resolve) => {
      s2stdout.on("data", (d: Buffer) => resolve(d.toString()));
    });

    s2stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "agent/task",
        params: { agentName: "coder", prompt: "x" },
      }) + "\n"
    );

    const raw = await responsePromise;
    const response = JSON.parse(raw);
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("orchestrator boom");
    s2.close();
  });
});
