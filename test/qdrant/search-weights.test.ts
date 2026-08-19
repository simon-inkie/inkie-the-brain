/**
 * Per-collection score weighting at search()'s merge point.
 *
 * The failure this fixes is ECHO-BURIAL. The messages collection holds an
 * agent's own paraphrases of a decision, several of them, from the very
 * session that made the decision, and each paraphrase scores marginally higher
 * against a query than the terse canonical note it restates. The note that
 * actually records the decision then ranks below its own echoes.
 *
 * Weighting is applied where results from different collections first become
 * comparable, i.e. the single push+sort in search(). The score_threshold stays
 * on the RAW score deliberately: the floor is a similarity floor, and moving it
 * would quietly change WHICH results exist rather than only their order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface StubHit {
  score: number;
  payload: Record<string, unknown>;
}

async function importSearchWith(hits: Record<string, StubHit[]>, weights: Record<string, number>) {
  vi.resetModules();

  vi.doMock("../../core/config.js", () => ({
    config: {
      qdrantUrl: "http://localhost:6333",
      qdrantApiKey: "",
      embeddingDimensions: 768,
      collections: {
        brain: "brain-vault",
        observations: "io-observations",
        reflections: "io-reflections",
        messages: "io-messages",
        assets: "io-assets",
      },
      searchDefaults: { limit: 10, scoreThreshold: 0.3, collectionWeights: weights },
    },
  }));

  const searchArgs: { collection: string; params: Record<string, unknown> }[] = [];
  vi.doMock("@qdrant/js-client-rest", () => ({
    QdrantClient: class {
      async search(collection: string, params: Record<string, unknown>) {
        searchArgs.push({ collection, params });
        return hits[collection] ?? [];
      }
    },
  }));

  const mod = await import("../../core/qdrant/client.js");
  return { search: mod.search, searchArgs };
}

const P = (collection: string, title: string) => ({
  source: `/x/${title}.md`,
  collection,
  title,
  content: `content of ${title}`,
  tags: [],
  date: "2026-08-01",
});

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("search merge-point weighting", () => {
  it("lets a canonical vault note outrank a higher-scoring chatter echo", async () => {
    // 0.80 x 0.93 = 0.744 < 0.76 — the echo wins on raw cosine and loses after
    // the downweight. This is the exact inversion the weighting exists to make.
    const { search } = await importSearchWith(
      {
        "io-messages": [{ score: 0.8, payload: P("io-messages", "agent paraphrase of the cap") }],
        "brain-vault": [{ score: 0.76, payload: P("brain-vault", "the note that set the cap") }],
      },
      { "io-messages": 0.93 },
    );

    const results = await search(["io-messages", "brain-vault"], new Array(768).fill(0), 10, 0.3);

    expect(results.map((r) => r.title)).toEqual([
      "the note that set the cap",
      "agent paraphrase of the cap",
    ]);
    expect(results[0].score).toBeCloseTo(0.76, 6);
    expect(results[1].score).toBeCloseTo(0.744, 6);
  });

  it("preserves the raw score for diagnostics", async () => {
    const { search } = await importSearchWith(
      { "io-messages": [{ score: 0.8, payload: P("io-messages", "echo") }] },
      { "io-messages": 0.93 },
    );

    const results = await search(["io-messages"], new Array(768).fill(0), 10, 0.3);

    expect(results[0].rawScore).toBeCloseTo(0.8, 6);
    expect(results[0].score).toBeCloseTo(0.744, 6);
  });

  it("leaves unlisted collections at x1.0", async () => {
    const { search } = await importSearchWith(
      {
        "brain-vault": [{ score: 0.7, payload: P("brain-vault", "vault note") }],
        "io-observations": [{ score: 0.69, payload: P("io-observations", "observation") }],
      },
      { "io-messages": 0.93 },
    );

    const results = await search(
      ["brain-vault", "io-observations"],
      new Array(768).fill(0),
      10,
      0.3,
    );

    expect(results[0].score).toBeCloseTo(0.7, 6);
    expect(results[0].rawScore).toBeCloseTo(0.7, 6);
    expect(results[1].score).toBeCloseTo(0.69, 6);
    expect(results.map((r) => r.title)).toEqual(["vault note", "observation"]);
  });

  it("keeps the score_threshold on the RAW score, so the weight reorders and never filters", async () => {
    const { searchArgs, search } = await importSearchWith(
      { "io-messages": [{ score: 0.32, payload: P("io-messages", "just above the floor") }] },
      { "io-messages": 0.93 },
    );

    const results = await search(["io-messages"], new Array(768).fill(0), 10, 0.3);

    // Threshold sent to Qdrant unmodified...
    expect(searchArgs[0].params.score_threshold).toBe(0.3);
    // ...and the weighted score (0.2976) is BELOW that floor yet still returned:
    // the weight changes rank, not membership.
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.2976, 6);
  });

  it("never lets a non-finite weight reach the sort, whatever the env says", async () => {
    // A malformed BRAIN_MESSAGES_SCORE_WEIGHT would otherwise reach here as
    // NaN. NaN is not nullish, so the `?? 1.0` at the use site never engages,
    // every messages result scores NaN, and the comparator's answers become
    // unspecified — the ranking silently turns to garbage on an env typo. The
    // guard is at the config sink; this drives the REAL config to prove it.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    const previous = process.env.BRAIN_MESSAGES_SCORE_WEIGHT;
    process.env.BRAIN_MESSAGES_SCORE_WEIGHT = "zero-point-nine";
    delete process.env.BRAIN_MESSAGES_COLLECTION;
    // The other tests in this file mock config.js, and a doMock registration
    // outlives resetModules — without this the "real" config below is a stub
    // whose weights were handed to it, and the test would prove nothing.
    vi.doUnmock("../../core/config.js");
    vi.resetModules();

    vi.doMock("@qdrant/js-client-rest", () => ({
      QdrantClient: class {
        async search(collection: string) {
          return collection === "io-messages"
            ? [{ score: 0.8, payload: P("io-messages", "echo") }]
            : [{ score: 0.76, payload: P("brain-vault", "canonical") }];
        }
      },
    }));

    const { config } = await import("../../core/config.js");
    const { search } = await import("../../core/qdrant/client.js");
    const results = await search(["io-messages", "brain-vault"], new Array(768).fill(0), 10, 0.3);

    expect(config.searchDefaults.collectionWeights["io-messages"]).toBe(0.93);
    expect(errors.join("\n"), "and the operator is told, not left guessing").toMatch(
      /BRAIN_MESSAGES_SCORE_WEIGHT/,
    );
    for (const r of results) {
      expect(Number.isFinite(r.score), `score for ${r.title} must be a real number`).toBe(true);
    }
    expect(results.map((r) => r.title)).toEqual(["canonical", "echo"]);

    spy.mockRestore();
    if (previous === undefined) delete process.env.BRAIN_MESSAGES_SCORE_WEIGHT;
    else process.env.BRAIN_MESSAGES_SCORE_WEIGHT = previous;
  });

  it("weights each collection by its own entry, not the first one seen", async () => {
    const { search } = await importSearchWith(
      {
        "io-messages": [{ score: 1.0, payload: P("io-messages", "m") }],
        "io-observations": [{ score: 1.0, payload: P("io-observations", "o") }],
        "brain-vault": [{ score: 1.0, payload: P("brain-vault", "b") }],
      },
      { "io-messages": 0.5, "io-observations": 0.25 },
    );

    const results = await search(
      ["io-messages", "io-observations", "brain-vault"],
      new Array(768).fill(0),
      10,
      0.3,
    );

    const byTitle = Object.fromEntries(results.map((r) => [r.title, r.score]));
    expect(byTitle.m).toBeCloseTo(0.5, 6);
    expect(byTitle.o).toBeCloseTo(0.25, 6);
    expect(byTitle.b).toBeCloseTo(1.0, 6);
  });
});
