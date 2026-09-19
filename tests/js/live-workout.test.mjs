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
function fixture(t, workout = plan()) {
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
    milestones: [],
    cue(message, options) {
      this.cues.push({ message, options });
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
