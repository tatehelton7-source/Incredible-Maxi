import { z } from "zod";

export const grepSchema = z.object({
  pattern: z.string().describe("The regex pattern to search for"),
  cwd: z.string().optional().describe("The working directory for the search"),
  include: z.string().optional().describe("Optional glob pattern to filter files"),
});

export type GrepArgs = z.infer<typeof grepSchema>;