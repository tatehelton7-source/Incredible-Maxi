import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { MaxiConfig } from "../providers/types.js";

export interface SkillDef {
  name: string;
  description: string;
  command: string;
  promptTemplate: string;
  allowedTools?: string[];
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  command: string;
  allowedTools?: string[];
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Expected format:
 * ---
 * name: "skill-name"
 * description: "Description of the skill"
 * command: "skill-command"
 * allowedTools: ["readFile", "writeFile"]
 * ---
 * 
 * # Skill content becomes the prompt template
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }
  
  const frontmatterText = frontmatterMatch[1];
  const body = frontmatterMatch[2];
  
  // Simple YAML parsing for our needs
  const frontmatter: Partial<SkillFrontmatter> = {};
  const lines = frontmatterText.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    
    const key = trimmed.substring(0, colonIndex).trim();
    let value = trimmed.substring(colonIndex + 1).trim();
    
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    // Handle arrays
    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value);
      } catch {
        // Keep as string if not valid JSON
      }
    }
    
    (frontmatter as Record<string, unknown>)[key] = value;
  }
  
  return {
    frontmatter: frontmatter as SkillFrontmatter,
    body: body.trim(),
  };
}

/**
 * Expand tilde in path to home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return join(home, path.slice(2));
  }
  return path;
}

/**
 * Discover skill files from directories
 */
function discoverSkillFiles(directories: string[]): string[] {
  const files: string[] = [];
  
  for (const dir of directories) {
    const expandedDir = expandTilde(dir);
    if (!existsSync(expandedDir)) continue;
    
    try {
      const entries = readdirSync(expandedDir, { recursive: true, encoding: "utf-8" });
      for (const entry of entries) {
        const entryStr = String(entry);
        if (entryStr.endsWith(".md")) {
          files.push(join(expandedDir, entryStr));
        }
      }
    } catch {
      // Ignore errors reading directory
    }
  }
  
  return files;
}

/**
 * Load skills from configuration
 */
export function loadSkills(config: MaxiConfig): SkillDef[] {
  const skills: SkillDef[] = [];
  
  // Get skill directories from config
  const skillDirs = config.skills?.directories || [".claude/skills", "~/.maxi/skills"];
  
  // Discover skill files
  const skillFiles = discoverSkillFiles(skillDirs);
  
  for (const file of skillFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const parsed = parseFrontmatter(content);
      
      if (!parsed) {
        console.warn(`Skill file ${file} has no valid frontmatter, skipping`);
        continue;
      }
      
      const { frontmatter, body } = parsed;
      
      // Validate required fields
      if (!frontmatter.name) {
        console.warn(`Skill file ${file} missing required 'name' field, skipping`);
        continue;
      }
      if (!frontmatter.description) {
        console.warn(`Skill file ${file} missing required 'description' field, skipping`);
        continue;
      }
      if (!frontmatter.command) {
        console.warn(`Skill file ${file} missing required 'command' field, skipping`);
        continue;
      }
      
      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        command: frontmatter.command,
        promptTemplate: body,
        allowedTools: frontmatter.allowedTools,
      });
    } catch (err) {
      console.warn(`Failed to load skill from ${file}: ${(err as Error).message}`);
    }
  }
  
  return skills;
}