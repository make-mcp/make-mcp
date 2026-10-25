import { z } from "zod";

/** One release from GitHub releases or a CHANGELOG section. */
export const ChangeEntrySchema = z.object({
  version: z.string(),
  title: z.string(),
  date: z.string().optional(),
  markdown: z.string(),
  sourceUrl: z.string(),
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ApiSymbolSchema = z.object({
  /** Exported name; methods of Python classes are `Class.method`. */
  name: z.string(),
  kind: z.enum(["function", "class", "interface", "type", "variable", "enum", "namespace", "method"]),
  /** Declaring file relative to the package (TS) or dotted module path (Python). */
  module: z.string(),
  signature: z.string(),
  doc: z.string().optional(),
});
export type ApiSymbol = z.infer<typeof ApiSymbolSchema>;
