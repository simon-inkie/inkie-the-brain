import { describe, it, expect, afterEach, vi } from "vitest";
import { createProvider, providerName } from "../../core/embedder/provider.js";
import { config } from "../../core/config.js";

const dims = config.embeddingDimensions;

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fn = vi.fn(async () => response as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("embedding provider selection", () => {
  it("defaults to gemini", () => {
    expect(providerName({})).toBe("gemini");
    expect(createProvider({}).name).toBe("gemini");
    expect(createProvider({}).metered).toBe(true);
  });

  it("selects the openai-compatible provider", () => {
    const p = createProvider({ EMBED_PROVIDER: "OpenAI" });
    expect(p.name).toBe("openai");
    expect(p.metered).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(() => createProvider({ EMBED_PROVIDER: "nope" })).toThrow(/unknown EMBED_PROVIDER/);
  });

  it("gemini without a key fails with the familiar message", async () => {
    await expect(createProvider({}).embed("x", "RETRIEVAL_QUERY")).rejects.toThrow(
      "GEMINI_API_KEY not set",
    );
  });
});

describe("openai-compatible provider", () => {
  const vec = new Array(dims).fill(0.5);
  const ok = () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: vec }] }) });

  it("posts to the base url with model, prefix and no key header for a local server", async () => {
    const fetchFn = stubFetch(ok());
    const p = createProvider({
      EMBED_PROVIDER: "openai",
      EMBED_MODEL: "nomic-embed-text",
      EMBED_BASE_URL: "http://localhost:9999/v1/",
      EMBED_QUERY_PREFIX: "search_query: ",
    });
    expect(await p.embed("hello", "RETRIEVAL_QUERY")).toEqual(vec);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:9999/v1/embeddings");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "nomic-embed-text",
      input: "search_query: hello",
    });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends a bearer key and dimensions when configured", async () => {
    const fetchFn = stubFetch(ok());
    const p = createProvider({
      EMBED_PROVIDER: "openai",
      EMBED_MODEL: "m",
      EMBED_API_KEY: "k",
      EMBED_SEND_DIMENSIONS: "true",
    });
    await p.embed("hello", "RETRIEVAL_DOCUMENT");
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string).dimensions).toBe(dims);
  });

  it("requires EMBED_MODEL", async () => {
    stubFetch(ok());
    await expect(createProvider({ EMBED_PROVIDER: "openai" }).embed("x", "RETRIEVAL_QUERY")).rejects.toThrow(
      /EMBED_MODEL not set/,
    );
  });

  it("keeps the status code in the error so the retry classifier sees a 429", async () => {
    stubFetch({ ok: false, status: 429, text: async () => "slow down" });
    await expect(
      createProvider({ EMBED_PROVIDER: "openai", EMBED_MODEL: "m" }).embed("x", "RETRIEVAL_QUERY"),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("fails loudly on a dimension mismatch", async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) });
    await expect(
      createProvider({ EMBED_PROVIDER: "openai", EMBED_MODEL: "m" }).embed("x", "RETRIEVAL_QUERY"),
    ).rejects.toThrow(/3 dimensions but EMBED_DIMENSIONS/);
  });
});

describe("keyless dry run", () => {
  it("embeds with no API key and never reaches a provider", async () => {
    vi.resetModules();
    vi.stubEnv("EMBED_DRY_RUN", "true");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("EMBED_PROVIDER", "openai"); // would throw (no EMBED_MODEL) if called
    vi.stubEnv("EMBED_MODEL", "");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const { embedTexts } = await import("../../core/embedder/text.js");
    const out = await embedTexts(["a", "b"], "RETRIEVAL_DOCUMENT");
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(config.embeddingDimensions);
    expect(out[0].every((v) => v === 0)).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
