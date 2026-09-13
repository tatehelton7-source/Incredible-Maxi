import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createPathGuard, sandboxCapability } from "../src/tools/sandbox.js";
import { evaluateApproval, ESCALATION_PATTERNS, type ApprovalMode } from "../src/tools/approval.js";

const MODES: ApprovalMode[] = ["always-ask", "plan-then-ask", "auto-with-gates"];

describe("createPathGuard", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "maxi-sandbox-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a path inside the root", () => {
    const guard = createPathGuard([root]);
    expect(() => guard.assertWithinRoots(join(root, "src", "file.ts"))).not.toThrow();
  });

  it("allows a path equal to the root itself", () => {
    const guard = createPathGuard([root]);
    expect(() => guard.assertWithinRoots(root)).not.toThrow();
  });

  it("blocks a ../ escape out of the root", () => {
    const guard = createPathGuard([root]);
    const escape = join(root, "..", "outside.txt");
    expect(() => guard.assertWithinRoots(escape)).toThrow(/outside declared writable roots/);
  });

  it("blocks an absolute path outside the root", () => {
    const guard = createPathGuard([root]);
    const outside = join(tmpdir(), "somewhere-else.txt");
    expect(() => guard.assertWithinRoots(outside)).toThrow(/outside declared writable roots/);
  });

  it("does not prefix-match a sibling root (trailing-separator safety)", () => {
    const guard = createPathGuard([root]);
    const sibling = `${root}2${sep}file.txt`;
    expect(() => guard.assertWithinRoots(sibling)).toThrow(/outside declared writable roots/);
  });

  it("defaults to cwd when no roots are given", () => {
    const guard = createPathGuard();
    expect(() => guard.assertWithinRoots(resolve("."))).not.toThrow();
    expect(() => guard.assertWithinRoots(resolve(".."))).toThrow(/outside declared writable roots/);
  });

  it("allows a path inside any of multiple roots", () => {
    const second = mkdtempSync(join(tmpdir(), "maxi-sandbox2-"));
    try {
      const guard = createPathGuard([root, second]);
      expect(() => guard.assertWithinRoots(join(second, "file.txt"))).not.toThrow();
      expect(() => guard.assertWithinRoots(join(root, "file.txt"))).not.toThrow();
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("blocks a Windows drive-relative quirk (C:\\..\\) on win32", () => {
    if (process.platform !== "win32") return;
    const guard = createPathGuard([root]);
    // `C:\..\` resolves to the drive root, which is outside the temp root.
    const driveRoot = `${root.slice(0, 2)}\\..\\`;
    expect(() => guard.assertWithinRoots(driveRoot)).toThrow(/outside declared writable roots/);
  });
});

describe("escalation patterns deny in every mode", () => {
  const ESCALATION_COMMANDS = [
    "sudo apt install x",
    "doas rm -rf /",
    "runas /user:admin cmd",
    'SetACL -on C:\\ -ot file -actn ace -ace "n:Everyone;p:full"',
    'icacls C:\\Windows /grant Everyone:F',
    "chmod 777 /etc/passwd",
    "chmod -R 777 /var/www",
    "cat ~/.ssh/id_rsa",
    "cat ~/.ssh/id_ed25519",
    "cat ~/.aws/credentials",
    "cat /etc/shadow",
    'cat /var/www/.env',
  ];

  it.each(MODES)("denies every escalation command in %s mode", (mode) => {
    for (const command of ESCALATION_COMMANDS) {
      const result = evaluateApproval({ toolName: "bash", args: { command } }, { mode });
      expect(result.decision, `expected deny for: ${command}`).toBe("deny");
      expect(result.rule).toMatch(/^escalation:/);
    }
  });

  it("exports a non-empty ESCALATION_PATTERNS array", () => {
    expect(ESCALATION_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("sandboxCapability", () => {
  it("reports a level and a note", () => {
    const cap = sandboxCapability();
    expect(["path-only", "wsl", "none"]).toContain(cap.level);
    expect(typeof cap.note).toBe("string");
    expect(cap.note.length).toBeGreaterThan(0);
  });

  it("reports 'path-only' with the Windows note on win32", () => {
    if (process.platform !== "win32") return;
    const cap = sandboxCapability();
    expect(cap.level).toBe("path-only");
    expect(cap.note).toContain("Windows: path confinement + approval only");
  });
});
