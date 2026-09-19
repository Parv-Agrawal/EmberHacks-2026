import test from "node:test";
import assert from "node:assert/strict";
import { jointAngle, MovementTracker } from "../../app/static/js/movement.js";

const visibleBody = () =>
  Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    visibility: 0.95,
    presence: 0.95,
  }));

// Construct true 3D joint angles independently of their image projections.
function worldPose(exerciseId, leftAngle, rightAngle = leftAngle) {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const triples =
    exerciseId === "squat"
      ? [
          [23, 25, 27],
          [24, 26, 28],
        ]
      : [
          [11, 13, 15],
          [12, 14, 16],
        ];
  triples.forEach(([a, b, c], side) => {
    const radians = ((side ? rightAngle : leftAngle) * Math.PI) / 180;
    points[a] = { x: side, y: 1, z: 0 };
    points[b] = { x: side, y: 0, z: 0 };
    points[c] = { x: side, y: Math.cos(radians), z: Math.sin(radians) };
  });
  return points;
}

function fixture(exerciseId = "squat", targetReps = 3) {
  const tracker = new MovementTracker({ exerciseId, targetReps });
  let time = 0;
  const states = [];
  const sample = (angle, options = {}) => {
    const now = options.now ?? time;
    const state = tracker.update({
      now,
      capturedAt: options.capturedAt ?? now,
      landmarks: options.landmarks ?? visibleBody(),
      worldLandmarks: Object.hasOwn(options, "worldLandmarks")
        ? options.worldLandmarks
        : worldPose(exerciseId, angle, options.rightAngle ?? angle),
    });
    time = now + 100;
    states.push(state);
    return state;
  };
  const feed = (angles) => angles.map((angle) => sample(angle));
  const arm = () => feed([175, 175, 175, 175, 175]);
  const rep = (bottom = exerciseId === "squat" ? 90 : 50) =>
    feed([
      165,
      150,
      138,
      130,
      120,
      110,
      bottom,
      bottom,
      bottom,
      bottom,
      bottom + 4,
      bottom + 12,
      bottom + 22,
      125,
      145,
      165,
      175,
      175,
      175,
    ]);
  return { tracker, sample, feed, arm, rep, states };
}

test("3D angles are exact across orientation; degenerate/missing geometry is rejected", () => {
  assert.equal(
    jointAngle(
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ),
    90,
  );
  assert.equal(
    jointAngle(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ),
    90,
  );
  assert.equal(
    jointAngle(
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: -1, z: 0 },
    ),
    180,
  );
  assert.equal(jointAngle(undefined, {}, {}), null);
  assert.equal(
    jointAngle(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ),
    null,
  );
});

for (const exerciseId of ["squat", "bicep_curl"]) {
  test(`${exerciseId}: complete multi-state reps, inflection capture, measured metadata, target cap`, () => {
    const f = fixture(exerciseId, 2);
    f.arm();
    const states = f.rep();
    const phases = [...new Set(states.map((state) => state.phase))];
    assert.deepEqual(
      phases,
      exerciseId === "squat"
        ? ["start", "eccentric", "bottom", "concentric", "completion"]
        : ["start", "concentric", "inflection", "eccentric", "completion"],
    );
    const completion = states.find((state) => state.completedRep);
    assert.equal(completion.repCount, 1);
    assert.equal(completion.done, false);
    const rep = completion.completedRep;
    assert.equal(rep.rep_number, 1);
    assert.equal(rep.peak_angle_deg, exerciseId === "squat" ? 90 : 50);
    assert.equal(rep.score, 0);
    assert.deepEqual(rep.faults, []);
    assert.ok(rep.started_at_ms < rep.bottom_at_ms);
    assert.ok(rep.bottom_at_ms < rep.completed_at_ms);
    assert.equal(
      rep.cadence_seconds,
      (rep.completed_at_ms - rep.started_at_ms) / 1000,
    );
    const candidates = states.filter((state) => state.captureCandidate);
    assert.ok(candidates.length >= 2);
    assert.equal(
      candidates.at(-1).angle,
      rep.peak_angle_deg,
      "the retained candidate corresponds to the actual minimum angle",
    );
    f.rep();
    assert.equal(f.states.at(-1).done, true);
    f.rep();
    assert.equal(f.tracker.summary().completed_reps, 2);
    assert.equal(f.tracker.summary().reps.length, 2);
    assert.equal(f.states.at(-1).completedRep, null);
  });

  test(`${exerciseId}: starting at flexion, jitter, and standing still never fabricate reps`, () => {
    const f = fixture(exerciseId);
    f.feed([60, 65, 90, 120, 160, 175, 175]);
    assert.equal(f.tracker.summary().completed_reps, 0);
    f.arm();
    for (let index = 0; index < 8; index++) f.feed([170, 149, 151, 170]);
    assert.equal(f.tracker.summary().completed_reps, 0);
    assert.equal(
      f.states.some((state) => state.captureCandidate),
      false,
    );
  });

  test(`${exerciseId}: requires both sides, never treating a one-sided action as a bilateral rep`, () => {
    const f = fixture(exerciseId);
    f.arm();
    for (const angle of [130, 100, 60, 50, 60, 100, 130, 170, 175, 175])
      f.sample(angle, { rightAngle: 175 });
    assert.equal(f.tracker.summary().completed_reps, 0);
  });
}

test("shallow squats count with an explicit fault and worse score than full range", () => {
  const f = fixture();
  f.arm();
  f.rep();
  const states = f.feed([
    165, 150, 140, 138, 135, 128, 128, 128, 128, 128, 130, 140, 145, 150, 165,
    175, 175, 175,
  ]);
  const shallow = states.find((state) => state.completedRep)?.completedRep;
  assert.ok(shallow);
  assert.equal(shallow.peak_angle_deg, 128);
  assert.deepEqual(shallow.faults, ["shallow_depth"]);
  assert.ok(shallow.score > f.tracker.summary().reps[0].score);
  assert.deepEqual(f.tracker.summary().detected_faults, ["shallow_depth"]);
});

test("curls report limited range without inventing knee or medical faults", () => {
  const f = fixture("bicep_curl");
  f.arm();
  const states = f.rep(95);
  const rep = states.find((state) => state.completedRep)?.completedRep;
  assert.ok(rep);
  assert.deepEqual(rep.faults, ["limited_curl_range"]);
  assert.equal(rep.peak_angle_deg, 95);
});

test("small partial excursions are discarded and require re-arming", () => {
  const f = fixture();
  f.arm();
  const states = f.feed([
    147, 145, 143, 144, 148, 154, 157, 168, 175, 175, 175,
  ]);
  assert.equal(f.tracker.summary().completed_reps, 0);
  const discarded = states.find((state) => state.discardCandidate);
  assert.ok(discarded);
  assert.equal(discarded.captureCandidate, false);
  assert.match(discarded.formMessage, /partial/i);
  f.arm();
  f.rep();
  assert.equal(f.tracker.summary().completed_reps, 1);
});

test("visibility loss immediately discards the incomplete rep and requires start-pose dwell", () => {
  const f = fixture();
  f.arm();
  f.rep();
  f.feed([140, 135, 120, 100, 90]);
  const landmarks = visibleBody();
  landmarks[28].visibility = 0.69;
  const lost = f.sample(90, { landmarks });
  assert.equal(lost.available, false);
  assert.equal(lost.discardCandidate, true);
  assert.equal(lost.repCount, 1);
  assert.match(lost.formMessage, /Assessment Unavailable/);
  f.feed([100, 130, 170, 175, 175]);
  assert.equal(f.tracker.summary().completed_reps, 1);
  f.arm();
  f.rep();
  assert.equal(f.tracker.summary().completed_reps, 2);
});

test("missing world geometry cannot fall back to misleading normalized image angles", () => {
  const f = fixture();
  f.arm();
  f.feed([140, 135, 120, 90]);
  const invalid = f.sample(90, { worldLandmarks: undefined });
  assert.equal(invalid.available, false);
  assert.equal(invalid.angle, null);
  assert.equal(invalid.discardCandidate, true);
  assert.match(invalid.formMessage, /3D/);
  f.feed([120, 150, 175, 175, 175]);
  assert.equal(f.tracker.summary().completed_reps, 0);
});

test("repeated, out-of-order, stale, and future frames never advance a rep", () => {
  for (const timing of [
    { now: 900, capturedAt: 800 }, // repeated capture
    { now: 900, capturedAt: 750 }, // out-of-order capture
    { now: 800, capturedAt: 800 }, // duplicate call
    { now: 1200, capturedAt: 800 }, // stale frame
    { now: 900, capturedAt: 1000 }, // future frame
  ]) {
    const f = fixture();
    f.arm();
    f.feed([140, 135, 120, 90]); // last capture = 800
    const state = f.sample(90, timing);
    assert.equal(state.available, false, JSON.stringify(timing));
    assert.equal(state.discardCandidate, true);
    assert.equal(state.repCount, 0);
    f.sample(175, { now: 1300 });
    f.sample(175);
    assert.equal(f.tracker.summary().completed_reps, 0);
  }
});

test("a camera gap clears partial state even when its next image is fresh", () => {
  const f = fixture();
  f.arm();
  f.feed([140, 135, 120, 90]);
  const gap = f.sample(175, { now: 1600 });
  assert.equal(gap.available, false);
  assert.equal(gap.discardCandidate, true);
  f.feed([175, 175, 175]);
  assert.equal(f.tracker.summary().completed_reps, 0);
  f.arm();
  f.rep();
  assert.equal(f.tracker.summary().completed_reps, 1);
});

test("bouncing near the inflection and brief return-to-start jitter cannot double count", () => {
  const f = fixture();
  f.arm();
  f.feed([
    140, 135, 120, 90, 95, 100, 105, 90, 94, 103, 115, 130, 165, 150, 170, 145,
    165, 175, 175, 175,
  ]);
  assert.equal(f.tracker.summary().completed_reps, 1);
  f.feed([175, 175, 175, 175, 175]);
  assert.equal(f.tracker.summary().completed_reps, 1);
});

test("summary and completion snapshots cannot mutate retained metrics", () => {
  const f = fixture();
  f.arm();
  const completed = f.rep().find((state) => state.completedRep).completedRep;
  completed.faults.push("external");
  completed.score = 999;
  const summary = f.tracker.summary();
  summary.reps[0].faults.push("external");
  summary.reps.length = 0;
  assert.equal(f.tracker.summary().reps.length, 1);
  assert.equal(f.tracker.summary().reps[0].score, 0);
  assert.deepEqual(f.tracker.summary().reps[0].faults, []);
  f.tracker.invalidate();
  assert.equal(f.tracker.summary().reps.length, 1);
});

test("invalid exercise identifiers and unbounded target counts are rejected", () => {
  assert.throws(
    () => new MovementTracker({ exerciseId: "pushup", targetReps: 8 }),
    RangeError,
  );
  for (const targetReps of [0, -1, NaN, Infinity, 1.5, 101])
    assert.throws(
      () => new MovementTracker({ exerciseId: "squat", targetReps }),
      RangeError,
    );
});

test("fast measured cadence is explicitly scored worse than a controlled full-range rep", () => {
  const f = fixture();
  f.arm();
  f.rep();
  const states = f.feed([140, 130, 110, 90, 90, 102, 120, 145, 170, 175, 175]);
  const fast = states.find((state) => state.completedRep)?.completedRep;
  assert.ok(fast);
  assert.deepEqual(fast.faults, ["fast_cadence"]);
  assert.ok(fast.cadence_seconds < 1.4);
  assert.ok(fast.score > f.tracker.summary().reps[0].score);
});

test("uneven range needs sustained bilateral evidence instead of a single noisy frame", () => {
  for (const sustained of [false, true]) {
    const f = fixture();
    f.arm();
    f.feed([145, 140, 130, 110]);
    f.sample(85, { rightAngle: 110 });
    for (let index = 0; index < 4; index++)
      f.sample(85, { rightAngle: sustained ? 110 : 85 });
    f.feed([100, 120, 135, 145, 165, 175, 175, 175]);
    const rep = f.tracker.summary().reps[0];
    assert.ok(rep);
    assert.equal(rep.faults.includes("uneven_range"), sustained);
  }
});

test("an incomplete movement times out without preserving a candidate or counting", () => {
  const f = fixture();
  f.arm();
  f.feed([140, 135, 120, 90]);
  for (let index = 0; index < 305; index++) f.sample(90);
  assert.equal(f.tracker.summary().completed_reps, 0);
  assert.ok(
    f.states.some(
      (state) =>
        /too long/i.test(state.formMessage) &&
        state.discardCandidate &&
        !state.available,
    ),
  );
  f.feed([175, 175, 175]);
  assert.equal(f.tracker.summary().completed_reps, 0);
});

test("overflowing joint vectors are unavailable rather than NaN observations", () => {
  assert.equal(
    jointAngle(
      { x: 1e308, y: 0, z: 0 },
      { x: -1e308, y: 0, z: 0 },
      { x: 0, y: 1e308, z: 0 },
    ),
    null,
  );
  const f = fixture();
  const worldLandmarks = worldPose("squat", 90);
  worldLandmarks[23].x = 1e308;
  worldLandmarks[25].x = -1e308;
  assert.equal(f.sample(90, { worldLandmarks }).available, false);
});

test("range faults and actionable cues appear after the turn, never prematurely during descent", () => {
  const f = fixture();
  f.arm();
  const states = f.feed([
    145, 140, 135, 130, 128, 128, 128, 128, 130, 140, 145, 150, 165, 175, 175,
    175,
  ]);
  const descending = states.filter((state) => state.phase === "eccentric");
  assert.ok(descending.length > 0);
  assert.ok(
    descending.every((state) => !state.faults.includes("shallow_depth")),
  );
  const returning = states.find((state) => state.phase === "concentric");
  assert.ok(returning.faults.includes("shallow_depth"));
  assert.match(returning.formMessage, /next rep.*lower/i);
  const completed = states.find((state) => state.completedRep);
  assert.match(completed.formMessage, /complete.*next rep.*lower/i);
});
