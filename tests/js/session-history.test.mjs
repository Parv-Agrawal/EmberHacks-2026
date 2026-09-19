import test from "node:test";
import assert from "node:assert/strict";
import { SessionHistory } from "../../app/static/js/session-history.js";

const image = (value = "AAAA") => `data:image/jpeg;base64,${value}`;
const rep = (number, faults = [], score = faults.length * 10) => ({
  rep_number: number,
  started_at_ms: number * 3000,
  bottom_at_ms: number * 3000 + 1000,
  completed_at_ms: number * 3000 + 2000,
  peak_angle_deg: 95,
  cadence_seconds: 2,
  score,
  faults,
});
const set = (id = "squat-1", reps = [rep(1), rep(2)], extra = {}) => ({
  id,
  exercise: { id: "squat", name: "Squats", reps: 2, rest_seconds: 60 },
  setNumber: 1,
  summary: {
    exercise_id: "squat",
    target_reps: 2,
    completed_reps: reps.length,
    reps,
    detected_faults: [...new Set(reps.flatMap((item) => item.faults))],
  },
  elapsedMs: 7500,
  keyframes: reps.map((item) => ({ rep: item, image: image() })),
  ...extra,
});

test("empty history has no invented volume, effort or replay images", () => {
  const history = new SessionHistory();
  const summary = history.summary();
  assert.equal(summary.totalReps, 0);
  assert.equal(summary.totalSets, 0);
  assert.equal(summary.completedSets, 0);
  assert.equal(summary.activeSeconds, 0);
  assert.equal(summary.averageEffort, null);
  assert.equal(summary.retainedFrames, 0);
  assert.deepEqual(summary.exercises, []);
  assert.match(summary.futureFocus[0], /No completed reps/);
});

test("recorded sets and all returned values are detached from callers", () => {
  const history = new SessionHistory();
  const input = set();
  const output = history.recordSet(input);
  input.summary.reps[0].faults.push("fast_cadence");
  input.exercise.name = "changed";
  input.keyframes[0].image = null;
  output.summary.reps[1].faults.push("fast_cadence");
  output.keyframes[0].image = null;
  const snapshot = history.sets;
  snapshot[0].exercise.name = "also changed";
  snapshot[0].keyframes[0].rep.score = 999;
  const summary = history.summary();
  summary.exercises[0].name = "summary changed";
  summary.futureFocus.push("extra");
  assert.equal(history.sets[0].exercise.name, "Squats");
  assert.equal(history.sets[0].keyframes[0].rep.score, 0);
  assert.equal(history.sets[0].keyframes[0].image, image());
  assert.deepEqual(history.sets[0].summary.reps[0].faults, []);
  assert.deepEqual(history.sets[0].summary.reps[1].faults, []);
  assert.equal(history.summary().exercises[0].name, "Squats");
});

test("upserting a stable id replaces a set without duplicating volume or losing its review", () => {
  const history = new SessionHistory();
  history.recordSet(set("one", [rep(1)]));
  history.updateReview("one", { feedback: "Felt easy", effort: 3 });
  history.recordSet(set("one", [rep(1), rep(2)]));
  assert.equal(history.sets.length, 1);
  assert.equal(history.summary().totalReps, 2);
  assert.equal(history.summary().completedSets, 1);
  assert.equal(history.sets[0].feedback, "Felt easy");
  assert.equal(history.sets[0].effort, 3);
});

test("zero-rep and partial ended sets remain visible without becoming completed sets", () => {
  const history = new SessionHistory();
  history.recordSet(set("empty", [], { elapsedMs: 500, stoppedForPain: true }));
  history.recordSet(set("partial", [rep(1)], { elapsedMs: 2500 }));
  const summary = history.summary();
  assert.equal(summary.totalSets, 2);
  assert.equal(summary.completedSets, 0);
  assert.equal(summary.totalReps, 1);
  assert.equal(summary.activeSeconds, 3);
  assert.equal(summary.exercises[0].sets, 2);
  assert.match(summary.futureFocus[0], /pain report stopped/);
  assert.equal(history.sets[0].keyframes.length, 0);
});

test("volume counts completed telemetry only, never aggregate claims, partial reps or duplicate rep numbers", () => {
  const history = new SessionHistory();
  const input = set();
  input.summary.completed_reps = 12;
  input.summary.reps.push(rep(1), { rep_number: -1 }, null);
  input.keyframes.push({ rep: rep(9), image: image() });
  history.recordSet(input);
  assert.equal(history.summary().totalReps, 2);
  assert.equal(history.sets[0].summary.completed_reps, 2);
  assert.deepEqual(
    history.sets[0].keyframes.map((frame) => frame.rep.rep_number),
    [1, 2],
  );
  input.summary.completed_reps = 1;
  history.recordSet(input);
  assert.equal(history.summary().totalReps, 1);
  assert.equal(history.sets[0].keyframes.length, 1);
});

test("unrelated frame metrics cannot overwrite measured rep metrics and no image is fabricated", () => {
  const history = new SessionHistory();
  history.recordSet(
    set("one", [rep(1), rep(2)], {
      keyframes: [
        { rep: { ...rep(1), score: 999 }, image: image() },
        { rep: rep(2), image: "https://example.com/frame.jpg" },
      ],
    }),
  );
  const frames = history.sets[0].keyframes;
  assert.equal(frames[0].rep.score, 0);
  assert.equal(frames[1].image, null);
  assert.equal(frames[1].imageStatus, "unavailable");
  assert.equal(history.summary().retainedFrames, 1);
});

test("only supplied highlights appear in replay while all completed telemetry remains available", () => {
  const history = new SessionHistory();
  const reps = [rep(1), rep(2, ["shallow_depth"]), rep(3), rep(4)];
  history.recordSet(
    set("one", reps, {
      keyframes: [{ rep: reps[1], image: image() }],
    }),
  );
  assert.equal(history.sets[0].summary.reps.length, 4);
  assert.equal(history.summary().totalReps, 4);
  assert.equal(history.sets[0].keyframes.length, 1);
  assert.equal(history.sets[0].keyframes[0].rep.rep_number, 2);
  history.recordSet(set("none", reps, { keyframes: [] }));
  assert.deepEqual(history.sets[1].keyframes, []);
  const withoutFrames = set("omitted", reps);
  delete withoutFrames.keyframes;
  history.recordSet(withoutFrames);
  assert.deepEqual(history.sets[2].keyframes, []);
  assert.equal(history.summary().totalReps, 12);
});

test("a supplied missing highlight is explicit, unrelated and duplicate records are dropped", () => {
  const history = new SessionHistory();
  history.recordSet(
    set("one", [rep(1), rep(2)], {
      keyframes: [
        { rep: rep(2), image: null },
        { rep: rep(2), image: image() },
        { rep: rep(99), image: image() },
        null,
      ],
    }),
  );
  const frames = history.sets[0].keyframes;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rep.rep_number, 2);
  assert.equal(frames[0].image, null);
  assert.equal(frames[0].imageStatus, "unavailable");
  assert.equal(history.summary().totalReps, 2);
});

test("effort is explicitly reported, range constrained and averaged only over rated sets", () => {
  const history = new SessionHistory();
  for (let number = 1; number <= 3; number++)
    history.recordSet(set(String(number)));
  assert.equal(history.summary().averageEffort, null);
  history.updateReview("1", { effort: 5 });
  history.updateReview("2", { effort: 8 });
  assert.equal(history.summary().averageEffort, 6.5);
  assert.equal(history.summary().effortRatings, 2);
  for (const invalid of [0, 11, "9", 1.5, NaN, Infinity]) {
    history.updateReview("3", { effort: invalid });
    assert.equal(history.sets[2].effort, null);
  }
  history.updateReview("2", { effort: null });
  assert.equal(history.summary().averageEffort, 5);
  assert.equal(history.updateReview("missing", { effort: 2 }), false);
});

test("review updates preserve omitted values and copy coaching and accepted adaptation", () => {
  const history = new SessionHistory();
  history.recordSet(set());
  const coaching = {
    headline: "Two controlled reps.",
    tips: ["One", "Two"],
    encouragement: "Good effort.",
  };
  const adaptation = { kind: "rest", reps: 4, rest_seconds: 90 };
  history.updateReview("squat-1", {
    feedback: "  Felt tired  ",
    effort: 8,
    coaching,
    adaptation,
  });
  coaching.tips.push("changed");
  adaptation.reps = 99;
  history.updateReview("squat-1", { feedback: "Felt easy" });
  const entry = history.sets[0];
  assert.equal(entry.feedback, "Felt easy");
  assert.equal(entry.effort, 8);
  assert.equal(entry.coaching.tips.length, 2);
  assert.equal(entry.adaptation.reps, 4);
  history.updateReview("squat-1", { coaching: null, adaptation: null });
  assert.equal(history.sets[0].coaching, null);
  assert.equal(history.sets[0].adaptation, null);
});

test("form trends compare rates rather than raw counts or user impressions", () => {
  const history = new SessionHistory();
  history.recordSet(set("one", [rep(1, ["shallow_depth"]), rep(2)]));
  history.updateReview("one", { feedback: "Perfect form" });
  history.recordSet(
    set("two", [rep(1), rep(2), rep(3), rep(4, ["shallow_depth"])], {
      setNumber: 2,
    }),
  );
  const exercise = history.summary().exercises[0];
  assert.equal(exercise.reps, 6);
  assert.equal(exercise.flaggedReps, 2);
  assert.match(exercise.formTrend, /decreased from 50% to 25%/);
  assert.match(exercise.focus, /squat-depth/);
  history.recordSet(
    set("two", [rep(1, ["shallow_depth"]), rep(2, ["shallow_depth"])], {
      setNumber: 2,
    }),
  );
  assert.match(
    history.summary().exercises[0].formTrend,
    /increased from 50% to 100%/,
  );
});

test("form trends stay honest for too few sets or sparse measurements", () => {
  const history = new SessionHistory();
  history.recordSet(set("one"));
  assert.match(history.summary().exercises[0].formTrend, /Not enough/);
  history.recordSet(set("two", [rep(1)]));
  assert.match(history.summary().exercises[0].formTrend, /Not enough/);
  history.recordSet(set("two"));
  assert.match(history.summary().exercises[0].formTrend, /stayed at 0%/);
});

test("different exercises retain separate trends and focus, with score-only flags visible", () => {
  const history = new SessionHistory();
  history.recordSet(set("squat"));
  history.recordSet(
    set("curl", [rep(1, [], 15), rep(2, ["fast_cadence"])], {
      exercise: { id: "bicep_curl", name: "Bicep curls" },
    }),
  );
  const summary = history.summary();
  assert.equal(summary.totalReps, 4);
  assert.equal(summary.exercises.length, 2);
  assert.equal(summary.exercises[0].flaggedReps, 0);
  assert.equal(summary.exercises[1].flaggedReps, 2);
  assert.match(summary.exercises[1].focus, /Slow/);
  assert.match(summary.exercises[1].formTrend, /Not enough/);
});

test("future focus labels user reports separately and does not turn negated feedback into claims", () => {
  const history = new SessionHistory();
  history.recordSet(set());
  history.updateReview("squat-1", {
    feedback: "No pain. I was not off balance.",
    effort: 3,
  });
  assert.ok(
    history
      .summary()
      .futureFocus.every(
        (focus) =>
          !/pain report|reported feeling off-balance|8\/10/.test(focus),
      ),
  );
  history.updateReview("squat-1", {
    feedback: "I lost my balance, and my knee hurts",
    effort: 9,
  });
  assert.match(history.summary().futureFocus[0], /reported possible pain/);
  assert.ok(
    history
      .summary()
      .futureFocus.some((focus) =>
        /You reported feeling off-balance/.test(focus),
      ),
  );
  assert.ok(
    history
      .summary()
      .futureFocus.some((focus) =>
        /You rated at least one set 8\/10/.test(focus),
      ),
  );
});

test("frame-count cap discards oldest images across sets but preserves their telemetry", () => {
  const history = new SessionHistory({ maxFrames: 2 });
  history.recordSet(set("one", [rep(1), rep(2)]));
  history.recordSet(set("two", [rep(1), rep(2)]));
  const entries = history.sets;
  assert.ok(
    entries[0].keyframes.every(
      (frame) => frame.image === null && frame.imageStatus === "memory-limit",
    ),
  );
  assert.ok(entries[1].keyframes.every((frame) => frame.image === image()));
  assert.equal(entries[0].keyframes[0].rep.bottom_at_ms, 4000);
  assert.equal(history.summary().retainedFrames, 2);
  assert.equal(history.summary().discardedFrames, 2);
  assert.equal(history.summary().totalReps, 4);
});

test("byte cap includes conservative string storage and evicts a single oversized image", () => {
  const bytes = image().length * 2;
  const history = new SessionHistory({ maxImageBytes: bytes, maxFrames: 10 });
  history.recordSet(set());
  assert.equal(history.sets[0].keyframes[0].image, null);
  assert.equal(history.sets[0].keyframes[1].image, image());
  assert.equal(history.summary().imageBytes, bytes);
  history.recordSet(
    set("large", [rep(1)], {
      keyframes: [{ rep: rep(1), image: image("A".repeat(100)) }],
    }),
  );
  assert.equal(history.summary().retainedFrames, 0);
  assert.equal(history.summary().imageBytes, 0);
  assert.equal(history.summary().totalReps, 3);
});

test("zero image budgets disable image retention while leaving measurements usable", () => {
  for (const options of [{ maxFrames: 0 }, { maxImageBytes: 0 }]) {
    const history = new SessionHistory(options);
    history.recordSet(set());
    assert.equal(history.summary().retainedFrames, 0);
    assert.equal(history.summary().totalReps, 2);
    assert.ok(
      history.sets[0].keyframes.every(
        (frame) => frame.imageStatus === "memory-limit",
      ),
    );
  }
});

test("clear drops stored reviews, telemetry and images and allows a fresh session", () => {
  const history = new SessionHistory();
  history.recordSet(set());
  history.updateReview("squat-1", { feedback: "Felt easy", effort: 2 });
  history.clear();
  assert.deepEqual(history.sets, []);
  assert.equal(history.summary().totalReps, 0);
  assert.equal(history.summary().imageBytes, 0);
  history.recordSet(set());
  assert.equal(history.sets[0].feedback, "");
  assert.equal(history.sets[0].effort, null);
});

test("invalid ids are rejected and invalid elapsed durations cannot corrupt totals", () => {
  const history = new SessionHistory();
  assert.throws(() => history.recordSet(set("")), /stable id/);
  history.recordSet(set("one", [rep(1)], { elapsedMs: NaN }));
  history.recordSet(set("two", [rep(1)], { elapsedMs: -50 }));
  assert.equal(history.summary().activeSeconds, 0);
});

test("missing form telemetry is not silently treated as a clean assessment", () => {
  const history = new SessionHistory();
  history.recordSet(set("one"));
  const incomplete = set("two");
  delete incomplete.summary.reps[0].faults;
  delete incomplete.summary.reps[1].score;
  history.recordSet(incomplete);
  assert.equal(history.summary().totalReps, 4);
  assert.match(history.summary().exercises[0].formTrend, /Not enough/);
  assert.match(
    history.summary().exercises[0].focus,
    /assessment was incomplete/,
  );
  history.recordSet(set("empty", [], { summary: null }));
  assert.equal(history.summary().totalReps, 4);
});
