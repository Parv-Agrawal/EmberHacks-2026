import test from "node:test";
import assert from "node:assert/strict";
import { LiveWorkout } from "../../app/static/js/live-workout.js";
import { MAX_FRAME_AGE_MS } from "../../app/static/js/calibration.js";

const plan = () => ({
  exercises: [
    { id: "squat", name: "Squats", sets: 2, reps: 3, rest_seconds: 30 },
    {
      id: "bicep_curl",
      name: "Bicep curls",
      sets: 1,
      reps: 2,
      rest_seconds: 20,
    },
  ],
});

function element() {
  const node = new EventTarget();
  const classes = new Set();
  Object.assign(node, {
    hidden: false,
    disabled: false,
    textContent: "",
    srcObject: null,
    readyState: 3,
    videoWidth: 1280,
    videoHeight: 720,
    attributes: new Map(),
    classList: {
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
      delete this[name];
    },
    pause() {},
  });
  return node;
}

function canvas() {
  let pixels = "";
  const context = {
    drawImage(video) {
      pixels = video.frameMarker ?? "frame";
    },
    clearRect() {
      pixels = "";
    },
  };
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () =>
      `data:image/jpeg;base64,${Buffer.from(pixels).toString("base64")}`,
  };
}

// Camera and speech are device boundaries. The controller, movement state
// machine, keyframe buffer, and displayed results remain the production code.
function fixture(t, workout = plan(), { requestCoach } = {}) {
  let now = 1000;
  let exits = 0;
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, id === "workout-overlay" ? canvas() : element());
    return elements.get(id);
  };
  const document = new EventTarget();
  Object.assign(document, {
    hidden: false,
    getElementById: get,
    createElement: canvas,
  });
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  t.mock.method(performance, "now", () => now);
  const live = new LiveWorkout({
    requestCoach,
    onExit: () => {
      exits += 1;
    },
  });
  const camera = {
    starts: [],
    stops: 0,
    lastFrameAt: -Infinity,
    async start(options) {
      this.starts.push(options);
      live.onCamera({
        status: "loading",
        ready: false,
        message: "Loading camera.",
      });
    },
    stop() {
      this.stops += 1;
      this.lastFrameAt = -Infinity;
      get("workout-video").srcObject = null;
      live.onCamera({
        status: "stopped",
        ready: false,
        message: "Camera stopped.",
      });
    },
  };
  const voice = {
    enabled: true,
    supported: true,
    stops: 0,
    resets: 0,
    cues: [],
    headlines: [],
    milestones: [],
    cue(message, options) {
      this.cues.push({ message, options });
    },
    headline(message) {
      this.headlines.push(message);
    },
    milestone(...args) {
      this.milestones.push(args);
    },
    stop() {
      this.stops += 1;
    },
    resetMilestones() {
      this.resets += 1;
    },
    setEnabled(enabled) {
      this.enabled = enabled;
    },
  };
  live.camera = camera;
  live.voice = voice;
  live.review.voice = voice;
  t.after(() => {
    live.dispose();
    if (savedDocument)
      Object.defineProperty(globalThis, "document", savedDocument);
    else delete globalThis.document;
  });
  live.open(workout);
  const ready = () => {
    camera.lastFrameAt = now;
    get("workout-video").srcObject = {};
    live.onCamera({ status: "ready", ready: true, message: "Ready." });
  };
  const sample = (angle, options = {}) => {
    now += 100;
    const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    const joints =
      live.exercise.id === "squat"
        ? [
            [23, 25, 27],
            [24, 26, 28],
          ]
        : [
            [11, 13, 15],
            [12, 14, 16],
          ];
    for (const [side, [a, b, c]] of joints.entries()) {
      const radians = (angle * Math.PI) / 180;
      points[a] = { x: side, y: 1, z: 0 };
      points[b] = { x: side, y: 0, z: 0 };
      points[c] = { x: side, y: Math.cos(radians), z: Math.sin(radians) };
    }
    const landmarks = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.5,
      visibility: 0.95,
      presence: 0.95,
    }));
    camera.lastFrameAt = now;
    get("workout-video").frameMarker = `pose:${angle}:at:${now}`;
    live.onFrame({
      landmarks,
      worldLandmarks: points,
      now,
      capturedAt: now,
      ...options,
    });
    return live.lastSnapshot;
  };
  const feed = (angles) => angles.map((angle) => sample(angle));
  const arm = () => feed([175, 175, 175, 175, 175]);
  const rep = (bottom = live.exercise.id === "squat" ? 90 : 50) =>
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
  return {
    live,
    camera,
    voice,
    document,
    get,
    ready,
    sample,
    feed,
    arm,
    rep,
    at(value) {
      now = value;
    },
    now: () => now,
    exits: () => exits,
    click(id) {
      get(id).dispatchEvent(new Event("click"));
    },
    input(value, { committed = false } = {}) {
      get("coach-feedback").value = value;
      get("coach-feedback").dispatchEvent(
        new Event(committed ? "change" : "input"),
      );
    },
    start() {
      ready();
      live.begin();
      arm();
    },
  };
}

test("opening prepares a cloned plan without starting a device; begin requires a fresh visible camera", async (t) => {
  const workout = plan();
  const f = fixture(t, workout);
  workout.exercises[0].reps = 99;
  assert.equal(f.live.exercise.reps, 3);
  assert.equal(f.live.stage, "preparing");
  assert.deepEqual(f.camera.starts, []);
  assert.equal(f.get("live-title").textContent, "Squats");
  assert.equal(f.get("live-enable").hidden, false);
  assert.equal(f.get("live-begin").disabled, true);
  f.live.begin();
  assert.equal(f.live.stage, "preparing");
  await f.live.enableCamera();
  assert.deepEqual(f.camera.starts, [{ exerciseId: "squat" }]);
  f.ready();
  f.at(f.now() + MAX_FRAME_AGE_MS + 1);
  f.live.begin();
  assert.equal(
    f.live.stage,
    "preparing",
    "cached readiness cannot start a set",
  );
  f.ready();
  f.document.hidden = true;
  f.live.begin();
  assert.equal(f.live.stage, "preparing");
  f.document.hidden = false;
  f.live.begin();
  assert.equal(f.live.stage, "active");
  assert.equal(f.get("live-begin").hidden, true);
  assert.equal(f.get("live-pause").hidden, false);
  assert.equal(f.voice.cues.length, 1);
});

test("pause releases devices and unfinished images while preserving completed reps and elapsed active time", async (t) => {
  const f = fixture(t);
  f.start();
  f.rep();
  const completedImage = f.live.frames.worst.image;
  f.feed([140, 135, 120, 90]);
  assert.ok(f.live.frames.candidate);
  const stops = [f.camera.stops, f.voice.stops];
  f.live.pause();
  const elapsed = f.live.elapsed;
  assert.equal(f.live.stage, "paused");
  assert.ok(f.camera.stops > stops[0]);
  assert.ok(f.voice.stops > stops[1]);
  assert.equal(f.live.frames.candidate, null);
  assert.equal(f.live.frames.worst.image, completedImage);
  assert.equal(f.live.tracker.summary().completed_reps, 1);
  f.at(f.now() + 20000);
  f.live.renderTime();
  assert.equal(f.live.elapsed, elapsed);
  await f.live.enableCamera();
  f.ready();
  f.live.begin();
  f.feed([90, 110, 150, 175, 175, 175]);
  assert.equal(
    f.live.tracker.summary().completed_reps,
    1,
    "returning from an interrupted rep cannot count as a completion",
  );
  f.arm();
  f.rep();
  assert.equal(f.live.tracker.summary().completed_reps, 2);
});

test("stale or invisible camera status abandons partial motion and gates incoming measurements", (t) => {
  const f = fixture(t);
  f.start();
  f.rep();
  for (const message of [
    "Assessment Unavailable. Frame is stale.",
    "Step back / Adjust angle.",
  ]) {
    f.arm();
    f.feed([140, 135, 120, 90]);
    assert.ok(f.live.frames.candidate);
    const priorSnapshot = f.live.lastSnapshot;
    const priorStops = f.voice.stops;
    f.live.onCamera({ status: "unavailable", ready: false, message });
    assert.equal(f.get("live-badge").textContent, "Assessment Unavailable");
    assert.equal(f.live.frames.candidate, null);
    assert.ok(f.voice.stops > priorStops);
    f.feed([110, 150, 175, 175, 175]);
    assert.equal(
      f.live.lastSnapshot,
      priorSnapshot,
      "unavailable camera frames are never sent to tracking",
    );
    assert.equal(f.live.tracker.summary().completed_reps, 1);
    f.ready();
    f.feed([90, 110, 150, 175, 175]);
    assert.equal(f.live.tracker.summary().completed_reps, 1);
  }
});

test("camera failure or tab hiding pauses automatically and late frames cannot update the HUD", (t) => {
  const f = fixture(t);
  f.start();
  f.rep();
  f.live.onCamera({
    status: "error",
    ready: false,
    message: "Assessment Unavailable. Camera disconnected.",
  });
  assert.equal(f.live.stage, "paused");
  assert.equal(f.get("live-enable").hidden, false);
  const previousCount = f.get("live-count").textContent;
  f.sample(175);
  assert.equal(f.get("live-count").textContent, previousCount);
  f.live.stage = "preparing";
  f.ready();
  f.live.begin();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.live.stage, "paused");
  assert.equal(f.get("workout-video").srcObject, null);
});

for (const exerciseId of ["squat", "bicep_curl"]) {
  test(`${exerciseId}: target completion stops devices and presents measured data with the worst inflection image`, (t) => {
    const workout = {
      exercises: [
        {
          id: exerciseId,
          name: exerciseId,
          sets: 1,
          reps: 2,
          rest_seconds: 30,
        },
      ],
    };
    const f = fixture(t, workout);
    f.start();
    f.rep();
    const bottom = exerciseId === "squat" ? 128 : 95;
    if (exerciseId === "squat")
      f.feed([
        165, 150, 140, 138, 135, 128, 128, 128, 128, 128, 130, 140, 145, 150,
        165, 175, 175, 175,
      ]);
    else f.rep(bottom);
    assert.equal(f.live.stage, "finished");
    assert.equal(f.get("workout-video").srcObject, null);
    assert.equal(f.get("live-badge").textContent, "Camera is off");
    assert.equal(f.get("set-result").hidden, false);
    const summary = JSON.parse(f.get("set-data").textContent);
    assert.equal(summary.completed_reps, 2);
    assert.equal(summary.reps[1].peak_angle_deg, bottom);
    const fault =
      exerciseId === "squat" ? "shallow_depth" : "limited_curl_range";
    assert.deepEqual(summary.detected_faults, [fault]);
    assert.equal(f.live.frames.candidate, null);
    assert.equal(f.live.frames.worst.rep.rep_number, 2);
    assert.equal(f.get("worst-keyframe").hidden, false);
    assert.equal(f.get("worst-keyframe").src, f.live.frames.worst.image);
    const image = Buffer.from(
      f.get("worst-keyframe").src.split(",")[1],
      "base64",
    ).toString();
    assert.equal(image, `pose:${bottom}:at:${summary.reps[1].bottom_at_ms}`);
    assert.match(f.get("keyframe-caption").textContent, /Rep 2/);
    const finishedData = f.get("set-data").textContent;
    f.rep();
    assert.equal(
      f.get("set-data").textContent,
      finishedData,
      "late frames never mutate a finished set",
    );
    f.live.next();
    assert.equal(f.exits(), 1);
  });
}

test("ending an incomplete first rep shows an empty result without retaining its image", (t) => {
  const f = fixture(t);
  f.start();
  f.feed([140, 135, 120, 90]);
  assert.ok(f.live.frames.candidate);
  f.live.finish(false);
  assert.equal(JSON.parse(f.get("set-data").textContent).completed_reps, 0);
  assert.equal(f.live.frames.candidate, null);
  assert.equal(f.live.frames.worst, null);
  assert.equal(f.get("worst-keyframe").hidden, true);
  assert.equal(f.get("worst-keyframe").src, undefined);
  assert.match(f.get("keyframe-caption").textContent, /No complete reps/);
});

test("planned rest gates the next set and advancing exercises resets set data and target", (t) => {
  const f = fixture(t);
  f.start();
  f.rep();
  f.live.finish(false);
  assert.equal(f.get("live-next").disabled, true);
  f.live.next();
  assert.equal(f.live.stage, "finished");
  assert.equal(f.live.setIndex, 0);
  f.at(f.live.restUntil);
  f.live.renderTime();
  assert.equal(f.get("live-next").disabled, false);
  f.live.next();
  assert.equal(f.live.stage, "preparing");
  assert.equal(f.live.setIndex, 1);
  assert.equal(f.live.exercise.id, "squat");
  assert.equal(f.live.tracker.summary().completed_reps, 0);
  assert.equal(f.live.frames.worst, null);
  assert.equal(f.get("worst-keyframe").src, undefined);
  assert.equal(f.get("set-result").hidden, true);
  assert.equal(f.get("set-data").textContent, "");
  f.live.finish(false);
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.exercise.id, "bicep_curl");
  assert.equal(f.live.setIndex, 0);
  assert.equal(String(f.get("live-target").textContent), "2");
  assert.equal(f.live.cameraState.ready, false);
});

test("disposal removes captured images, measurements, the plan, and the running timer", (t) => {
  const f = fixture(t);
  f.start();
  f.rep();
  f.live.finish(false);
  assert.ok(f.get("worst-keyframe").src);
  f.live.dispose();
  assert.equal(f.live.stage, "idle");
  assert.equal(f.live.workout, null);
  assert.equal(f.live.tracker, null);
  assert.equal(f.live.lastSnapshot, null);
  assert.equal(f.live.interval, null);
  assert.equal(f.live.frames.worst, null);
  assert.equal(f.live.frames.candidate, null);
  assert.equal(f.get("worst-keyframe").src, undefined);
  assert.equal(f.get("set-data").textContent, "");
  assert.equal(f.get("set-result").hidden, true);
  f.live.onFrame({ now: f.now() + 100 });
  assert.equal(f.get("set-data").textContent, "");
});

const adaptivePlan = () => ({
  exercises: [
    { id: "squat", name: "Squats", sets: 3, reps: 8, rest_seconds: 60 },
    {
      id: "bicep_curl",
      name: "Bicep curls",
      sets: 2,
      reps: 8,
      rest_seconds: 60,
    },
  ],
});

function completeSet(f) {
  f.start();
  const target = f.live.exercise.reps;
  for (let index = 0; index < target; index++) f.rep();
  assert.equal(f.live.stage, "finished");
}

function deferredReview() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const requests = [];
  return {
    requests,
    resolve,
    requestCoach(body, signal) {
      requests.push({ body, signal });
      return promise;
    },
  };
}

const coachResponse = () => ({
  source: "gemini",
  feedback: {
    headline:
      "Eight measured reps were controlled; you reported that they felt easy.",
    tips: [
      "Keep the same steady pace.",
      "Keep both knees visible to the camera.",
    ],
    encouragement: "Nice work finishing the set.",
  },
});

test("a pain stop during movement immediately ends the exercise and skips its remaining sets only after an explicit next action", async (t) => {
  const f = fixture(t, adaptivePlan());
  f.start();
  f.rep();
  f.feed([140, 135, 120, 90]);
  assert.ok(f.live.frames.candidate);
  const cameraStops = f.camera.stops;
  const voiceStops = f.voice.stops;
  f.click("live-pain");
  assert.equal(f.live.stage, "finished");
  assert.equal(f.live.painStopped, true);
  assert.equal(f.live.blockedExercises.has("squat"), true);
  assert.ok(f.camera.stops > cameraStops);
  assert.ok(f.voice.stops > voiceStops);
  assert.equal(f.get("workout-video").srcObject, null);
  assert.equal(f.live.frames.candidate, null);
  assert.equal(f.live.tracker.summary().completed_reps, 1);
  assert.equal(f.live.review.stopped, true);
  assert.equal(f.get("coach-submit").disabled, true);
  assert.equal(f.get("adapt-panel").hidden, true);
  assert.equal(f.get("live-begin").hidden, true);
  assert.equal(f.get("live-pain").hidden, true);
  assert.match(f.get("live-status").textContent, /Remaining sets.*skipped/);
  assert.match(f.get("live-next").textContent, /Skip to the next exercise/);

  const elapsed = f.live.elapsed;
  const starts = f.camera.starts.length;
  await f.live.enableCamera();
  f.live.begin();
  f.rep();
  assert.equal(f.camera.starts.length, starts);
  assert.equal(f.live.stage, "finished");
  assert.equal(f.live.tracker.summary().completed_reps, 1);
  assert.equal(f.live.elapsed, elapsed);
  f.live.next();
  assert.equal(f.live.exerciseIndex, 0, "rest still gates moving on");
  f.at(f.live.restUntil);
  f.live.renderTime();
  assert.equal(
    f.live.exerciseIndex,
    0,
    "rest ending never starts an exercise automatically",
  );
  f.live.next();
  assert.equal(f.live.stage, "preparing");
  assert.equal(f.live.exerciseIndex, 1);
  assert.equal(f.live.setIndex, 0);
  assert.equal(f.live.exercise.id, "bicep_curl");
  assert.equal(f.live.painStopped, false);
  assert.equal(f.live.blockedExercises.has("squat"), true);
  assert.equal(f.live.review.context, null);
  assert.equal(f.get("coach-panel").hidden, true);
});

test("committed pain during an in-flight review aborts HTTP and speech immediately and rejects a late model result", async (t) => {
  const transport = deferredReview();
  const f = fixture(t, adaptivePlan(), transport);
  completeSet(f);
  f.click("feedback-easy");
  const submission = f.live.review.submit();
  assert.equal(transport.requests.length, 1);
  const { body, signal } = transport.requests[0];
  assert.equal(body.set_summary.completed_reps, 8);
  assert.equal(body.keyframe_image, f.live.frames.worst.image);
  assert.equal(signal.aborted, false);
  assert.equal(f.live.review.pending, true);
  const voiceStops = f.voice.stops;
  const cameraStops = f.camera.stops;
  f.input("No pain before, now my knee hurts", { committed: true });
  assert.equal(f.live.painStopped, true);
  assert.equal(f.live.review.stopped, true);
  assert.equal(f.live.review.pending, false);
  assert.equal(signal.aborted, true);
  assert.ok(f.voice.stops > voiceStops);
  assert.ok(f.camera.stops > cameraStops);
  assert.equal(f.live.pendingAdaptation, null);
  const stoppedMessage = f.get("coach-status").textContent;
  transport.resolve(coachResponse());
  await submission;
  assert.equal(f.get("coach-status").textContent, stoppedMessage);
  assert.equal(f.get("coach-result").hidden, true);
  assert.deepEqual(f.voice.headlines, []);
  assert.equal(f.live.stage, "finished");
});

test("next-set navigation rechecks an uncommitted pain report instead of starting another set", (t) => {
  const f = fixture(t, adaptivePlan());
  completeSet(f);
  f.click("feedback-easy");
  f.click("adapt-accept");
  assert.equal(f.live.pendingAdaptation.reps, 9);
  f.get("coach-feedback").value = "My shoulder hurts";
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.painStopped, true);
  assert.equal(f.live.stage, "finished");
  assert.equal(f.live.setIndex, 0);
  assert.equal(f.live.exerciseIndex, 0);
  assert.equal(f.live.pendingAdaptation, null);
  assert.equal(f.get("adapt-panel").hidden, true);
});

test("adaptation requires explicit acceptance, updates subsequent sets, and keeps the source workout unchanged", (t) => {
  const workout = adaptivePlan();
  const original = structuredClone(workout);
  const f = fixture(t, workout);
  completeSet(f);
  const originalRestUntil = f.live.restUntil;
  f.click("feedback-easy");
  assert.equal(f.live.review.proposal.kind, "increase");
  assert.equal(f.live.review.proposal.reps, 9);
  assert.equal(f.live.pendingAdaptation, null);
  assert.equal(f.live.exercise.reps, 8);
  assert.equal(f.live.restUntil, originalRestUntil);
  f.click("adapt-accept");
  assert.equal(f.live.pendingAdaptation.reps, 9);
  assert.equal(
    f.live.exercise.reps,
    8,
    "the finished set's target is immutable",
  );
  assert.equal(f.live.tracker.summary().target_reps, 8);
  assert.deepEqual(f.live.workout, original);
  assert.deepEqual(workout, original);
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.exercise.reps, 9);
  assert.equal(f.live.tracker.summary().target_reps, 9);
  assert.equal(String(f.get("live-target").textContent), "9");
  assert.equal(f.live.setIndex, 1);
  assert.equal(f.live.pendingAdaptation, null);
  assert.equal(f.live.review.context, null);
  assert.deepEqual(f.live.workout, original);

  // The accepted target becomes the current plan for this exercise.
  f.live.finish(false);
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.setIndex, 2);
  assert.equal(f.live.exercise.reps, 9);
  assert.equal(f.live.exercise.rest_seconds, 60);
});

test("accepting extra rest updates the existing countdown; declining or editing restores the original plan", (t) => {
  const f = fixture(t, adaptivePlan());
  completeSet(f);
  const originalRestUntil = f.live.restUntil;
  f.at(f.live.finishedAt + 20000);
  f.click("feedback-fatigue");
  assert.equal(f.live.review.proposal.rest_seconds, 90);
  assert.equal(f.live.restUntil, originalRestUntil);
  f.click("adapt-accept");
  assert.equal(f.live.restUntil, f.live.finishedAt + 90000);
  assert.match(f.get("live-rest").textContent, /1:10 remaining/);
  f.click("adapt-keep");
  assert.equal(f.live.pendingAdaptation, null);
  assert.equal(f.live.restUntil, originalRestUntil);
  assert.match(f.get("live-rest").textContent, /0:40 remaining/);

  f.click("adapt-accept");
  f.input("I felt off-balance");
  assert.equal(
    f.live.pendingAdaptation,
    null,
    "editing invalidates earlier acceptance",
  );
  assert.equal(f.live.restUntil, originalRestUntil);
  assert.equal(f.live.review.proposal.reps, 6);
  f.click("adapt-keep");
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.exercise.reps, 8);
  assert.equal(f.live.exercise.rest_seconds, 60);
});

test("an accepted balance adjustment carries both reps and rest into the next set", (t) => {
  const f = fixture(t, adaptivePlan());
  completeSet(f);
  f.click("feedback-balance");
  f.click("adapt-accept");
  assert.equal(f.live.restUntil, f.live.finishedAt + 90000);
  f.at(f.live.finishedAt + 60000);
  f.live.next();
  assert.equal(
    f.live.stage,
    "finished",
    "the original rest duration is insufficient after acceptance",
  );
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.exercise.reps, 6);
  assert.equal(f.live.exercise.rest_seconds, 90);
  assert.equal(f.live.tracker.summary().target_reps, 6);
  assert.equal(f.live.workout.exercises[0].reps, 8);
  assert.equal(f.live.workout.exercises[0].rest_seconds, 60);
});

test("keeping the current plan preserves an accepted reduction through later sets and resets for a different exercise", (t) => {
  const f = fixture(t, adaptivePlan());
  completeSet(f);
  f.click("feedback-balance");
  f.click("adapt-accept");
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.setIndex, 1);
  assert.equal(f.live.exercise.reps, 6);
  assert.equal(f.live.exercise.rest_seconds, 90);
  completeSet(f);
  f.click("feedback-easy");
  assert.equal(f.live.review.proposal.reps, 7);
  f.click("adapt-keep");
  assert.equal(f.live.pendingAdaptation, null);
  assert.equal(f.live.restUntil, f.live.finishedAt + 90000);
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.setIndex, 2);
  assert.equal(f.live.exercise.reps, 6);
  assert.equal(f.live.exercise.rest_seconds, 90);
  assert.equal(f.live.tracker.summary().target_reps, 6);

  f.live.finish(false);
  f.at(f.live.restUntil);
  f.live.next();
  assert.equal(f.live.exerciseIndex, 1);
  assert.equal(f.live.exercise.id, "bicep_curl");
  assert.equal(f.live.exercise.reps, 8);
  assert.equal(f.live.exercise.rest_seconds, 60);
  assert.equal(f.live.setIndex, 0);
});

for (const action of ["next set", "dispose"]) {
  test(`${action} clears review data, cancels pending HTTP, and ignores late feedback`, async (t) => {
    const transport = deferredReview();
    const f = fixture(t, adaptivePlan(), transport);
    completeSet(f);
    f.click("feedback-easy");
    const submission = f.live.review.submit();
    const signal = transport.requests[0].signal;
    assert.equal(signal.aborted, false);
    if (action === "next set") {
      f.at(f.live.restUntil);
      f.live.next();
      assert.equal(f.live.stage, "preparing");
      assert.equal(f.live.setIndex, 1);
    } else f.live.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(f.live.review.pending, false);
    assert.equal(f.live.review.context, null);
    assert.equal(f.get("coach-feedback").value, "");
    assert.equal(f.get("coach-panel").hidden, true);
    assert.equal(f.get("coach-headline").textContent, "");
    transport.resolve(coachResponse());
    await submission;
    assert.equal(f.get("coach-panel").hidden, true);
    assert.equal(f.get("coach-result").hidden, true);
    assert.equal(f.get("coach-headline").textContent, "");
    assert.deepEqual(f.voice.headlines, []);
  });
}
