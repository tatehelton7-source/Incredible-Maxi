import { z } from "zod";

export const readFileSchema = z.object({
  path: z.string().describe("The path to the file to read"),
});

export type ReadFileArgs = z.infer<typeof readFileSchema>;