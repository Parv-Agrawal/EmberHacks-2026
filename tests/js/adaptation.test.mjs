import test from "node:test";
import assert from "node:assert/strict";
import { reportsPain, proposeNextSet } from "../../app/static/js/adaptation.js";

const exercise = { id: "squat", reps: 8, rest_seconds: 60 };
const summary = (scores = Array(8).fill(0)) => ({
  exercise_id: "squat",
  target_reps: 8,
  completed_reps: scores.length,
  reps: scores.map((score, index) => ({
    rep_number: index + 1,
    score,
    faults: score ? ["shallow_depth"] : [],
  })),
  detected_faults: scores.some(Boolean) ? ["shallow_depth"] : [],
});
const propose = (userFeedback, set = summary(), plan = exercise) =>
  proposeNextSet({ summary: set, userFeedback, exercise: plan });

test("pain and uncertain pain stop locally before evidence or easy feedback can increase work", () => {
  for (const feedback of [
    "My knee hurts",
    "Sharp pain on rep 4",
    "My elbow is aching",
    "Felt easy but my back hurt",
    "I am not sure whether this is pain",
    "Maybe pain?",
    "not much pain",
    "not pain-free",
    "No pain before, now my knee hurts",
    "No pain, but my shoulder aches",
    "I didn't have pain until rep 4",
    "No pain-free reps today",
  ]) {
    assert.equal(reportsPain(feedback), true, feedback);
    assert.equal(propose(feedback).kind, "stop", feedback);
    assert.equal(propose(feedback, null).kind, "stop", feedback);
  }
});

test("clear pain negations do not stop an otherwise pain-free exercise", () => {
  for (const feedback of [
    "No pain",
    "Not painful",
    "Pain-free",
    "I am pain free",
    "My knee doesn't hurt",
    "I don't have any pain",
    "I'm not in pain",
    "Without sharp pain",
    "No pain, no aches",
    "My knee no longer hurts",
    "The pain is gone",
    "No pain; felt easy",
    "Tired but no pain",
    "I do not have any pain",
    "No pain or aches",
    "No aches or sharp pain",
  ])
    assert.equal(reportsPain(feedback), false, feedback);
  for (const feedback of [
    null,
    {},
    1,
    "",
    "I strained to finish",
    "I feel good",
  ])
    assert.equal(reportsPain(feedback), false);
});

test("identical measured movement adapts differently to easy, fatigue, and balance feedback", () => {
  const easy = propose("Felt easy");
  const tired = propose("I felt tired");
  const balance = propose("Felt off-balance on rep 4");
  assert.deepEqual(
    [easy.kind, easy.reps, easy.rest_seconds],
    ["increase", 9, 60],
  );
  assert.deepEqual(
    [tired.kind, tired.reps, tired.rest_seconds],
    ["rest", 8, 90],
  );
  assert.deepEqual(
    [balance.kind, balance.reps, balance.rest_seconds],
    ["reduce", 6, 90],
  );
  assert.match(easy.reason, /You reported.*All 8 measured reps/);
  assert.match(tired.reason, /^You reported/);
  assert.match(balance.reason, /^You reported/);
});

test("fatigue or instability overrides an easy report and negated impressions are ignored", () => {
  assert.equal(propose("Easy but exhausted").kind, "rest");
  assert.equal(propose("Easy but I lost my balance").kind, "reduce");
  assert.equal(propose("Not easy").kind, "keep");
  assert.equal(propose("Not tired; felt easy").kind, "increase");
  assert.equal(propose("Not off balance but tired").kind, "rest");
});

test("frequent form flags and deterioration override easy feedback", () => {
  const frequent = propose("Felt easy", summary([20, 0, 20, 0, 20, 0, 20, 0]));
  assert.equal(frequent.kind, "reduce");
  assert.match(
    frequent.reason,
    /You reported.*Movement estimates flagged 4 of 8/,
  );
  const deteriorating = propose(
    "Felt easy",
    summary([0, 0, 0, 0, 0, 0, 20, 20]),
  );
  assert.equal(deteriorating.kind, "reduce");
  assert.match(deteriorating.reason, /later reps/);
  const isolated = propose("Felt easy", summary([0, 20, 0, 0, 0, 0, 0, 0]));
  assert.equal(isolated.kind, "keep");
});

test("score deterioration works even if a fault label was omitted", () => {
  const set = summary([0, 0, 0, 0, 20, 20, 20, 20]);
  set.reps.forEach((rep) => {
    rep.faults = [];
  });
  set.detected_faults = [];
  assert.equal(propose("Easy", set).kind, "reduce");
});

test("aggregate form flags and short sets cannot qualify for an increase", () => {
  const set = summary();
  set.detected_faults = ["uneven_range"];
  assert.equal(propose("Easy", set).kind, "keep");
  assert.equal(propose("Easy", summary([0, 0, 0, 0])).kind, "keep");
});

test("missing, inconsistent, and malformed evidence never produces a workload increase", () => {
  for (const set of [
    undefined,
    null,
    {},
    { completed_reps: 0, reps: [] },
    { completed_reps: 8 },
    { ...summary(), completed_reps: 0 },
    { ...summary(), completed_reps: 9 },
    { ...summary(), reps: [null, {}, "bad"] },
    {
      ...summary(),
      reps: summary().reps.map((rep) => ({ ...rep, score: NaN })),
    },
    {
      ...summary(),
      reps: summary().reps.map((rep) => ({ ...rep, faults: [null] })),
    },
    { ...summary(), detected_faults: "shallow_depth" },
    { ...summary(), completed_reps: Infinity },
    { ...summary(), completed_reps: "8" },
  ])
    assert.equal(
      proposeNextSet({ summary: set, userFeedback: "Easy", exercise }).kind,
      "keep",
      JSON.stringify(set),
    );
  assert.equal(propose("Easy and tired", { completed_reps: 0 }).kind, "keep");
  assert.equal(
    proposeNextSet({ summary: summary(), userFeedback: "Easy" }).kind,
    "keep",
  );
});

test("proposals stay within rep and rest bounds and use the confirmed exercise plan", () => {
  for (const reps of [-10, 4, 8, 15, 100, NaN, Infinity]) {
    for (const rest_seconds of [-10, 30, 60, 120, 1000, NaN, Infinity]) {
      for (const feedback of [
        "Easy",
        "Tired",
        "Off-balance",
        "My knee hurts",
        "Fine",
      ]) {
        const proposal = propose(feedback, summary(), { reps, rest_seconds });
        assert.ok(Number.isInteger(proposal.reps));
        assert.ok(proposal.reps >= 4 && proposal.reps <= 15);
        assert.ok(Number.isInteger(proposal.rest_seconds));
        assert.ok(proposal.rest_seconds >= 30 && proposal.rest_seconds <= 120);
      }
    }
  }
  assert.equal(
    propose("Fine", summary(), { reps: 12, rest_seconds: 45 }).reps,
    12,
  );
  assert.equal(
    propose(
      "Easy",
      { ...summary(), target_reps: 8 },
      { reps: 15, rest_seconds: 60 },
    ).kind,
    "keep",
  );
});

test("adaptation is pure and does not depend on model results or an available keyframe", () => {
  const set = summary();
  const plan = { ...exercise };
  const original = structuredClone({ set, plan });
  const expected = propose("Tired", set, plan);
  set.keyframe_image = null;
  set.coach_status = "unavailable";
  assert.deepEqual(propose("Tired", set, plan), expected);
  delete set.keyframe_image;
  delete set.coach_status;
  assert.deepEqual({ set, plan }, original);
  assert.equal(proposeNextSet().kind, "keep");
  assert.equal(proposeNextSet(null).kind, "keep");
});
