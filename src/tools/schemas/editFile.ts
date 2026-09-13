import { z } from "zod";

export const editFileSchema = z.object({
  path: z.string().describe("The path to the file to edit"),
  oldString: z.string().describe("The string to find and replace"),
  newString: z.string().describe("The string to replace with"),
});

export type EditFileArgs = z.infer<typeof editFileSchema>;