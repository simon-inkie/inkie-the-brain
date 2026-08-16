import { appendFile, mkdir } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { config } from "../config.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Shared embedding gate — used by text.ts AND assets.ts.
//
// Centralises EMBED_DRY_RUN, MAX_EMBEDS_PER_TICK, tickCounter, and telemetry
// so every embedding path (text, image, PDF, audio) is governed by the same
// controls. A bypass in any individual embedder file is structurally prevented.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dry-run mode
// Read once on first call, cached for the process lifetime.
// Set EMBED_DRY_RUN=true in env to observe indexer behaviour without spending
// real Gemini tokens. Zero-vectors are returned; Qdrant mutations are skipped
// at the caller (messages.ts).
// ---------------------------------------------------------------------------

let DRY_RUN: boolean | null = null;

export function isDryRun(): boolean {
  if (DRY_RUN === null) {
    DRY_RUN = process.env.EMBED_DRY_RUN === "true";
    if (DRY_RUN) {
      console.error(
        "[embedder] ⚠️  EMBED_DRY_RUN=true — no Gemini calls will be made; zero-vectors returned; Qdrant mutations skipped at indexer layer"
      );
    }
  }
  return DRY_RUN;
}

/** Return a zero-vector of the configured embedding dimension. */
export function dryRunVector(): number[] {
  return new Array(config.embeddingDimensions).fill(0);
}

// ---------------------------------------------------------------------------
// Hard kill-switch — MAX_EMBEDS_PER_TICK (default 5000).
// Counter resets each indexer tick via resetTickCounter().
// Throws EmbedQuotaExceededError if exceeded — indexer halts loud rather
// than bleeding cost silently.
// Shared across text + asset paths so the budget is system-wide.
// ---------------------------------------------------------------------------

export const MAX_EMBEDS_PER_TICK = parseInt(
  process.env.MAX_EMBEDS_PER_TICK ?? "5000",
  10
);

export class EmbedQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedQuotaExceededError";
  }
}

let tickCounter = 0;

export function resetTickCounter(): void {
  tickCounter = 0;
}

/**
 * Read-only view of how much of this tick's embed budget is left.
 *
 * This does NOT relax the kill-switch — chargeTick still throws exactly when it
 * throws today. It exists so a caller can SIZE a unit of work to fit the tick
 * instead of discovering the ceiling by being thrown out of it (which discards
 * the whole unit's progress). Pure read, no mutation, no side effects.
 *
 * Floors at 0: chargeTick increments the counter BEFORE throwing, so after a
 * halt the counter can sit above the cap and the raw subtraction goes negative.
 */
export function remainingTickBudget(): number {
  return Math.max(0, MAX_EMBEDS_PER_TICK - tickCounter);
}

// ---------------------------------------------------------------------------
// Per-tick telemetry accumulator.
// Flushed to ~/.the-brain/logs/embed-telemetry.jsonl at end of each tick
// via flushTelemetry() (called by the indexer after saveState()).
// ---------------------------------------------------------------------------

interface TelemetryRecord {
  ts: string;
  agentName: string;
  callsThisTick: number;
  textsThisTick: number;
  charsThisTick: number;
  dryRun: boolean;
  estimatedCostUsd: number;
}

let telemetryAccumulator: {
  callsThisTick: number;
  textsThisTick: number;
  charsThisTick: number;
  estimatedCostUsd: number;
} = { callsThisTick: 0, textsThisTick: 0, charsThisTick: 0, estimatedCostUsd: 0 };

function resetTelemetryAccumulator(): void {
  telemetryAccumulator = { callsThisTick: 0, textsThisTick: 0, charsThisTick: 0, estimatedCostUsd: 0 };
}

const TELEMETRY_LOG = join(homedir(), ".the-brain", "logs", "embed-telemetry.jsonl");

export async function flushTelemetry(): Promise<void> {
  if (telemetryAccumulator.callsThisTick === 0) return;

  const record: TelemetryRecord = {
    ts: new Date().toISOString(),
    agentName: process.env.AGENT_NAME ?? "unknown",
    ...telemetryAccumulator,
    dryRun: isDryRun(),
  };

  try {
    await mkdir(dirname(TELEMETRY_LOG), { recursive: true });
    await appendFile(TELEMETRY_LOG, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[embedder] telemetry flush failed: ${msg}`);
  }

  resetTelemetryAccumulator();

  // Persist spend ledger if it was loaded this process.
  if (spendLedger !== null) {
    try {
      // Re-resolve path (may have been overridden by env in tests).
      const ledgerPath = process.env.EMBED_SPEND_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
      // Prune buckets older than 30 days.
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - 30);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const pruned: SpendLedger = {};
      for (const [day, bucket] of Object.entries(spendLedger)) {
        if (day >= cutoffStr) {
          pruned[day] = bucket;
        }
      }
      spendLedger = pruned;
      await mkdir(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(spendLedger, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embedder] spend ledger flush failed (non-fatal): ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chargeTick — increment the shared tick counter + accumulate telemetry.
// Called at the top of every embed function before doing any real work.
// count    = number of embedding units (texts, images, etc.)
// chars    = total character/byte size (0 for binary assets is fine)
// estCostUsd = caller's estimate of the cost of this call
// ---------------------------------------------------------------------------

export function chargeTick(count: number, chars: number, estCostUsd: number): void {
  tickCounter += count;
  if (tickCounter > MAX_EMBEDS_PER_TICK) {
    throw new EmbedQuotaExceededError(
      `Embed quota exceeded: ${tickCounter} > ${MAX_EMBEDS_PER_TICK} per tick. ` +
        `Indexer halted to prevent cost regression. ` +
        `Investigate before resetting MAX_EMBEDS_PER_TICK.`
    );
  }

  telemetryAccumulator.callsThisTick += 1;
  telemetryAccumulator.textsThisTick += count;
  telemetryAccumulator.charsThisTick += chars;
  telemetryAccumulator.estimatedCostUsd += estCostUsd;

  // Cross-tick daily spend circuit breaker.
  // chargeSpendLedger may throw EmbedBudgetExceededError — let it propagate.
  chargeSpendLedger(chars, estCostUsd);
}

// ---------------------------------------------------------------------------
// estimateCostUsd — text cost estimate helper (Gemini text embedding pricing).
//
// The rate is derived from a real invoice, not from the list price. An earlier
// hardcoded $0.000025/1K was 7.6x too low, and a budget alert built on a rate
// that low fires 7.6x too late — which is exactly how an embedding cost spike
// goes unnoticed until the bill arrives.
//
// Derivation: a month of real EmbedContent usage over ~24.3M tokens worked out
// at roughly $0.00019/1K. An invoice-derived rate captures real batching and
// overhead, which is what a budget alert has to be calibrated against.
//
// Override per-environment with GEMINI_EMBED_USD_PER_1K_TOKENS if Google
// changes pricing — no code change needed.
//
// chars/4 ≈ tokens for English.
// ---------------------------------------------------------------------------

export const GEMINI_EMBED_USD_PER_1K_TOKENS = parseFloat(
  process.env.GEMINI_EMBED_USD_PER_1K_TOKENS ?? "0.00019"
);

export function estimateCostUsd(chars: number): number {
  return (chars / 4 / 1000) * GEMINI_EMBED_USD_PER_1K_TOKENS;
}

// ---------------------------------------------------------------------------
// Daily cumulative spend circuit breaker.
//
// Layered on top of (not replacing) the per-tick kill-switch. The per-tick
// kill-switch catches one explosive tick; this catches slow bleed over days.
//
// Ledger file: EMBED_SPEND_LEDGER_PATH (default ~/.the-brain/logs/embed-spend-ledger.json)
//   Shape: { "YYYY-MM-DD": { tokens: number, costUsd: number, calls: number } }
//   UTC day buckets. Loaded once per process, flushed in flushTelemetry().
//
// Soft threshold: EMBED_DAILY_BUDGET_USD (default "5")
//   Crossing logs a warn once per process per day. Does NOT halt.
//
// Hard cap: EMBED_DAILY_HARD_CAP_USD (default "20")
//   Crossing throws EmbedBudgetExceededError. Halts mid-tick loud.
//
// In dry-run mode: still accumulates + checks thresholds (estimated cost
// is real regardless of whether Gemini was called).
// ---------------------------------------------------------------------------

/** Override the ledger path in tests to avoid writing the real file. */
const DEFAULT_LEDGER_PATH = join(homedir(), ".the-brain", "logs", "embed-spend-ledger.json");

export const EMBED_SPEND_LEDGER_PATH: string =
  process.env.EMBED_SPEND_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;

/** Soft daily budget in USD — logs warn on crossing, does NOT halt. Default $5. */
export const EMBED_DAILY_BUDGET_USD = parseFloat(
  process.env.EMBED_DAILY_BUDGET_USD ?? "5"
);

/** Hard daily cap in USD — throws EmbedBudgetExceededError on crossing. Default $20. */
export const EMBED_DAILY_HARD_CAP_USD = parseFloat(
  process.env.EMBED_DAILY_HARD_CAP_USD ?? "20"
);

export class EmbedBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedBudgetExceededError";
  }
}

interface DayBucket {
  tokens: number;
  costUsd: number;
  calls: number;
}

type SpendLedger = Record<string, DayBucket>;

/** In-memory ledger state. Null = not yet loaded. */
let spendLedger: SpendLedger | null = null;

/** Tracks whether the soft-budget warn has already fired today (per process). */
let softBudgetWarnFiredForDay: string | null = null;

/** Resolved ledger path — may differ per test run if EMBED_SPEND_LEDGER_PATH was set. */
let resolvedLedgerPath: string = EMBED_SPEND_LEDGER_PATH;

function getTodayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Load the ledger synchronously (once per process). Missing or corrupt = empty. */
function ensureLedgerLoaded(): void {
  if (spendLedger !== null) return;
  // Re-read the path in case it was overridden via env after module load (test isolation).
  resolvedLedgerPath = process.env.EMBED_SPEND_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
  try {
    const raw = readFileSync(resolvedLedgerPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      spendLedger = parsed as SpendLedger;
    } else {
      spendLedger = {};
    }
  } catch {
    // Missing or corrupt — start empty, no throw.
    spendLedger = {};
  }
}

/** Accumulate a charge into the today bucket and check thresholds. */
function chargeSpendLedger(chars: number, estCostUsd: number): void {
  ensureLedgerLoaded();
  const today = getTodayUTC();
  const bucket = spendLedger![today] ?? { tokens: 0, costUsd: 0, calls: 0 };
  bucket.tokens += Math.round(chars / 4);
  bucket.costUsd += estCostUsd;
  bucket.calls += 1;
  spendLedger![today] = bucket;

  // Hard cap check — throw before accepting the charge if it would cross the cap.
  if (bucket.costUsd >= EMBED_DAILY_HARD_CAP_USD) {
    throw new EmbedBudgetExceededError(
      `Daily embed hard cap exceeded: ${today} cumulative $${bucket.costUsd.toFixed(4)} >= $${EMBED_DAILY_HARD_CAP_USD} cap. ` +
        `Indexer halted to prevent cost regression. ` +
        `Investigate before resetting EMBED_DAILY_HARD_CAP_USD.`
    );
  }

  // Soft threshold check — warn once per process per day.
  if (
    bucket.costUsd >= EMBED_DAILY_BUDGET_USD &&
    softBudgetWarnFiredForDay !== today
  ) {
    softBudgetWarnFiredForDay = today;
    log("warn", "embedder/gate", "daily-soft-budget-crossed", {
      data: {
        day: today,
        costUsd: bucket.costUsd,
        budgetUsd: EMBED_DAILY_BUDGET_USD,
      },
    });
  }
}

/**
 * Reset in-memory ledger state + once-per-day warn flag. For test isolation only.
 * Also re-reads EMBED_SPEND_LEDGER_PATH from env at next ensureLedgerLoaded().
 */
export function resetSpendLedgerForTesting(): void {
  spendLedger = null;
  softBudgetWarnFiredForDay = null;
  resolvedLedgerPath = process.env.EMBED_SPEND_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
}
