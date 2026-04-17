export const MIN_OBSERVATION_GAP_MS = 25 * 60 * 1000;
export const DEFAULT_OBSERVATION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const MAX_OBSERVATION_MESSAGES = 50;
export const SESSION_CHECK_INTERVAL = 10;

export interface Pointer {
  sessionKey: string;
  sessionId: string;
  transcriptPath: string;
  lastObservedOffset: number;
  lastObservedTimestamp: string | null;
  messagesSinceLastObservation: number;
  charsSinceLastObservation: number;
}

export interface ObserverState {
  lastObservationAt?: string | null;
  observationMessageThreshold?: number;
  observationCharThreshold?: number;
  observationMaxAgeMs?: number;
  reflectionTriggerThreshold?: number;
  reflectionCharThreshold?: number;
  unprocessedObservationCount?: number;
  unprocessedObservationChars?: number;
}

export interface EvaluateParams {
  messageCount: number;
  charCount: number;
  oldestUnobservedTimestamp: number | null;
  state: ObserverState;
  now: number;
  observationInFlight: boolean;
}

export interface EvaluateResult {
  shouldFire: boolean;
  reason: string;
}

export interface TranscriptMessage {
  role: string;
  content: string;
  timestamp: string;
}
