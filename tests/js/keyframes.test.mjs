import test from "node:test";
import assert from "node:assert/strict";
import { WorstRepBuffer } from "../../app/static/js/keyframes.js";

function fixture() {
  const draws = [];
  const clears = [];
  let image = "data:image/jpeg;base64,first";
  let encodeError = false;
  let hasContext = true;
  const context = {
    drawImage: (...args) => draws.push(args),
    clearRect: (...args) => clears.push(args),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (hasContext ? context : null),
    toDataURL(type, quality) {
      assert.equal(type, "image/jpeg");
      assert.equal(quality, 0.75);
      if (encodeError) throw new Error("JPEG encoding unavailable");
      return image;
    },
  };
  const video = { readyState: 3, videoWidth: 1280, videoHeight: 720 };
  const buffer = new WorstRepBuffer({ createCanvas: () => canvas });
  return {
    buffer,
    video,
    canvas,
    draws,
    clears,
    image(value) {
      image = value;
    },
    failEncode(value = true) {
      encodeError = value;
    },
    contextAvailable(value) {
      hasContext = value;
    },
    observe(snapshot) {
      buffer.observe(snapshot, video);
    },
  };
}

const rep = (number, score) => ({
  rep_number: number,
  bottom_at_ms: number * 2000,
  score,
  faults: score ? ["shallow_depth"] : [],
});

test("captures candidates only when requested, bounds dimensions, and clears raw pixels", () => {
  const f = fixture();
  f.observe({});
  assert.equal(f.draws.length, 0);
  f.observe({ captureCandidate: true });
  assert.equal(f.buffer.candidate, "data:image/jpeg;base64,first");
  assert.equal(f.buffer.worst, null);
  assert.deepEqual(f.draws[0], [f.video, 0, 0, 640, 360]);
  assert.deepEqual(f.clears[0], [0, 0, 640, 360]);
  f.video.videoWidth = 240;
  f.video.videoHeight = 320;
  f.observe({ captureCandidate: true });
  assert.deepEqual(f.draws[1], [f.video, 0, 0, 240, 320]);
});

test("new deepest candidate replaces the older pose and becomes associated with the completed rep", () => {
  const f = fixture();
  f.observe({ captureCandidate: true });
  f.image("data:image/jpeg;base64,bottom");
  f.observe({ captureCandidate: true });
  const completed = rep(1, 10);
  f.observe({ completedRep: completed });
  assert.equal(f.buffer.candidate, null);
  assert.equal(f.buffer.worst.image, "data:image/jpeg;base64,bottom");
  assert.deepEqual(f.buffer.worst.rep, completed);
  completed.faults.push("later_mutation");
  completed.score = 999;
  assert.equal(f.buffer.worst.rep.score, 10);
  assert.deepEqual(f.buffer.worst.rep.faults, ["shallow_depth"]);
});

test("worst completed rep uses highest fault score and keeps the earliest equal score", () => {
  const f = fixture();
  for (const [number, score, image] of [
    [1, 0, "clean"],
    [2, 20, "worst"],
    [3, 20, "tied"],
    [4, 5, "better"],
  ]) {
    f.image(`data:image/jpeg;base64,${image}`);
    f.observe({ captureCandidate: true });
    f.observe({ completedRep: rep(number, score) });
  }
  assert.equal(f.buffer.worst.rep.rep_number, 2);
  assert.equal(f.buffer.worst.image, "data:image/jpeg;base64,worst");
  assert.equal(f.buffer.candidate, null);
});

test("discarding interrupted or partial reps preserves the prior completed worst rep", () => {
  const f = fixture();
  f.observe({ captureCandidate: true, completedRep: rep(1, 0) });
  f.image("data:image/jpeg;base64,partial");
  f.observe({ captureCandidate: true });
  f.observe({ discardCandidate: true });
  assert.equal(f.buffer.candidate, null);
  assert.equal(f.buffer.worst.image, "data:image/jpeg;base64,first");
  f.observe({ captureCandidate: true });
  f.buffer.discardPartial();
  assert.equal(f.buffer.candidate, null);
  assert.equal(f.buffer.worst.rep.rep_number, 1);
});

test("failed JPEG encoding cannot reuse an earlier pose for the newer inflection", () => {
  const f = fixture();
  f.observe({ captureCandidate: true });
  f.failEncode();
  assert.doesNotThrow(() => f.observe({ captureCandidate: true }));
  assert.equal(f.buffer.candidate, null);
  assert.equal(f.clears.length, 2);
  f.observe({ completedRep: rep(1, 5) });
  assert.equal(f.buffer.worst.rep.rep_number, 1);
  assert.equal(f.buffer.worst.image, null);
});

test("unavailable video, context, or JPEG output produces no stale image", () => {
  for (const failure of ["video", "dimensions", "context", "format"]) {
    const f = fixture();
    f.observe({ captureCandidate: true });
    if (failure === "video") f.video.readyState = 1;
    if (failure === "dimensions") f.video.videoWidth = 0;
    if (failure === "context") f.contextAvailable(false);
    if (failure === "format") f.image("data:image/png;base64,wrong-format");
    f.observe({ captureCandidate: true, completedRep: rep(1, 0) });
    assert.equal(f.buffer.candidate, null, failure);
    assert.equal(f.buffer.worst.image, null, failure);
  }
});

test("a worse rep with failed capture retains its own metrics, never an unrelated better image", () => {
  const f = fixture();
  f.observe({ captureCandidate: true, completedRep: rep(1, 5) });
  f.failEncode();
  f.observe({ captureCandidate: true, completedRep: rep(2, 20) });
  assert.equal(f.buffer.worst.rep.rep_number, 2);
  assert.equal(f.buffer.worst.image, null);
});

test("clear releases both JPEG references and pixel storage and permits a fresh set", () => {
  const f = fixture();
  f.observe({ captureCandidate: true, completedRep: rep(1, 5) });
  f.image("data:image/jpeg;base64,partial");
  f.observe({ captureCandidate: true });
  f.buffer.clear();
  assert.equal(f.buffer.worst, null);
  assert.equal(f.buffer.candidate, null);
  assert.equal(f.canvas.width, 0);
  assert.equal(f.canvas.height, 0);
  f.image("data:image/jpeg;base64,new-set");
  f.observe({ captureCandidate: true, completedRep: rep(1, 0) });
  assert.equal(f.buffer.worst.image, "data:image/jpeg;base64,new-set");
  assert.equal(f.canvas.width, 640);
});
