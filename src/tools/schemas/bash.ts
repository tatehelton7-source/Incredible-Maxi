import { z } from "zod";

export const bashSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  cwd: z.string().optional().describe("The working directory for the command"),
  timeout: z.number().optional().describe("Timeout in milliseconds (max 120000)"),
});

export type BashArgs = z.infer<typeof bashSchema>;