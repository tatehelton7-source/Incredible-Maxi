import { describe, it, expect } from "vitest";
import {
  readFileSchema,
  writeFileSchema,
  editFileSchema,
  bashSchema,
  listDirectorySchema,
  globSchema,
  grepSchema,
} from "../../src/tools/schemas/index.js";

describe("Tool Schemas", () => {
  describe("readFileSchema", () => {
    it("should validate valid path", () => {
      const result = readFileSchema.safeParse({ path: "src/test.ts" });
      expect(result.success).toBe(true);
    });

    it("should reject missing path", () => {
      const result = readFileSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject non-string path", () => {
      const result = readFileSchema.safeParse({ path: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe("writeFileSchema", () => {
    it("should validate valid path and content", () => {
      const result = writeFileSchema.safeParse({ path: "src/test.ts", content: "test" });
      expect(result.success).toBe(true);
    });

    it("should reject missing path", () => {
      const result = writeFileSchema.safeParse({ content: "test" });
      expect(result.success).toBe(false);
    });

    it("should reject missing content", () => {
      const result = writeFileSchema.safeParse({ path: "src/test.ts" });
      expect(result.success).toBe(false);
    });
  });

  describe("editFileSchema", () => {
    it("should validate valid path, oldString, and newString", () => {
      const result = editFileSchema.safeParse({ 
        path: "src/test.ts", 
        oldString: "old", 
        newString: "new" 
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing fields", () => {
      const result = editFileSchema.safeParse({ path: "src/test.ts" });
      expect(result.success).toBe(false);
    });
  });

  describe("bashSchema", () => {
    it("should validate valid command", () => {
      const result = bashSchema.safeParse({ command: "ls -la" });
      expect(result.success).toBe(true);
    });

    it("should accept optional cwd", () => {
      const result = bashSchema.safeParse({ command: "ls", cwd: "/tmp" });
      expect(result.success).toBe(true);
    });

    it("should accept optional timeout", () => {
      const result = bashSchema.safeParse({ command: "ls", timeout: 5000 });
      expect(result.success).toBe(true);
    });

    it("should reject missing command", () => {
      const result = bashSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("listDirectorySchema", () => {
    it("should validate valid path", () => {
      const result = listDirectorySchema.safeParse({ path: "src" });
      expect(result.success).toBe(true);
    });

    it("should accept optional path", () => {
      const result = listDirectorySchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("globSchema", () => {
    it("should validate valid pattern", () => {
      const result = globSchema.safeParse({ pattern: "**/*.ts" });
      expect(result.success).toBe(true);
    });

    it("should accept optional cwd", () => {
      const result = globSchema.safeParse({ pattern: "**/*.ts", cwd: "src" });
      expect(result.success).toBe(true);
    });

    it("should reject missing pattern", () => {
      const result = globSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("grepSchema", () => {
    it("should validate valid pattern", () => {
      const result = grepSchema.safeParse({ pattern: "test" });
      expect(result.success).toBe(true);
    });

    it("should accept optional cwd and include", () => {
      const result = grepSchema.safeParse({ 
        pattern: "test", 
        cwd: "src", 
        include: "*.ts" 
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing pattern", () => {
      const result = grepSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});