import { CameraCalibration, MAX_FRAME_AGE_MS } from "./calibration.js";
import { MovementTracker } from "./movement.js";
import { WorstRepBuffer } from "./keyframes.js";
import { VoiceCoach } from "./voice-cues.js";

const $ = (id) => document.getElementById(id);
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const text = (id, value) => {
  if ($(id).textContent !== String(value)) $(id).textContent = value;
};

/** One active set and one completed-set preview; no persistence or network calls. */
export class LiveWorkout {
  constructor({ onExit }) {
    this.onExit = onExit;
    this.stage = "idle";
    this.frames = new WorstRepBuffer();
    this.voice = new VoiceCoach({
      onCue: (cue) => {
        this.cueUntil = performance.now() + 3500;
        text("live-cue", cue);
      },
    });
    this.camera = new CameraCalibration(
      $("workout-video"),
      $("workout-overlay"),
      {
        onUpdate: (update) => this.onCamera(update),
        onFrame: (frame) => this.onFrame(frame),
        snapshotFrames: true,
      },
    );
    $("live-enable").addEventListener("click", () => this.enableCamera());
    $("live-begin").addEventListener("click", () => this.begin());
    $("live-pause").addEventListener("click", () => this.pause());
    $("live-finish").addEventListener("click", () => this.finish(false));
    $("live-next").addEventListener("click", () => this.next());
    $("live-exit").addEventListener("click", () => this.onExit());
    $("live-mute").addEventListener("click", () => {
      this.voice.setEnabled(!this.voice.enabled);
      this.renderVoice();
    });
    this.onHidden = () => {
      if (document.hidden && ["active", "preparing"].includes(this.stage))
        this.pause();
      else if (document.hidden) this.voice.stop();
    };
    document.addEventListener("visibilitychange", this.onHidden);
    this.renderVoice();
  }

  open(workout) {
    this.dispose();
    this.workout = structuredClone(workout);
    this.exerciseIndex = 0;
    this.setIndex = 0;
    this.interval = setInterval(() => this.renderTime(), 200);
    this.prepare();
  }

  get exercise() {
    return this.workout.exercises[this.exerciseIndex];
  }

  prepare() {
    this.stage = "preparing";
    this.cameraState = null;
    this.elapsed = 0;
    this.activeSince = null;
    this.lastSnapshot = null;
    this.cueUntil = 0;
    this.tracker = new MovementTracker({
      exerciseId: this.exercise.id,
      targetReps: this.exercise.reps,
    });
    this.frames.clear();
    this.voice.stop();
    this.voice.resetMilestones();
    $("worst-keyframe").removeAttribute("src");
    $("set-result").hidden = true;
    text("set-data", "");
    text("live-title", this.exercise.name);
    text(
      "live-set-label",
      `Exercise ${this.exerciseIndex + 1} of ${this.workout.exercises.length} · Set ${this.setIndex + 1} of ${this.exercise.sets}`,
    );
    text("live-target", this.exercise.reps);
    text("live-count", 0);
    text("live-angle", "—");
    text("live-phase", "Find your starting position");
    text(
      "live-cue",
      "Enable the camera, find your frame, then start your set.",
    );
    text(
      "live-placement",
      this.exercise.id === "squat"
        ? "Use a slight three-quarter view so both knees, hips, and ankles stay visible. Begin standing tall; bend and return to standing."
        : "Face the camera at a slight angle with both arms visible. Start with arms lowered, curl both together, then lower with control.",
    );
    text("live-begin", "Start set");
    this.camera.stop();
    this.renderControls();
    this.renderTime();
  }

  async enableCamera() {
    if (!["preparing", "paused"].includes(this.stage)) return;
    this.stage = "preparing";
    this.cameraState = null;
    await this.camera.start({ exerciseId: this.exercise.id });
  }

  onCamera(update) {
    this.cameraState = update;
    if (this.stage === "idle" || this.stage === "finished") return;
    const failed = ["stopped", "error"].includes(update.status);
    if (this.stage === "active" && !update.ready) {
      // Every visibility failure abandons the unfinished rep and its frame.
      // A fresh stable view is required before feeding measurements again.
      this.tracker.invalidate();
      this.frames.discardPartial();
      this.voice.stop();
      text("live-angle", "—");
      text("live-phase", "Return to the starting position");
      if (failed) {
        this.freezeTime();
        this.stage = "paused";
      }
    }
    const ready = update.ready && this.stage !== "paused";
    text("live-badge", ready ? "Ready" : "Assessment Unavailable");
    $("live-badge").classList.toggle("ready", ready);
    text("live-status", update.message);
    $("workout-placeholder").hidden = Boolean($("workout-video").srcObject);
    this.renderControls();
  }

  begin() {
    if (
      this.stage !== "preparing" ||
      !this.cameraState?.ready ||
      performance.now() - this.camera.lastFrameAt > MAX_FRAME_AGE_MS ||
      document.hidden
    )
      return;
    this.stage = "active";
    this.activeSince = performance.now();
    this.tracker.invalidate();
    this.frames.discardPartial();
    text(
      "live-cue",
      "Start tall with your arms lowered. Only complete, visible repetitions count.",
    );
    this.voice.cue("Start in your resting position. Move at your own pace.", {
      key: "start",
    });
    this.renderControls();
  }

  onFrame(frame) {
    if (this.stage !== "active") return;
    if (!this.cameraState?.ready) return;
    const snapshot = this.tracker.update(frame);
    this.lastSnapshot = snapshot;
    this.frames.observe(snapshot, frame.imageSource || $("workout-video"));
    text("live-count", snapshot.repCount);
    text(
      "live-angle",
      Number.isFinite(snapshot.angle) ? `${Math.round(snapshot.angle)}°` : "—",
    );
    text("live-phase", snapshot.phase.replaceAll("_", " "));
    text(
      "live-badge",
      snapshot.available ? "Tracking" : "Assessment Unavailable",
    );
    $("live-badge").classList.toggle("ready", snapshot.available);
    text("live-status", snapshot.formMessage);
    if (snapshot.done) {
      this.finish(true);
      this.voice.milestone(snapshot.repCount, snapshot.targetReps);
      return;
    }
    if (!snapshot.available) {
      this.voice.stop();
      text("live-cue", snapshot.formMessage);
    } else {
      if (performance.now() >= this.cueUntil)
        text("live-cue", snapshot.formMessage);
      // Current form takes priority; stale speech is never queued for later.
      if (snapshot.faults.length)
        this.voice.cue(snapshot.formMessage, {
          key: snapshot.faults.join(","),
        });
      else this.voice.milestone(snapshot.repCount, snapshot.targetReps);
    }
  }

  freezeTime() {
    if (this.activeSince !== null)
      this.elapsed += performance.now() - this.activeSince;
    this.activeSince = null;
  }

  pause() {
    if (!["active", "preparing"].includes(this.stage)) return;
    this.freezeTime();
    this.stage = "paused";
    this.tracker.invalidate();
    this.frames.discardPartial();
    this.voice.stop();
    this.camera.stop();
    text(
      "live-cue",
      "Paused. Completed reps are kept. Recheck the camera to resume from the starting position.",
    );
    text("live-begin", "Resume set");
    this.renderControls();
  }

  finish(targetReached) {
    if (!["active", "paused", "preparing"].includes(this.stage)) return;
    this.freezeTime();
    this.stage = "finished";
    this.camera.stop();
    this.voice.stop();
    this.tracker.invalidate();
    this.frames.discardPartial();
    const summary = this.tracker.summary();
    this.restUntil = performance.now() + this.exercise.rest_seconds * 1000;
    text("live-badge", "Camera is off");
    $("live-badge").classList.remove("ready");
    $("workout-placeholder").hidden = false;
    text("live-phase", "Set ended");
    text("live-angle", "—");
    text(
      "live-status",
      `${summary.completed_reps} of ${this.exercise.reps} reps completed. Unfinished reps are excluded.`,
    );
    text(
      "live-cue",
      targetReached
        ? "Target reached. Take a breather—you earned it."
        : "Set ended. Take the time you need.",
    );
    text(
      "set-result-title",
      targetReached ? "Set complete. Nice work." : "Your set, at a glance.",
    );
    const worst = this.frames.worst;
    $("worst-keyframe").hidden = !worst?.image;
    if (worst?.image) $("worst-keyframe").src = worst.image;
    else $("worst-keyframe").removeAttribute("src");
    text(
      "keyframe-caption",
      worst
        ? `Rep ${worst.rep.rep_number} · ${this.exercise.id === "squat" ? "bottom position" : "curl inflection"} · ${worst.rep.faults.length ? worst.rep.faults.join(", ").replaceAll("_", " ") : "no flagged faults; earliest rep selected on a tie"}${worst.image ? "" : " · Image unavailable"}`
        : "No complete reps yet. There is no keyframe to review.",
    );
    text("set-data", JSON.stringify(summary, null, 2));
    $("set-result").hidden = false;
    text(
      "live-next",
      this.hasNext() ? "Prepare next set" : "Back to workout plan",
    );
    this.renderControls();
    this.renderTime();
  }

  hasNext() {
    return (
      this.setIndex + 1 < this.exercise.sets ||
      this.exerciseIndex + 1 < this.workout.exercises.length
    );
  }

  next() {
    if (this.stage !== "finished") return;
    if (!this.hasNext()) {
      this.onExit();
      return;
    }
    if (performance.now() < this.restUntil) return;
    if (this.setIndex + 1 < this.exercise.sets) this.setIndex += 1;
    else {
      this.exerciseIndex += 1;
      this.setIndex = 0;
    }
    this.prepare();
  }

  renderVoice() {
    $("live-mute").disabled = !this.voice.supported;
    $("live-mute").setAttribute(
      "aria-pressed",
      String(this.voice.enabled && this.voice.supported),
    );
    text(
      "live-mute",
      !this.voice.supported
        ? "Voice unavailable · text cues on"
        : this.voice.enabled
          ? "Spoken cues on"
          : "Spoken cues off",
    );
  }

  renderControls() {
    const preparing = this.stage === "preparing";
    const cameraBusy = [
      "loading",
      "unavailable",
      "stabilizing",
      "ready",
    ].includes(this.cameraState?.status);
    $("live-enable").hidden = !(
      this.stage === "paused" ||
      (preparing && !cameraBusy)
    );
    text(
      "live-enable",
      this.stage === "paused" || this.elapsed > 0
        ? "Recheck camera"
        : "Enable camera",
    );
    $("live-begin").hidden = !preparing;
    $("live-begin").disabled = !this.cameraState?.ready;
    $("live-pause").hidden = !["active", "preparing"].includes(this.stage);
    $("live-finish").hidden = !["active", "paused"].includes(this.stage);
    $("live-next").hidden = this.stage !== "finished";
  }

  renderTime() {
    if (this.stage === "idle") return;
    text(
      "live-time",
      clock(
        this.elapsed +
          (this.activeSince === null
            ? 0
            : performance.now() - this.activeSince),
      ),
    );
    if (this.stage === "finished") {
      const remaining = Math.max(0, this.restUntil - performance.now());
      text(
        "live-rest",
        this.hasNext()
          ? `Planned rest · ${clock(remaining)} remaining`
          : "All planned sets have ended.",
      );
      $("live-next").disabled = this.hasNext() && remaining > 0;
    }
  }

  dispose() {
    this.stage = "idle";
    this.camera.stop();
    this.voice.stop();
    this.frames.clear();
    this.tracker = null;
    this.workout = null;
    this.lastSnapshot = null;
    this.cameraState = null;
    clearInterval(this.interval);
    this.interval = null;
    $("worst-keyframe").removeAttribute("src");
    text("set-data", "");
    $("set-result").hidden = true;
  }
}
