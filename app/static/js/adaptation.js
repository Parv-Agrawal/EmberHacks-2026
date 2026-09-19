const LIMITS = Object.freeze({
  minReps: 4,
  maxReps: 15,
  minRest: 30,
  maxRest: 120,
});
const clamp = (number, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, Math.round(number)));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const normalized = (value) =>
  typeof value === "string" ? value.toLowerCase().replace(/[’‘]/g, "'") : "";

/**
 * A local stop signal, not a diagnosis. Uncertain or mixed reports of pain stop
 * the exercise; clear negations alone do not. Never wait for an AI response.
 */
export function reportsPain(value) {
  const input = normalized(value);
  const clauses = input.split(/[.!?,;]|\b(?:but|however|yet|now)\b/);
  for (const clause of clauses) {
    let negatedThrough = null;
    const mentions = clause.matchAll(
      /\b(?:pain(?:ful)?|hurt(?:s|ing)?|ach(?:e|es|ing)|headaches?|backaches?)\b/g,
    );
    for (const mention of mentions) {
      const before = clause.slice(0, mention.index);
      const after = clause.slice(mention.index + mention[0].length);
      // "Not sure whether it is pain" must not become a reassuring negation.
      if (
        /\b(?:not sure|unsure|uncertain|maybe|perhaps|might|could)\b/.test(
          before,
        )
      )
        return true;
      if (mention[0] === "pain" && /^[-\s]free\b/.test(after)) {
        if (/\b(?:no|not|never|isn't|aren't|wasn't)\s*$/.test(before))
          return true;
        continue;
      }
      const continuedNegation =
        negatedThrough !== null &&
        /^\s+or\s+(?:(?:any|new|sharp|joint|knee|elbow|shoulder|back|muscle)\s+)*$/.test(
          clause.slice(negatedThrough, mention.index),
        );
      const explicitlyAbsent =
        /\b(?:no|without)(?:\s+(?:any|more|new|sharp|joint|knee|elbow|shoulder|back|muscle)){0,3}\s*$/.test(
          before,
        ) ||
        /\bno longer\s*$/.test(before) ||
        /\b(?:not|isn't|aren't|wasn't|weren't)(?:\s+(?:in|any|feeling|having|experiencing|currently|at all)){0,3}\s*$/.test(
          before,
        ) ||
        /\b(?:don't|doesn't|didn't|do not|does not|did not|never)(?:\s+(?:have|feel|experience|any|currently|really)){0,3}\s*$/.test(
          before,
        ) ||
        /^\s+(?:is|has)\s+(?:completely\s+)?(?:gone|resolved|stopped)\b/.test(
          after,
        ) ||
        continuedNegation;
      if (!explicitlyAbsent || /^\s+until\b/.test(after)) return true;
      negatedThrough = mention.index + mention[0].length;
    }
  }
  return false;
}

function reportedSignals(value) {
  // Split contrast clauses so "not tired, but off balance" retains the latter.
  const clauses = normalized(value).split(/[.!?,;]|\b(?:but|however|yet)\b/);
  const signals = { easy: false, fatigue: false, balance: false };
  const patterns = {
    easy: /\b(?:easy|easier|effortless|too light)\b/g,
    fatigue:
      /\b(?:fatigue(?:d)?|tired|exhausted|hard|difficult|struggl(?:e|ed|ing)|more rest|out of breath)\b/g,
    balance:
      /\b(?:off[-\s]balance|unbalanced|lost (?:my )?balance|wobbl(?:y|ing|ed)|unstable)\b/g,
  };
  for (const clause of clauses) {
    for (const [name, pattern] of Object.entries(patterns)) {
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        if (
          !/\b(?:not|never|no|wasn't|isn't)(?:\s+(?:very|at all|feeling)){0,2}\s*$/.test(
            before,
          )
        )
          signals[name] = true;
      }
    }
  }
  return signals;
}

const faultsOf = (rep) =>
  Array.isArray(rep?.faults)
    ? rep.faults.filter((fault) => typeof fault === "string" && fault.trim())
    : [];
const mean = (numbers) =>
  numbers.length
    ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
    : 0;

function evidenceFrom(summary, completed) {
  const raw = Array.isArray(summary?.reps) ? summary.reps : [];
  const reps = raw
    .slice(0, completed)
    .filter((rep) => rep && typeof rep === "object");
  const aggregateValid =
    summary?.detected_faults === undefined ||
    (Array.isArray(summary.detected_faults) &&
      summary.detected_faults.every(
        (fault) => typeof fault === "string" && fault.trim(),
      ));
  const reliable =
    aggregateValid &&
    raw.length === completed &&
    reps.length === completed &&
    reps.every(
      (rep) =>
        Array.isArray(rep.faults) &&
        rep.faults.every(
          (fault) => typeof fault === "string" && fault.trim(),
        ) &&
        finite(rep.score) &&
        rep.score >= 0,
    );
  const flagged = (rep) =>
    faultsOf(rep).length > 0 || (finite(rep.score) && rep.score >= 10);
  const flaggedCount = reps.filter(flagged).length;
  const aggregateFaults = faultsOf({ faults: summary?.detected_faults });
  const anyFaults =
    flaggedCount > 0 ||
    aggregateFaults.length > 0 ||
    reps.some(
      (rep) => faultsOf(rep).length || (finite(rep.score) && rep.score > 0),
    );
  let deteriorating = false;
  if (reps.length >= 4) {
    const split = Math.floor(reps.length / 2);
    const early = reps.slice(0, split);
    const late = reps.slice(split);
    const earlyRate = early.filter(flagged).length / early.length;
    const lateRate = late.filter(flagged).length / late.length;
    const comparableScores = reps.every(
      (rep) => finite(rep.score) && rep.score >= 0,
    );
    deteriorating =
      (late.filter(flagged).length >= 2 && lateRate - earlyRate >= 0.25) ||
      (comparableScores &&
        mean(late.map((rep) => rep.score)) -
          mean(early.map((rep) => rep.score)) >=
          10);
  }
  return {
    reliable,
    flaggedCount,
    anyFaults,
    deteriorating,
    frequent: reps.length > 0 && flaggedCount / reps.length >= 0.4,
  };
}

/**
 * A deterministic proposal for the next set of this exercise. The caller must
 * request acceptance before updating the confirmed plan. No image, network, or
 * model output is consulted. Phase 2 scores are penalties: higher means worse.
 */
export function proposeNextSet(options = {}) {
  const { summary, userFeedback, exercise } = options ?? {};
  const reps = clamp(
    finite(exercise?.reps) ? exercise.reps : 8,
    LIMITS.minReps,
    LIMITS.maxReps,
  );
  const rest = clamp(
    finite(exercise?.rest_seconds) ? exercise.rest_seconds : 60,
    LIMITS.minRest,
    LIMITS.maxRest,
  );
  const proposal = (kind, nextReps, nextRest, reason) => ({
    kind,
    reps: clamp(nextReps, LIMITS.minReps, LIMITS.maxReps),
    rest_seconds: clamp(nextRest, LIMITS.minRest, LIMITS.maxRest),
    reason,
  });
  if (reportsPain(userFeedback))
    return proposal(
      "stop",
      reps,
      rest,
      "You reported possible pain. Stop this exercise; no next set will be started.",
    );

  if (
    !Number.isInteger(exercise?.reps) ||
    exercise.reps < LIMITS.minReps ||
    exercise.reps > LIMITS.maxReps ||
    !Number.isInteger(exercise?.rest_seconds) ||
    exercise.rest_seconds < LIMITS.minRest ||
    exercise.rest_seconds > LIMITS.maxRest
  )
    return proposal(
      "keep",
      reps,
      rest,
      "The confirmed set plan is unavailable. Confirm reps and rest in your workout plan before continuing.",
    );

  const completed =
    Number.isInteger(summary?.completed_reps) && summary.completed_reps > 0
      ? Math.min(summary.completed_reps, 100)
      : 0;
  if (!completed)
    return proposal(
      "keep",
      reps,
      rest,
      "No completed reps were measured. Keep the confirmed plan; there is not enough movement evidence to increase it.",
    );

  const signals = reportedSignals(userFeedback);
  const evidence = evidenceFrom(summary, completed);
  const reduced = Math.max(LIMITS.minReps, reps - 2);
  const moreRest = Math.min(LIMITS.maxRest, rest + 30);
  if (signals.balance)
    return proposal(
      "reduce",
      reduced,
      moreRest,
      `You reported feeling off-balance. Try ${reduced} reps after ${moreRest} seconds of rest, and recheck your stance before starting.`,
    );

  if (evidence.deteriorating || evidence.frequent) {
    const report = signals.fatigue
      ? "You reported fatigue. "
      : signals.easy
        ? "You reported that the set felt easy. "
        : "";
    const measured = evidence.deteriorating
      ? "Movement estimates worsened in the later reps."
      : `Movement estimates flagged ${evidence.flaggedCount} of ${completed} completed reps.`;
    return proposal(
      "reduce",
      reduced,
      moreRest,
      `${report}${measured} Try ${reduced} reps with ${moreRest} seconds of rest.`,
    );
  }
  if (signals.fatigue)
    return proposal(
      "rest",
      reps,
      moreRest,
      `You reported fatigue or needing more rest. Keep ${reps} reps and allow ${moreRest} seconds of rest before deciding whether to continue.`,
    );

  const target =
    Number.isInteger(summary?.target_reps) && summary.target_reps > 0
      ? summary.target_reps
      : reps;
  const clean = evidence.reliable && !evidence.anyFaults && completed >= target;
  if (signals.easy && clean && reps < LIMITS.maxReps)
    return proposal(
      "increase",
      reps + 1,
      rest,
      `You reported that the set felt easy. All ${completed} measured reps had no form flags; try ${reps + 1} reps while keeping ${rest} seconds of rest.`,
    );

  const report = signals.easy ? "You reported that the set felt easy. " : "";
  const reason = !evidence.reliable
    ? "Movement evidence is incomplete; keep the confirmed reps and rest."
    : evidence.anyFaults
      ? "Movement estimates included form flags; keep the confirmed reps and rest and focus on control."
      : completed < target
        ? `Only ${completed} of ${target} planned reps were measured; keep the confirmed reps and rest.`
        : "Keep the confirmed reps and rest; no increase is needed.";
  return proposal("keep", reps, rest, report + reason);
}
