import test from "node:test";
import assert from "node:assert/strict";
import {
  BarcodeScanner,
  classifyBarcode,
} from "../../app/static/js/barcode.js";
import {
  evaluateLandmarks,
  CalibrationGate,
  REQUIRED_STABLE_MS,
} from "../../app/static/js/calibration.js";
import {
  CameraSession,
  cameraErrorMessage,
} from "../../app/static/js/camera.js";

const fullBody = () =>
  Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    visibility: 0.95,
    presence: 0.95,
  }));

test("demo barcode matching is exact and unknown cards cannot authenticate", () => {
  assert.deepEqual(classifyBarcode("2176123456789100"), {
    code: "2176123456789100",
    known: true,
  });
  assert.equal(classifyBarcode("LEETERRY").known, true);
  assert.equal(classifyBarcode("2176123456789101").known, false);
  assert.equal(classifyBarcode("prefix2176123456789100").known, false);
  assert.equal(classifyBarcode("").known, false);
});

test("every required joint needs visible, confident, finite, in-frame coordinates", () => {
  assert.equal(evaluateLandmarks(fullBody()).allVisible, true);
  for (const index of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    for (const invalid of [
      { x: -0.1 },
      { y: 0.99 },
      { visibility: 0.3 },
      { presence: 0.2 },
      { x: NaN },
      { visibility: undefined },
    ]) {
      const body = fullBody();
      Object.assign(body[index], invalid);
      assert.equal(
        evaluateLandmarks(body).allVisible,
        false,
        `joint ${index} must invalidate framing`,
      );
    }
  }
  assert.equal(evaluateLandmarks([]).allVisible, false);
  assert.equal(evaluateLandmarks(undefined).allVisible, false);
});

test("stale or future timestamps never produce valid framing", () => {
  assert.equal(
    evaluateLandmarks(fullBody(), { now: 1000, capturedAt: 600 }).fresh,
    false,
  );
  assert.equal(
    evaluateLandmarks(fullBody(), { now: 1000, capturedAt: 1100 }).allVisible,
    false,
  );
  assert.equal(evaluateLandmarks(fullBody(), { now: NaN }).allVisible, false);
});

test("readiness needs 1.2 uninterrupted seconds and drops on the first lost joint", () => {
  const gate = new CalibrationGate();
  for (let now = 0; now < REQUIRED_STABLE_MS; now += 100)
    assert.equal(gate.update(fullBody(), now).ready, false);
  assert.equal(gate.update(fullBody(), REQUIRED_STABLE_MS).ready, true);
  const body = fullBody();
  body[28].visibility = 0;
  const lost = gate.update(body, 1300);
  assert.equal(lost.ready, false);
  assert.equal(lost.checks.legs, false);
  assert.equal(lost.stableMs, 0);
  assert.equal(gate.update(fullBody(), 1400).ready, false);
  assert.equal(gate.update(fullBody(), 1500).stableMs, 100);
});

test("a long camera gap and repeated cached frames cannot preserve readiness", () => {
  const gate = new CalibrationGate();
  for (let now = 0; now <= 1200; now += 100) gate.update(fullBody(), now);
  assert.equal(gate.update(fullBody(), 2000).ready, false);
  assert.equal(gate.update(fullBody(), 2200, 2000).stableMs, 0);
  assert.equal(gate.update(fullBody(), 2400, 2000).ready, false);
  assert.equal(gate.update(fullBody(), 2400, 2000).fresh, false);
  gate.reset();
  assert.equal(gate.update(fullBody(), 3000).stableMs, 0);
});

test("permission and hardware failures have visible recovery messages", () => {
  assert.match(
    cameraErrorMessage({ name: "NotAllowedError" }),
    /permission was denied/i,
  );
  assert.match(
    cameraErrorMessage({ name: "NotFoundError" }),
    /no compatible camera/i,
  );
  assert.match(
    cameraErrorMessage({ name: "NotReadableError" }),
    /close other apps/i,
  );
});

test("a camera permission result arriving after stop immediately releases its tracks", async () => {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const fakeDocument = new EventTarget();
  fakeDocument.hidden = false;
  const fakeWindow = new EventTarget();
  let resolvePermission;
  let trackStops = 0;
  Object.defineProperty(globalThis, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            resolvePermission = resolve;
          }),
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  const video = { pause() {}, srcObject: null };
  try {
    const camera = new CameraSession(video);
    const pending = camera.start();
    camera.stop();
    resolvePermission({
      getTracks: () => [
        {
          stop: () => {
            trackStops += 1;
          },
        },
      ],
    });
    assert.equal(await pending, false);
    assert.equal(trackStops, 1);
    assert.equal(video.srcObject, null);
  } finally {
    for (const key of ["isSecureContext", "navigator", "document", "window"]) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});

function confirmationFixture() {
  const detected = [];
  let stopped = 0;
  const context = { clearRect() {}, strokeRect() {} };
  const canvas = { width: 1280, height: 720, getContext: () => context };
  const video = {
    readyState: 3,
    currentTime: 1,
    videoWidth: 1280,
    videoHeight: 720,
    pause() {},
  };
  const scanner = new BarcodeScanner(video, canvas, {
    onDetected: (result) => detected.push(result),
  });
  scanner.camera.stop = () => {
    stopped += 1;
  };
  scanner.detector = {
    detect: async () => [
      {
        rawValue: "2176123456789100",
        boundingBox: { x: 200, y: 200, width: 500, height: 80 },
      },
    ],
  };
  return { scanner, detected, stopped: () => stopped };
}

test("a detected card remains live for 600ms, then releases camera before sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = confirmationFixture();
  await fixture.scanner.scan(1000, fixture.scanner.generation);
  assert.equal(fixture.stopped(), 0);
  assert.deepEqual(fixture.detected, []);
  t.mock.timers.tick(599);
  assert.equal(fixture.stopped(), 0);
  t.mock.timers.tick(1);
  assert.equal(fixture.stopped(), 1);
  assert.deepEqual(fixture.detected, [{ code: "2176123456789100" }]);
});

test("leaving the scanner during its confirmation hold cancels pending sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const interrupt of ["stop", "hidden"]) {
    const fixture = confirmationFixture();
    await fixture.scanner.scan(1000, fixture.scanner.generation);
    t.mock.timers.tick(300);
    if (interrupt === "hidden")
      fixture.scanner.camera.onInterrupted(
        "Camera stopped while this tab was hidden.",
      );
    else fixture.scanner.stop();
    t.mock.timers.tick(600);
    assert.equal(fixture.stopped(), 1);
    assert.deepEqual(fixture.detected, []);
  }
});
