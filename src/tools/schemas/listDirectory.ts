import { z } from "zod";

export const listDirectorySchema = z.object({
  path: z.string().optional().describe("The path to the directory to list (defaults to current directory)"),
});

export type ListDirectoryArgs = z.infer<typeof listDirectorySchema>;