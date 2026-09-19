import { CameraSession, cameraErrorMessage, sizeOverlay } from "./camera.js";

export const REQUIRED_STABLE_MS = 1200;
export const MAX_FRAME_AGE_MS = 350;
const GROUPS = Object.freeze({
  shoulders: [11, 12],
  arms: [13, 14, 15, 16],
  hips: [23, 24],
  legs: [25, 26, 27, 28],
});
const CONNECTIONS = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];
const emptyChecks = () => ({
  shoulders: false,
  arms: false,
  hips: false,
  legs: false,
});

/** Both supported exercises require conservative, confident full-body framing. */
export function evaluateLandmarks(
  landmarks,
  { now = 0, capturedAt = now, minVisibility = 0.7, margin = 0.025 } = {},
) {
  const fresh =
    Number.isFinite(now) &&
    Number.isFinite(capturedAt) &&
    now >= capturedAt &&
    now - capturedAt <= MAX_FRAME_AGE_MS;
  const visible = (index) => {
    const landmark = landmarks?.[index];
    return (
      fresh &&
      landmark &&
      Number.isFinite(landmark.x) &&
      Number.isFinite(landmark.y) &&
      landmark.x >= margin &&
      landmark.x <= 1 - margin &&
      landmark.y >= margin &&
      landmark.y <= 1 - margin &&
      Number.isFinite(landmark.visibility) &&
      landmark.visibility >= minVisibility &&
      (landmark.presence === undefined ||
        (Number.isFinite(landmark.presence) &&
          landmark.presence >= minVisibility))
    );
  };
  const checks = Object.fromEntries(
    Object.entries(GROUPS).map(([name, indices]) => [
      name,
      indices.every(visible),
    ]),
  );
  const allVisible = Object.values(checks).every(Boolean);
  let message =
    "Step back / Adjust angle. Keep shoulders, hands, hips, knees, and ankles inside the frame.";
  if (!fresh)
    message =
      "Assessment Unavailable. The camera frame is stale; wait for a live image or restart the camera.";
  else if (!landmarks?.length)
    message =
      "Assessment Unavailable. Stand in view with your whole body visible.";
  else if (!checks.legs)
    message =
      "Step back / Adjust angle. Move far enough back to show both knees and ankles.";
  else if (!checks.arms)
    message =
      "Step back / Adjust angle. Keep both elbows and hands visible, away from your torso.";
  else if (!checks.shoulders || !checks.hips)
    message =
      "Step back / Adjust angle. Face the camera and keep your shoulders and hips in view.";
  else message = "All required joints are visible. Hold this position briefly.";
  return { allVisible, fresh, checks, message };
}

/** Readiness requires uninterrupted fresh observations, never a cached success. */
export class CalibrationGate {
  constructor() {
    this.reset();
  }
  reset() {
    this.stableSince = null;
    this.lastCapturedAt = null;
  }
  update(landmarks, now, capturedAt = now) {
    const result = evaluateLandmarks(landmarks, { now, capturedAt });
    const gap =
      this.lastCapturedAt === null ? 0 : capturedAt - this.lastCapturedAt;
    if (!result.allVisible || gap > MAX_FRAME_AGE_MS || gap < 0)
      this.stableSince = null;
    if (result.allVisible && this.stableSince === null)
      this.stableSince = capturedAt;
    this.lastCapturedAt = capturedAt;
    const stableMs = result.allVisible
      ? Math.max(0, capturedAt - this.stableSince)
      : 0;
    const ready = result.allVisible && stableMs >= REQUIRED_STABLE_MS;
    return {
      ...result,
      ready,
      stableMs,
      requiredStableMs: REQUIRED_STABLE_MS,
      status: ready
        ? "ready"
        : result.allVisible
          ? "stabilizing"
          : "unavailable",
      message: ready
        ? "Ready. Your full body is visible and the camera framing is stable."
        : result.message,
    };
  }
}

export class CameraCalibration {
  constructor(
    video,
    canvas,
    { onUpdate = () => {}, onFrame = () => {}, snapshotFrames = false } = {},
  ) {
    this.video = video;
    this.canvas = canvas;
    this.onUpdate = onUpdate;
    this.onFrame = onFrame;
    this.frameCanvas = snapshotFrames ? document.createElement("canvas") : null;
    this.generation = 0;
    this.gate = new CalibrationGate();
    this.frameRequest = null;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastInferenceAt = -Infinity;
    this.lastFrameAt = -Infinity;
    this.lastStatus = null;
    this.camera = new CameraSession(video, {
      onInterrupted: (message) => {
        this.stop();
        this.emit({
          status: "stopped",
          message: `Assessment Unavailable. ${message}`,
        });
      },
    });
  }

  emit(update) {
    const state = {
      ready: false,
      stableMs: 0,
      requiredStableMs: REQUIRED_STABLE_MS,
      checks: emptyChecks(),
      ...update,
    };
    // Keep stable-progress updates; do not flood screen readers on every missing frame.
    const signature = JSON.stringify({
      ...state,
      stableMs: Math.floor(state.stableMs / 100) * 100,
    });
    if (signature !== this.lastStatus) {
      this.lastStatus = signature;
      this.onUpdate(state);
    }
  }

  async start({ exerciseId = "squat" } = {}) {
    this.stop();
    this.exerciseId = exerciseId;
    const generation = this.generation;
    this.emit({
      status: "loading",
      message: "Allow camera access to check your full-body framing.",
    });
    try {
      if (!(await this.camera.start()) || generation !== this.generation)
        return;
      this.emit({
        status: "loading",
        message: "Loading the on-device joint visibility check…",
      });
      let vision;
      try {
        vision = await import("../vendor/vision_bundle.mjs");
      } catch {
        throw new Error(
          "The joint visibility check could not load. Run the camera asset setup, reload this page, and try again.",
        );
      }
      if (generation !== this.generation) return;
      const wasmRoot = new URL("../vendor/wasm", import.meta.url).href;
      const modelPath = new URL(
        "../vendor/pose_landmarker_lite.task",
        import.meta.url,
      ).href;
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmRoot);
      if (generation !== this.generation) return;
      const landmarker = await vision.PoseLandmarker.createFromOptions(
        fileset,
        {
          baseOptions: { modelAssetPath: modelPath, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.65,
          minPosePresenceConfidence: 0.65,
          minTrackingConfidence: 0.65,
          outputSegmentationMasks: false,
        },
      );
      if (generation !== this.generation) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
      this.lastFrameAt = performance.now();
      this.emit({
        status: "unavailable",
        message:
          "Step back / Adjust angle. Stand a few steps back with your whole body visible.",
      });
      this.frameRequest = requestAnimationFrame((now) =>
        this.tick(now, generation),
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const message = cameraErrorMessage(error);
      this.emit({
        status: "error",
        message: `Assessment Unavailable. ${message}`,
      });
    }
  }

  tick(now, generation) {
    if (generation !== this.generation) return;
    if (this.video.readyState < 2 || this.video.paused || this.video.ended) {
      this.invalidate(
        "Assessment Unavailable. The live camera image is interrupted.",
      );
    } else if (this.video.currentTime === this.lastVideoTime) {
      if (now - this.lastFrameAt > MAX_FRAME_AGE_MS)
        this.invalidate(
          "Assessment Unavailable. The camera frame is stale; restart the camera if it does not recover.",
        );
    } else if (now - this.lastInferenceAt >= 100) {
      try {
        this.lastInferenceAt = now;
        this.lastVideoTime = this.video.currentTime;
        // Live sets infer and encode from the same frozen pixels. The video
        // decoder may otherwise advance while synchronous inference runs.
        const source = this.frameCanvas || this.video;
        if (this.frameCanvas) {
          sizeOverlay(this.video, this.frameCanvas);
          const context = this.frameCanvas.getContext("2d");
          if (!context) throw new Error("Frame buffer unavailable.");
          context.drawImage(
            this.video,
            0,
            0,
            this.frameCanvas.width,
            this.frameCanvas.height,
          );
        }
        const result = this.landmarker.detectForVideo(source, now);
        const observedAt = performance.now();
        this.lastFrameAt = now;
        const landmarks = result.landmarks?.[0];
        const state = this.gate.update(landmarks, observedAt, now);
        this.draw(landmarks, state.ready);
        this.emit(state);
        this.onFrame({
          landmarks,
          worldLandmarks: result.worldLandmarks?.[0],
          now: observedAt,
          capturedAt: now,
          width: this.video.videoWidth,
          height: this.video.videoHeight,
          imageSource: source,
        });
      } catch {
        this.stop();
        this.emit({
          status: "error",
          message:
            "Assessment Unavailable. The joint visibility check stopped. Restart the camera or reload this page.",
        });
        return;
      } finally {
        this.frameCanvas
          ?.getContext("2d")
          ?.clearRect(0, 0, this.frameCanvas.width, this.frameCanvas.height);
      }
    }
    if (generation === this.generation)
      this.frameRequest = requestAnimationFrame((time) =>
        this.tick(time, generation),
      );
  }

  invalidate(message) {
    this.gate.reset();
    this.canvas
      .getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.emit({ status: "unavailable", message });
  }

  draw(landmarks, ready) {
    sizeOverlay(this.video, this.canvas);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!landmarks) return;
    const good = (index) =>
      landmarks[index]?.visibility >= 0.7 &&
      Number.isFinite(landmarks[index]?.x) &&
      Number.isFinite(landmarks[index]?.y);
    context.strokeStyle = ready ? "#72efac" : "#a8c6fb";
    context.fillStyle = context.strokeStyle;
    context.lineWidth = Math.max(2, this.canvas.width / 350);
    for (const [start, end] of CONNECTIONS) {
      if (!good(start) || !good(end)) continue;
      context.beginPath();
      context.moveTo(
        landmarks[start].x * this.canvas.width,
        landmarks[start].y * this.canvas.height,
      );
      context.lineTo(
        landmarks[end].x * this.canvas.width,
        landmarks[end].y * this.canvas.height,
      );
      context.stroke();
    }
    for (const index of Object.values(GROUPS).flat()) {
      if (!good(index)) continue;
      context.beginPath();
      context.arc(
        landmarks[index].x * this.canvas.width,
        landmarks[index].y * this.canvas.height,
        this.canvas.width / 150,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }

  stop() {
    this.generation += 1;
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.camera.stop();
    this.landmarker?.close();
    this.landmarker = null;
    if (this.frameCanvas) {
      this.frameCanvas.width = 0;
      this.frameCanvas.height = 0;
    }
    this.gate.reset();
    this.lastVideoTime = -1;
    this.lastInferenceAt = -Infinity;
    this.lastFrameAt = -Infinity;
    this.lastStatus = null;
    this.canvas
      .getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.emit({
      status: "stopped",
      message:
        "Assessment Unavailable. Start the camera to check your framing.",
    });
  }
}
