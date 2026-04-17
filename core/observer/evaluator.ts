import {
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  MIN_OBSERVATION_GAP_MS,
  type EvaluateParams,
  type EvaluateResult,
} from "./types.js";

/**
 * Pure decision function: should an observation pass fire now?
 *
 * Trigger logic (OR, not AND): fire if ANY of
 *   - messageCount >= messageThreshold
 *   - charCount >= charThreshold
 *   - oldest unobserved message age >= maxAgeMs
 *
 * Blocking conditions (short-circuit, never fire):
 *   - observationInFlight
 *   - gap since last observation < MIN_OBSERVATION_GAP_MS (25 min cooldown)
 *   - no messages
 */
export function evaluateShouldObserve(params: EvaluateParams): EvaluateResult {
  if (params.observationInFlight) {
    return { shouldFire: false, reason: "observation already in flight" };
  }

  const msgThreshold = params.state.observationMessageThreshold ?? 6;
  const charThreshold = params.state.observationCharThreshold ?? 500;
  const maxAgeMs =
    params.state.observationMaxAgeMs ?? DEFAULT_OBSERVATION_MAX_AGE_MS;
  const minGapMs =
    params.state.observationMinGapMs ?? MIN_OBSERVATION_GAP_MS;

  const lastAt = params.state.lastObservationAt
    ? new Date(params.state.lastObservationAt).getTime()
    : 0;
  const gap = params.now - lastAt;

  if (gap < minGapMs) {
    const remainMin = Math.ceil((minGapMs - gap) / 60000);
    return {
      shouldFire: false,
      reason: `cooldown: ${remainMin}m until next observation allowed`,
    };
  }

  if (params.messageCount === 0) {
    return { shouldFire: false, reason: "no messages" };
  }

  const age =
    params.oldestUnobservedTimestamp != null
      ? params.now - params.oldestUnobservedTimestamp
      : 0;

  const msgPassed = params.messageCount >= msgThreshold;
  const charPassed = params.charCount >= charThreshold;
  const agePassed = age >= maxAgeMs;

  if (msgPassed || charPassed || agePassed) {
    const triggers: string[] = [];
    if (msgPassed)
      triggers.push(`msgs=${params.messageCount}/${msgThreshold}`);
    if (charPassed)
      triggers.push(`chars=${params.charCount}/${charThreshold}`);
    if (agePassed) {
      const ageMin = Math.floor(age / 60000);
      const maxAgeMin = Math.floor(maxAgeMs / 60000);
      triggers.push(`age=${ageMin}m/${maxAgeMin}m`);
    }
    return {
      shouldFire: true,
      reason: `triggered: ${triggers.join(" OR ")}`,
    };
  }

  const ageMin = Math.floor(age / 60000);
  const maxAgeMin = Math.floor(maxAgeMs / 60000);
  return {
    shouldFire: false,
    reason: `below thresholds: msgs=${params.messageCount}/${msgThreshold}, chars=${params.charCount}/${charThreshold}, age=${ageMin}m/${maxAgeMin}m`,
  };
}
