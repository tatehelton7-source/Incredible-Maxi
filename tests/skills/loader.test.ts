import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadSkills } from "../../src/skills/loader.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Skills Loader", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `maxi-skills-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should load valid skill files", () => {
    const skillContent = `---
name: "test-skill"
description: "A test skill"
command: "test"
allowedTools: ["readFile", "writeFile"]
---

This is the prompt template for the test skill.`;

    const skillPath = join(testDir, "test-skill.md");
    writeFileSync(skillPath, skillContent);

    const config = { skills: { directories: [testDir] } };
    const skills = loadSkills(config as any);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test-skill");
    expect(skills[0].description).toBe("A test skill");
    expect(skills[0].command).toBe("test");
    expect(skills[0].allowedTools).toEqual(["readFile", "writeFile"]);
    expect(skills[0].promptTemplate).toBe("This is the prompt template for the test skill.");
  });

  it("should skip files without valid frontmatter", () => {
    const skillContent = `This is just a markdown file without frontmatter.`;

    const skillPath = join(testDir, "no-frontmatter.md");
    writeFileSync(skillPath, skillContent);

    const config = { skills: { directories: [testDir] } };
    const skills = loadSkills(config as any);

    expect(skills).toHaveLength(0);
  });

  it("should skip files with missing required fields", () => {
    const skillContent = `---
description: "Missing name and command"
---

This skill is missing required fields.`;

    const skillPath = join(testDir, "missing-fields.md");
    writeFileSync(skillPath, skillContent);

    const config = { skills: { directories: [testDir] } };
    const skills = loadSkills(config as any);

    expect(skills).toHaveLength(0);
  });

  it("should handle missing directory gracefully", () => {
    const config = { skills: { directories: ["/non/existent/path"] } };
    const skills = loadSkills(config as any);
    expect(skills).toHaveLength(0);
  });

  it("should expand tilde in directory paths", () => {
    const skillContent = `---
name: "tilde-skill"
description: "Test tilde expansion"
command: "tilde"
---

Test skill.`;

    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const skillDir = join(homeDir, ".maxi-test-skills");
    const skillPath = join(skillDir, "tilde-skill.md");
    
    // Create directory and file
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, skillContent);

    try {
      const config = { skills: { directories: ["~/.maxi-test-skills"] } };
      const skills = loadSkills(config as any);
      
      // Should find the skill
      const found = skills.find(s => s.name === "tilde-skill");
      expect(found).toBeDefined();
    } finally {
      // Cleanup
      const { rmSync } = require("node:fs");
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("should parse allowedTools array", () => {
    const skillContent = `---
name: "tools-skill"
description: "Skill with tools"
command: "tools"
allowedTools: ["readFile", "writeFile", "bash"]
---

Test skill with tools.`;

    const skillPath = join(testDir, "tools-skill.md");
    writeFileSync(skillPath, skillContent);

    const config = { skills: { directories: [testDir] } };
    const skills = loadSkills(config as any);

    expect(skills).toHaveLength(1);
    expect(skills[0].allowedTools).toEqual(["readFile", "writeFile", "bash"]);
  });
});