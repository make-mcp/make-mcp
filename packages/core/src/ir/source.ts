import { z } from "zod";

export const SourceKindSchema = z.enum([
  "openapi",
  "llms-txt",
  "llms-full-txt",
  "website",
  "repo-docs",
  "local-docs",
  "readme",
  "file",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceRefSchema = z.object({
  kind: SourceKindSchema,
  url: z.string(),
  fetchedAt: z.string(),
  /** Git ref or declared doc version the content belongs to, if known. */
  ref: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;
