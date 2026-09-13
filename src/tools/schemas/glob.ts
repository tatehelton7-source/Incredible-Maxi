import { z } from "zod";

export const globSchema = z.object({
  pattern: z.string().describe("The glob pattern to match files"),
  cwd: z.string().optional().describe("The working directory for the search"),
});

export type GlobArgs = z.infer<typeof globSchema>;