import { reportsPain } from "./adaptation.js";

const clone = (value) => structuredClone(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value) => (finite(value) ? Math.max(0, value) : 0);
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const cleanText = (value, limit = 500) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const faultsOf = (rep) =>
  Array.isArray(rep?.faults)
    ? [...new Set(rep.faults.filter((fault) => cleanText(fault)))].map(
        (fault) => cleanText(fault, 80),
      )
    : [];
const isFlagged = (rep) =>
  faultsOf(rep).length > 0 || (finite(rep?.score) && rep.score >= 10);
const hasFormEvidence = (rep) =>
  rep.formAssessmentAvailable !== false &&
  Array.isArray(rep.faults) &&
  rep.faults.every((fault) => cleanText(fault)) &&
  finite(rep.score) &&
  rep.score >= 0;
const imageBytes = (image) =>
  typeof image === "string" ? image.length * 2 : 0;
const jpeg = (image) =>
  typeof image === "string" &&
  /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    ? image
    : null;
const budget = (value, fallback) =>
  finite(value) && value >= 0 ? Math.floor(value) : fallback;

function measuredSummary(summary = {}) {
  summary = summary && typeof summary === "object" ? summary : {};
  const seen = new Set();
  const reps = (Array.isArray(summary.reps) ? summary.reps : []).filter(
    (rep) => {
      if (!positiveInteger(rep?.rep_number) || seen.has(rep.rep_number))
        return false;
      seen.add(rep.rep_number);
      return true;
    },
  );
  // A count without its corresponding completed-rep telemetry is not evidence.
  const completed = Math.min(
    Number.isInteger(summary.completed_reps)
      ? Math.max(0, summary.completed_reps)
      : 0,
    reps.length,
  );
  const measured = reps.slice(0, completed).map((rep) => ({
    ...clone(rep),
    faults: faultsOf(rep),
    formAssessmentAvailable: hasFormEvidence(rep),
  }));
  return {
    exercise_id: cleanText(summary.exercise_id, 80),
    target_reps: positiveInteger(summary.target_reps) ? summary.target_reps : 0,
    completed_reps: measured.length,
    reps: measured,
    detected_faults: [...new Set(measured.flatMap((rep) => rep.faults))],
  };
}

function trend(sets) {
  const measured = sets.filter((set) => set.summary.completed_reps > 0);
  const first = measured[0];
  const last = measured.at(-1);
  if (
    measured.length < 2 ||
    first.summary.completed_reps < 2 ||
    last.summary.completed_reps < 2 ||
    !first.summary.reps.every(hasFormEvidence) ||
    !last.summary.reps.every(hasFormEvidence)
  )
    return "Not enough measured sets to compare.";
  const rate = (set) =>
    set.summary.reps.filter(isFlagged).length / set.summary.completed_reps;
  const early = rate(first);
  const late = rate(last);
  const direction =
    late < early ? "decreased" : late > early ? "increased" : "stayed";
  return direction === "stayed"
    ? `Flagged-rep rate stayed at ${Math.round(early * 100)}% across the first and last measured sets.`
    : `Flagged-rep rate ${direction} from ${Math.round(early * 100)}% to ${Math.round(late * 100)}% across the first and last measured sets.`;
}

const FOCUS = Object.freeze({
  shallow_depth:
    "Review the flagged squat-depth estimates and keep the next reps controlled.",
  limited_curl_range:
    "Review the flagged curl-range estimates and use a controlled range you can repeat.",
  uneven_range:
    "Review the left/right range estimates and aim for an even movement.",
  fast_cadence:
    "Slow the next reps down and keep the lowering phase controlled.",
  valgus_knee_collapse:
    "Review the flagged knee-path estimates and keep knees tracking over toes.",
});

function movementFocus(reps) {
  if (!reps.length) return "No completed reps were measured for this exercise.";
  const counts = new Map();
  for (const rep of reps)
    for (const fault of faultsOf(rep))
      counts.set(fault, (counts.get(fault) || 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (common)
    return FOCUS[common] || "Review the flagged reps before the next workout.";
  if (reps.some(isFlagged))
    return "Review the flagged movement estimates before the next workout.";
  if (!reps.every(hasFormEvidence))
    return "Form assessment was incomplete. Recheck joint visibility before the next set.";
  return "No form flags were measured; keep the same controlled movement focus.";
}

function reportsBalance(feedback) {
  return feedback
    .toLowerCase()
    .split(/[.!?,;]|\b(?:but|however|yet)\b/)
    .some((clause) => {
      const match =
        /\b(?:off[-\s]balance|unbalanced|lost (?:my )?balance|wobbly|unstable)\b/.exec(
          clause,
        );
      return (
        match &&
        !/\b(?:not|never|no|wasn't|isn't)(?:\s+(?:very|at all|feeling)){0,2}\s*$/.test(
          clause.slice(0, match.index),
        )
      );
    });
}

/** Session-only telemetry and inflection stills. No storage or network access. */
export class SessionHistory {
  #sets = [];

  constructor({ maxImageBytes = 8 * 1024 * 1024, maxFrames = 40 } = {}) {
    this.maxImageBytes = budget(maxImageBytes, 8 * 1024 * 1024);
    this.maxFrames = budget(maxFrames, 40);
  }

  get sets() {
    return clone(this.#sets);
  }

  recordSet({
    id,
    exercise = {},
    setNumber = 1,
    summary = {},
    elapsedMs = 0,
    keyframes,
    stoppedForPain = false,
  }) {
    if (!cleanText(id, 120))
      throw new TypeError("A session set needs a stable id.");
    const index = this.#sets.findIndex((set) => set.id === id);
    const previous = this.#sets[index];
    const measured = measuredSummary(summary);
    const frames = Array.isArray(keyframes)
      ? keyframes
      : previous?.keyframes || [];
    const seenFrames = new Set();
    const highlights = frames.flatMap((frame) => {
      const rep = measured.reps.find(
        (candidate) => candidate.rep_number === frame?.rep?.rep_number,
      );
      if (!rep || seenFrames.has(rep.rep_number)) return [];
      seenFrames.add(rep.rep_number);
      const image = jpeg(frame.image);
      return [
        {
          rep: clone(rep),
          image,
          imageStatus: image
            ? "available"
            : frame.imageStatus === "memory-limit"
              ? "memory-limit"
              : "unavailable",
        },
      ];
    });
    const entry = {
      id,
      exercise: {
        ...clone(exercise),
        id: cleanText(exercise.id, 80) || measured.exercise_id || "unknown",
        name: cleanText(exercise.name, 120) || "Exercise",
      },
      setNumber: positiveInteger(setNumber) ? setNumber : 1,
      summary: measured,
      elapsedMs: nonnegative(elapsedMs),
      stoppedForPain: Boolean(stoppedForPain),
      keyframes: highlights,
      feedback: previous?.feedback || "",
      effort: previous?.effort ?? null,
      coaching: previous?.coaching ?? null,
      adaptation: previous?.adaptation ?? null,
    };
    if (index < 0) this.#sets.push(entry);
    else this.#sets[index] = entry;
    this.#trimImages();
    return clone(entry);
  }

  updateReview(id, changes = {}) {
    const entry = this.#sets.find((set) => set.id === id);
    if (!entry) return false;
    if (Object.hasOwn(changes, "feedback"))
      entry.feedback = cleanText(changes.feedback);
    if (Object.hasOwn(changes, "effort"))
      entry.effort =
        Number.isInteger(changes.effort) &&
        changes.effort >= 1 &&
        changes.effort <= 10
          ? changes.effort
          : null;
    for (const field of ["coaching", "adaptation"])
      if (Object.hasOwn(changes, field))
        entry[field] =
          changes[field] && typeof changes[field] === "object"
            ? clone(changes[field])
            : null;
    return true;
  }

  #trimImages() {
    const frames = this.#sets
      .flatMap((set) => set.keyframes)
      .filter((frame) => frame.image);
    let bytes = frames.reduce((sum, frame) => sum + imageBytes(frame.image), 0);
    let count = frames.length;
    for (const frame of frames) {
      if (count <= this.maxFrames && bytes <= this.maxImageBytes) break;
      bytes -= imageBytes(frame.image);
      count -= 1;
      frame.image = null;
      frame.imageStatus = "memory-limit";
    }
  }

  summary() {
    const groups = new Map();
    for (const set of this.#sets) {
      const key = set.exercise.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(set);
    }
    const exercises = [...groups].map(([id, sets]) => {
      const reps = sets.flatMap((set) => set.summary.reps);
      return {
        id,
        name: sets[0].exercise.name,
        reps: reps.length,
        sets: sets.length,
        flaggedReps: reps.filter(isFlagged).length,
        formTrend: trend(sets),
        focus: movementFocus(reps),
      };
    });
    const effort = this.#sets
      .map((set) => set.effort)
      .filter((rating) => rating !== null);
    const futureFocus = [];
    if (this.#sets.some((set) => set.stoppedForPain))
      futureFocus.push(
        "A pain report stopped an exercise. Review your movements-to-avoid preference before planning another workout.",
      );
    else if (this.#sets.some((set) => reportsPain(set.feedback)))
      futureFocus.push(
        "You reported possible pain. Review your movements-to-avoid preference before planning another workout.",
      );
    if (this.#sets.some((set) => reportsBalance(set.feedback)))
      futureFocus.push(
        "You reported feeling off-balance. Recheck your stance and setup before the next set.",
      );
    if (effort.some((rating) => rating >= 8))
      futureFocus.push(
        "You rated at least one set 8/10 or higher. Review the planned reps and rest before your next workout.",
      );
    for (const exercise of exercises)
      if (exercise.reps > 0)
        futureFocus.push(`${exercise.name}: ${exercise.focus}`);
    if (!futureFocus.length)
      futureFocus.push(
        "No completed reps were measured. Recheck camera framing before your next set.",
      );
    const frames = this.#sets.flatMap((set) => set.keyframes);
    return {
      totalReps: exercises.reduce((sum, exercise) => sum + exercise.reps, 0),
      totalSets: this.#sets.length,
      completedSets: this.#sets.filter(
        (set) =>
          set.summary.target_reps > 0 &&
          set.summary.completed_reps >= set.summary.target_reps,
      ).length,
      activeSeconds: Math.round(
        this.#sets.reduce((sum, set) => sum + set.elapsedMs, 0) / 1000,
      ),
      averageEffort: effort.length
        ? Math.round(
            (effort.reduce((sum, rating) => sum + rating, 0) / effort.length) *
              10,
          ) / 10
        : null,
      effortRatings: effort.length,
      retainedFrames: frames.filter((frame) => frame.image).length,
      discardedFrames: frames.filter(
        (frame) => frame.imageStatus === "memory-limit",
      ).length,
      imageBytes: frames.reduce(
        (sum, frame) => sum + imageBytes(frame.image),
        0,
      ),
      exercises,
      futureFocus,
    };
  }

  clear() {
    this.#sets = [];
  }
}
