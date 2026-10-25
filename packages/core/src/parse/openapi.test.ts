import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyRequestedVersion, detectOpenApiFlavor, openApiToSpec, parseApiDocument, toSnakeCase } from "./openapi.js";

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/openapi/${name}`, import.meta.url), "utf8");
const options = { sourceUrl: "https://petstore3.example.com/openapi.yaml", envPrefix: "PETSTORE", fetchedAt: "2026-10-25T00:00:00.000Z" };

describe("openApiToSpec (OpenAPI 3)", () => {
  const doc = parseApiDocument(fixture("petstore-v3.yaml"));
  const spec = openApiToSpec(doc, options);

  it("detects the flavor", () => {
    expect(detectOpenApiFlavor(doc)).toBe("openapi3");
  });

  it("extracts endpoints with snake_case ids", () => {
    expect(spec.endpoints.map((e) => e.id)).toEqual([
      "add_pet",
      "update_pet",
      "find_pets_by_status",
      "get_pet_by_id",
      "delete_pet",
      "get_inventory",
    ]);
  });

  it("merges path-level parameters and marks resources", () => {
    const get = spec.endpoints.find((e) => e.id === "get_pet_by_id")!;
    expect(get.params).toEqual([
      { name: "petId", in: "path", required: true, description: "ID of pet", schema: { type: "integer", format: "int64" } },
    ]);
    expect(get.resource).toBe(true);
    expect(spec.endpoints.find((e) => e.id === "find_pets_by_status")!.resource).toBe(false);
  });

  it("inlines refs and stubs recursion", () => {
    const body = spec.endpoints.find((e) => e.id === "add_pet")!.body!;
    expect(body.contentType).toBe("application/json");
    expect(body.required).toBe(true);
    const category = (body.schema.properties as Record<string, Record<string, unknown>>).category!;
    const parent = (category.properties as Record<string, Record<string, unknown>>).parent!;
    expect(parent.description).toMatch(/nested structure omitted/);
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it("detects path versioning and auth schemes", () => {
    expect(spec.baseUrl).toBe("https://petstore3.example.com/api/{apiVersion}");
    expect(spec.versionStrategy).toEqual({ type: "path", default: "v3" });
    expect(spec.auth).toEqual([
      {
        type: "oauth2",
        scopes: ["write:pets", "read:pets"],
        tokenEnvVar: "PETSTORE_ACCESS_TOKEN",
        clientIdEnvVar: "PETSTORE_CLIENT_ID",
        clientSecretEnvVar: "PETSTORE_CLIENT_SECRET",
      },
      { type: "apiKey", in: "header", name: "api_key", envVar: "PETSTORE_API_KEY" },
    ]);
  });
});

describe("openApiToSpec (Swagger 2)", () => {
  const spec = openApiToSpec(parseApiDocument(fixture("petstore-v2.json")), options);

  it("builds the base url from host/basePath and detects the version", () => {
    expect(spec.baseUrl).toBe("https://petstore.example.com/{apiVersion}");
    expect(spec.versionStrategy).toEqual({ type: "path", default: "v2" });
  });

  it("converts body and formData parameters", () => {
    const add = spec.endpoints.find((e) => e.id === "add_pet")!;
    expect(add.body?.schema.required).toEqual(["name"]);
    expect(add.body?.schema).not.toHaveProperty("xml");
    const upload = spec.endpoints.find((e) => e.id === "upload_file")!;
    expect(upload.body?.contentType).toBe("multipart/form-data");
    expect(Object.keys(upload.body?.schema.properties as object)).toEqual(["additionalMetadata", "file"]);
  });
});

describe("helpers", () => {
  it.each([
    ["getPetById", "get_pet_by_id"],
    ["repos/list-for-org", "repos_list_for_org"],
    ["HTTPStatus", "httpstatus"],
  ])("toSnakeCase(%s)", (input, expected) => {
    expect(toSnakeCase(input)).toBe(expected);
  });

  it("applies a requested version only when it fits the strategy", () => {
    const spec = openApiToSpec(parseApiDocument(fixture("petstore-v3.yaml")), options);
    expect(applyRequestedVersion(spec, "v4").spec.versionStrategy).toEqual({ type: "path", default: "v4" });
    expect(applyRequestedVersion(spec, "4").applied).toBe(true);
    expect(applyRequestedVersion(spec, "16.5.1").applied).toBe(false);
  });

  it("rejects non-OpenAPI documents", () => {
    expect(() => openApiToSpec({ hello: "world" }, options)).toThrow(/Not an OpenAPI/);
  });
});
