import { z } from "zod";
import { ChangeEntrySchema } from "./library.js";
import { SourceRefSchema } from "./source.js";

export const DocPageSchema = z.object({
  /** URL-safe slug, unique within the corpus, e.g. `components/button`. */
  path: z.string(),
  title: z.string(),
  section: z.string().optional(),
  kind: z.enum(["page", "component"]),
  markdown: z.string(),
  sourceUrl: z.string(),
});
export type DocPage = z.infer<typeof DocPageSchema>;

export const DocCorpusSchema = z.object({
  title: z.string(),
  version: z.string().optional(),
  license: z.string().optional(),
  pages: z.array(DocPageSchema),
  sources: z.array(SourceRefSchema),
  /** Release notes of the library (GitHub releases or CHANGELOG), oldest first. */
  changes: z.array(ChangeEntrySchema).optional(),
});
export type DocCorpus = z.infer<typeof DocCorpusSchema>;
