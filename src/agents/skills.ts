import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";

export interface SkillConfig {
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
  model?: string;
  enabled: boolean;
}

export class SkillLoader {
  private skills: Map<string, SkillConfig> = new Map();
  private skillDirs: string[];

  constructor(skillDirs: string[]) {
    this.skillDirs = skillDirs;
  }

  loadSkills(): SkillConfig[] {
    this.skills.clear();
    for (const dir of this.skillDirs) {
      this.loadFromDir(dir);
    }
    return this.listSkills();
  }

  private loadFromDir(dir: string): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const fullPath = join(dir, entry);
        const skill = this.parseSkillFile(fullPath);
        if (skill) {
          this.skills.set(skill.name, skill);
        }
      }
    }
  }

  private parseSkillFile(filePath: string): SkillConfig | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);

      if (!data.name || !data.description) return null;

      return {
        name: data.name,
        description: data.description,
        instructions: content.trim(),
        tools: data.tools || [],
        model: data.model,
        enabled: data.enabled !== false,
      };
    } catch {
      return null;
    }
  }

  getSkill(name: string): SkillConfig | undefined {
    return this.skills.get(name);
  }

  listSkills(): SkillConfig[] {
    return [...this.skills.values()].filter((s) => s.enabled);
  }

  listAllSkills(): SkillConfig[] {
    return [...this.skills.values()];
  }

  enableSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = true;
      return true;
    }
    return false;
  }

  disableSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = false;
      return true;
    }
    return false;
  }
}

export class SkillExecutor {
  private skills: Map<string, SkillConfig> = new Map();

  registerSkill(skill: SkillConfig): void {
    this.skills.set(skill.name, skill);
  }

  getSkillInstructions(name: string): string | undefined {
    const skill = this.skills.get(name);
    return skill?.instructions;
  }

  listAvailableSkills(): string[] {
    return [...this.skills.values()].filter((s) => s.enabled).map((s) => s.name);
  }
}
