import test from "node:test";
import assert from "node:assert/strict";
import { CameraCalibration } from "../../app/static/js/calibration.js";
import { WorstRepBuffer } from "../../app/static/js/keyframes.js";

function canvas() {
  let width = 0;
  let height = 0;
  const target = {
    pixels: null,
    copies: 0,
    clears: 0,
    get width() {
      return width;
    },
    set width(value) {
      width = value;
      this.pixels = null;
    },
    get height() {
      return height;
    },
    set height(value) {
      height = value;
      this.pixels = null;
    },
    toDataURL() {
      return `data:image/jpeg;base64,${Buffer.from(this.pixels ?? "").toString("base64")}`;
    },
  };
  const context = {
    drawImage(source) {
      target.copies += 1;
      target.pixels = source.pixels;
    },
    clearRect() {
      target.clears += 1;
      target.pixels = null;
    },
  };
  target.getContext = () => context;
  return target;
}

function fixture(t, { snapshotFrames = true, onFrame = () => {} } = {}) {
  const created = [];
  const frames = [];
  const updates = [];
  const inferred = [];
  const cancelled = [];
  const scheduled = [];
  let now = 1000;
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const item = canvas();
      created.push(item);
      return item;
    },
  };
  const replacements = {
    document,
    requestAnimationFrame(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
    },
  };
  const saved = {};
  for (const [key, value] of Object.entries(replacements)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.mock.method(performance, "now", () => now);
  const video = {
    readyState: 3,
    paused: false,
    ended: false,
    currentTime: 1,
    videoWidth: 1280,
    videoHeight: 720,
    pixels: "inferred-frame",
    srcObject: {},
    pause() {
      this.paused = true;
    },
  };
  const overlay = canvas();
  const calibration = new CameraCalibration(video, overlay, {
    snapshotFrames,
    onUpdate: (state) => updates.push(state),
    onFrame(frame) {
      frames.push({ ...frame, observedPixels: frame.imageSource?.pixels });
      onFrame(frame);
    },
  });
  // Rendering landmarks is unrelated to image source ownership.
  calibration.draw = () => {};
  const body = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    visibility: 0.95,
    presence: 0.95,
  }));
  const model = {
    fail: false,
    closed: 0,
    detectForVideo(source, capturedAt) {
      inferred.push({ source, pixels: source.pixels, capturedAt });
      video.pixels = "video-advanced-during-inference";
      if (this.fail) throw new Error("Inference failed");
      return { landmarks: [body], worldLandmarks: [body] };
    },
    close() {
      this.closed += 1;
    },
  };
  calibration.landmarker = model;
  t.after(() => {
    calibration.stop();
    for (const key of Object.keys(replacements)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  });
  return {
    calibration,
    video,
    overlay,
    created,
    frames,
    updates,
    inferred,
    model,
    cancelled,
    scheduled,
    tick(at = now) {
      now = at;
      calibration.tick(now, calibration.generation);
    },
  };
}

test("movement inference and keyframe capture use the same frozen source, then erase its pixels", (t) => {
  const buffer = new WorstRepBuffer({ createCanvas: canvas });
  const f = fixture(t, {
    onFrame(frame) {
      buffer.observe({ captureCandidate: true }, frame.imageSource);
      assert.equal(frame.imageSource.pixels, "inferred-frame");
    },
  });
  f.tick();
  assert.equal(f.inferred.length, 1);
  assert.equal(f.frames.length, 1);
  const source = f.inferred[0].source;
  assert.notEqual(source, f.video);
  assert.equal(f.frames[0].imageSource, source);
  assert.equal(f.frames[0].observedPixels, "inferred-frame");
  assert.equal(f.video.pixels, "video-advanced-during-inference");
  assert.equal(
    Buffer.from(buffer.candidate.split(",")[1], "base64").toString(),
    "inferred-frame",
  );
  assert.equal(
    source.pixels,
    null,
    "no pixels remain in the inference canvas after the consumer returns",
  );
  assert.ok(source.clears > 0);
  assert.equal(f.scheduled.length, 1);
  buffer.clear();
});

test("new observations reuse one inference canvas and repeated cached video is never recaptured", (t) => {
  const f = fixture(t);
  f.tick();
  const source = f.inferred[0].source;
  f.tick(1100);
  assert.equal(f.inferred.length, 1);
  assert.equal(source.copies, 1);
  f.video.currentTime = 2;
  f.video.pixels = "next-frame";
  f.tick(1200);
  assert.equal(f.inferred.length, 2);
  assert.equal(f.inferred[1].source, source);
  assert.equal(f.frames[1].observedPixels, "next-frame");
  assert.equal(source.pixels, null);
  assert.equal(
    f.created.length,
    1,
    "each active camera retains only one inference canvas",
  );
});

test("inference failure erases temporary pixels, closes the model, and never sends an image onward", (t) => {
  const f = fixture(t);
  f.model.fail = true;
  f.tick();
  assert.equal(f.frames.length, 0);
  assert.equal(f.model.closed, 1);
  assert.equal(f.calibration.landmarker, null);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.updates.at(-1).status, "error");
  const source = f.inferred[0].source;
  assert.equal(source.pixels, null);
  assert.equal(source.width, 0);
  assert.equal(source.height, 0);
});

test("a consumer exception still releases the inference pixels and camera", (t) => {
  const f = fixture(t, {
    onFrame() {
      throw new Error("Consumer stopped");
    },
  });
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.frames.length, 1);
  assert.equal(f.inferred[0].source.pixels, null);
  assert.equal(f.model.closed, 1);
  assert.equal(f.calibration.landmarker, null);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.updates.at(-1).status, "error");
});

test("stopping from the frame consumer clears dimensions and schedules no further inference", (t) => {
  let calibration;
  const f = fixture(t, {
    onFrame() {
      calibration.stop();
    },
  });
  calibration = f.calibration;
  f.tick();
  const source = f.inferred[0].source;
  assert.equal(source.width, 0);
  assert.equal(source.height, 0);
  assert.equal(source.pixels, null);
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.model.closed, 1);
  assert.equal(f.video.srcObject, null);
});

test("explicit stop cancels scheduled inference and releases its canvas memory", (t) => {
  const f = fixture(t);
  f.tick();
  const source = f.inferred[0].source;
  const generation = f.calibration.generation;
  f.calibration.stop();
  assert.equal(source.width, 0);
  assert.equal(source.height, 0);
  assert.equal(source.pixels, null);
  assert.deepEqual(f.cancelled, [1]);
  assert.equal(f.model.closed, 1);
  assert.equal(f.calibration.frameRequest, null);
  f.calibration.tick(1200, generation);
  assert.equal(
    f.inferred.length,
    1,
    "an old callback cannot restart a stopped camera",
  );
});

test("ordinary framing calibration does not allocate or copy workout keyframes", (t) => {
  const f = fixture(t, { snapshotFrames: false });
  f.tick();
  assert.equal(f.inferred[0].source, f.video);
  assert.equal(f.created.length, 0);
});

function transferTarget(f, play = async function () { this.paused = false; }) {
  const updates = [];
  let stopped = 0;
  const track = { readyState: "live", stop() { stopped += 1; this.readyState = "ended"; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  f.calibration.camera.stream = stream;
  f.video.srcObject = stream;
  const video = { ...f.video, srcObject: null, setAttribute() {}, play };
  const target = new CameraCalibration(video, canvas(), {
    snapshotFrames: true, onUpdate: (state) => updates.push(state),
  });
  target.draw = () => {};
  return { target, video, stream, updates, stops: () => stopped };
}

test("setup hands the same live stream and pose model to the workout without reopening the camera", async (t) => {
  const f = fixture(t, { snapshotFrames: false });
  f.tick();
  const previousGeneration = f.calibration.generation;
  const h = transferTarget(f);
  await h.target.takeOver(f.calibration, { exerciseId: "squat" });
  assert.equal(h.video.srcObject, h.stream);
  assert.equal(f.video.srcObject, null);
  assert.equal(h.target.landmarker, f.model);
  assert.equal(f.calibration.landmarker, null);
  assert.equal(f.model.closed, 0);
  assert.equal(h.stops(), 0);
  assert.equal(h.target.gate.exerciseId, "squat");
  assert.equal(h.updates.at(-1).status, "unavailable");
  const scheduled = f.scheduled.length;
  f.calibration.tick(1100, previousGeneration);
  assert.equal(f.scheduled.length, scheduled);
  f.calibration.stop();
  assert.equal(h.video.srcObject, h.stream, "old view cleanup must not detach the workout");
  assert.equal(h.stops(), 0);
  assert.equal(f.calibration.camera.video, f.video, "setup can be used again on its own video");
  h.target.tick(1000, h.target.generation);
  assert.equal(f.inferred.length, 2);
  h.target.camera.onInterrupted("Camera disconnected.");
  assert.equal(h.updates.at(-1).status, "stopped");
  assert.equal(h.video.srcObject, null);
  assert.equal(h.stops(), 1);
  assert.equal(f.model.closed, 1);
});

test("a failed camera handoff releases the stream and model and exposes a retry", async (t) => {
  const f = fixture(t);
  const h = transferTarget(f, async () => { throw new Error("Playback failed"); });
  await h.target.takeOver(f.calibration, { exerciseId: "squat" });
  assert.equal(h.updates.at(-1).status, "error");
  assert.equal(h.stops(), 1);
  assert.equal(f.model.closed, 1);
  assert.equal(h.video.srcObject, null);
});

test("leaving during camera handoff cannot restart capture when playback resolves", async (t) => {
  const f = fixture(t);
  let resolvePlay;
  const h = transferTarget(f, () => new Promise((resolve) => { resolvePlay = resolve; }));
  const pending = h.target.takeOver(f.calibration, { exerciseId: "squat" });
  h.target.stop();
  resolvePlay();
  await pending;
  assert.equal(h.stops(), 1);
  assert.equal(f.model.closed, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.target.frameRequest, null);
});
