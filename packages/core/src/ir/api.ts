import { z } from "zod";
import { SourceRefSchema } from "./source.js";

export const ParamSchema = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "header", "cookie"]),
  required: z.boolean(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()),
});
export type Param = z.infer<typeof ParamSchema>;

export const RequestBodySchema = z.object({
  contentType: z.string(),
  required: z.boolean(),
  schema: z.record(z.string(), z.unknown()),
});
export type RequestBody = z.infer<typeof RequestBodySchema>;

export const EndpointSchema = z.object({
  /** MCP tool name, snake_case, unique within the spec. */
  id: z.string().regex(/^[a-z0-9_]{1,64}$/),
  method: z.enum(["get", "post", "put", "patch", "delete", "head", "options"]),
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  params: z.array(ParamSchema),
  body: RequestBodySchema.optional(),
  tags: z.array(z.string()),
  deprecated: z.boolean(),
  /** Also expose as MCP resource (side-effect-free GET without query params). */
  resource: z.boolean(),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const AuthSchemeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("apiKey"),
    in: z.enum(["header", "query", "cookie"]),
    name: z.string(),
    envVar: z.string(),
  }),
  z.object({ type: z.literal("bearer"), envVar: z.string() }),
  z.object({ type: z.literal("basic"), userEnvVar: z.string(), passwordEnvVar: z.string() }),
  z.object({
    type: z.literal("oauth2"),
    /** Client-credentials flow when tokenUrl is set, otherwise a pre-issued access token. */
    tokenUrl: z.string().optional(),
    scopes: z.array(z.string()),
    tokenEnvVar: z.string(),
    clientIdEnvVar: z.string(),
    clientSecretEnvVar: z.string(),
  }),
]);
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;

export const VersionStrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  /** `{apiVersion}` placeholder lives in baseUrl or endpoint paths. */
  z.object({ type: z.literal("path"), default: z.string() }),
  z.object({ type: z.literal("header"), name: z.string(), default: z.string() }),
  z.object({ type: z.literal("query"), name: z.string(), default: z.string() }),
]);
export type VersionStrategy = z.infer<typeof VersionStrategySchema>;

export const ApiSpecSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  specVersion: z.string(),
  baseUrl: z.string(),
  versionStrategy: VersionStrategySchema,
  auth: z.array(AuthSchemeSchema),
  endpoints: z.array(EndpointSchema),
  source: SourceRefSchema,
});
export type ApiSpec = z.infer<typeof ApiSpecSchema>;
