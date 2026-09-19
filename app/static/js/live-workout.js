import { CameraCalibration, MAX_FRAME_AGE_MS } from "./calibration.js";
import { MovementTracker } from "./movement.js";
import { WorstRepBuffer } from "./keyframes.js";
import { VoiceCoach } from "./voice-cues.js";
import { CoachReview } from "./coach-review.js";
import { VoiceCommands } from "./voice-commands.js";
import { SessionHistory } from "./session-history.js";
import { SessionSummary } from "./session-summary.js";
import { reportsPain } from "./adaptation.js";

const $ = (id) => document.getElementById(id);
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const text = (id, value) => {
  if ($(id).textContent !== String(value)) $(id).textContent = value;
};

/** One active set and one review; only an explicit review sends a workout frame. */
export class LiveWorkout {
  constructor({ onExit, requestCoach, onHelp }) {
    this.onHelp = onHelp;
    this.onExit = onExit;
    this.stage = "idle";
    this.history = new SessionHistory();
    this.sessionSummary = new SessionSummary();
    this.frames = new WorstRepBuffer();
    this.voice = new VoiceCoach({
      onSpeaking: (speaking) => this.syncListening(speaking),
      onCue: (cue) => {
        this.lastSpoken = cue;
        this.cueUntil = performance.now() + 3500;
        text("live-cue", cue);
      },
    });
    this.commands = new VoiceCommands({
      onCommand: (command) => this.handleCommand(command),
      onStatus: ({ message }) => {
        text("voice-command-status", message);
        $("live-listen").setAttribute(
          "aria-pressed",
          String(Boolean(this.commands?.enabled)),
        );
        text(
          "live-listen",
          this.commands?.enabled
            ? "Turn microphone off"
            : "Enable voice commands",
        );
      },
      canListen: () =>
        !document.hidden &&
        !this.voice.active &&
        !this.voice.synthesis?.speaking &&
        !this.voice.synthesis?.pending &&
        ["preparing", "active", "paused", "finished"].includes(this.stage),
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
    this.review = new CoachReview({
      requestCoach,
      voice: this.voice,
      onPain: () => this.stopForPain(),
      onDecision: (proposal) => this.acceptProposal(proposal),
    });
    $("live-pain").addEventListener("click", () => this.stopForPain());
    $("live-enable").addEventListener("click", () => this.enableCamera());
    $("live-begin").addEventListener("click", () => this.begin());
    $("live-pause").addEventListener("click", () => this.pause());
    $("live-finish").addEventListener("click", () => this.finish(false));
    $("live-next").addEventListener("click", () => this.next());
    $("live-exit").addEventListener("click", () => this.endSession());
    $("summary-exit").addEventListener("click", () => this.onExit());
    $("live-listen").addEventListener("click", () => {
      if (this.commands.enabled) this.commands.stop();
      else this.commands.start();
    });
    $("live-repeat").addEventListener("click", () =>
      this.handleCommand({ type: "repeat" }),
    );
    $("live-more-rest").addEventListener("click", () => this.moreRest());
    $("live-help").addEventListener("click", () => this.requestHelp());
    $("live-mute").addEventListener("click", () => {
      this.voice.setEnabled(!this.voice.enabled);
      this.renderVoice();
    });
    this.onHidden = () => {
      if (document.hidden) {
        this.commands.stop();
        this.resumeWhenReady = false;
      }
      if (document.hidden && ["active", "preparing"].includes(this.stage))
        this.pause();
      else if (document.hidden) this.voice.stop();
    };
    document.addEventListener("visibilitychange", this.onHidden);
    this.renderVoice();
  }

  open(workout, { camera = null } = {}) {
    this.dispose();
    $("workout-live-shell").hidden = false;
    $("session-summary").hidden = true;
    $("view-workout").setAttribute("aria-labelledby", "live-title");
    $("live-listen").disabled = !this.commands.supported;
    if (!this.commands.supported)
      text(
        "voice-command-status",
        "Voice commands are unavailable in this browser. Use the visible buttons.",
      );
    this.workout = structuredClone(workout);
    this.exerciseIndex = 0;
    this.setIndex = 0;
    this.blockedExercises = new Set();
    this.interval = setInterval(() => this.renderTime(), 200);
    this.prepare();
    if (camera) {
      text("live-cue", "Your camera is connected. Find your starting position, then start your set.");
      void this.camera.takeOver(camera, { exerciseId: this.exercise.id });
    }
  }

  get exercise() {
    return this.activeExercise || this.workout.exercises[this.exerciseIndex];
  }

  prepare(override = null) {
    this.review.reset();
    this.setFeedback = "";
    text("voice-action-status", "");
    $("set-effort").value = "";
    this.manualRestUntil = 0;
    this.resumeWhenReady = false;
    this.pendingAdaptation = null;
    this.activeExercise = { ...this.workout.exercises[this.exerciseIndex] };
    if (override) {
      this.activeExercise.reps = override.reps;
      this.activeExercise.rest_seconds = override.rest_seconds;
    }
    this.painStopped = false;
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
    await this.camera.start({ exerciseId: this.exercise.id, fullBody: false });
  }

  onCamera(update) {
    this.cameraState = update;
    if (["idle", "finished", "summary"].includes(this.stage)) return;
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
    if (ready && this.resumeWhenReady) this.begin();
  }

  begin() {
    if (
      this.stage !== "preparing" ||
      !this.cameraState?.ready ||
      performance.now() - this.camera.lastFrameAt > MAX_FRAME_AGE_MS ||
      document.hidden ||
      this.blockedExercises.has(this.exercise.id)
    )
      return;
    this.resumeWhenReady = false;
    this.stage = "active";
    this.activeSince = performance.now();
    this.tracker.invalidate();
    this.frames.discardPartial();
    text(
      "live-cue",
      this.exercise.id === "squat"
        ? "Stand tall, then squat and return to standing. Keep your hips, knees, and ankles visible."
        : "Start with both arms lowered, curl, then lower with control. Keep both arms visible.",
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
    this.resumeWhenReady = false;
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
    this.resumeWhenReady = false;
    this.freezeTime();
    this.stage = "finished";
    this.camera.stop();
    this.voice.stop();
    this.tracker.invalidate();
    this.frames.discardPartial();
    const summary = this.tracker.summary();
    this.finishedAt = performance.now();
    this.restUntil = this.finishedAt + this.exercise.rest_seconds * 1000;
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
    this.currentSetId = `${this.exerciseIndex}:${this.setIndex}`;
    this.history.recordSet({
      id: this.currentSetId,
      exercise: this.exercise,
      setNumber: this.setIndex + 1,
      summary,
      elapsedMs: this.elapsed,
      keyframes: this.frames.completed,
      stoppedForPain: this.painStopped,
    });
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
    this.review.open({
      summary,
      image: worst?.image || null,
      keyframes: this.frames.completed
        .filter((frame) => frame.image)
        .map((frame) => ({ rep_number: frame.rep.rep_number, image: frame.image })),
      exercise: this.exercise,
      hasNextSet: !this.painStopped && this.setIndex + 1 < this.exercise.sets,
    });
    if (this.setFeedback && !this.painStopped) {
      $("coach-feedback").value = this.setFeedback;
      this.review.feedbackChanged({ committed: true });
    }
    text(
      "live-next",
      this.hasNext() ? "Prepare next set" : "View session summary",
    );
    this.renderControls();
    this.renderTime();
  }

  hasNext() {
    return (
      (!this.painStopped && this.setIndex + 1 < this.exercise.sets) ||
      this.exerciseIndex + 1 < this.workout.exercises.length
    );
  }

  next() {
    if (this.stage !== "finished") return;
    if (!this.painStopped && reportsPain($("coach-feedback").value)) {
      this.stopForPain();
      return;
    }
    if (!this.hasNext()) {
      this.endSession();
      return;
    }
    if (performance.now() < this.restUntil) return;
    this.saveReview();
    const sameExercise =
      !this.painStopped && this.setIndex + 1 < this.exercise.sets;
    const override = sameExercise
      ? this.pendingAdaptation || this.exercise
      : null;
    if (sameExercise) this.setIndex += 1;
    else {
      this.exerciseIndex += 1;
      this.setIndex = 0;
    }
    this.prepare(override);
  }

  acceptProposal(proposal) {
    if (this.stage !== "finished" || this.painStopped) return;
    this.pendingAdaptation = proposal;
    this.restUntil = Math.max(
      this.manualRestUntil || 0,
      this.finishedAt +
        (proposal?.rest_seconds ?? this.exercise.rest_seconds) * 1000,
    );
    this.renderTime();
  }

  stopForPain() {
    if (
      !this.tracker ||
      ["idle", "summary"].includes(this.stage) ||
      this.painStopped
    )
      return;
    this.blockedExercises.add(this.exercise.id);
    this.painStopped = true;
    this.pendingAdaptation = null;
    this.review.cancel();
    this.voice.stop();
    if (this.stage !== "finished") this.finish(false);
    else this.camera.stop();
    this.tracker.invalidate();
    this.frames.discardPartial();
    this.review.markPain();
    this.history.recordSet({
      id: this.currentSetId,
      exercise: this.exercise,
      setNumber: this.setIndex + 1,
      summary: this.tracker.summary(),
      elapsedMs: this.elapsed,
      keyframes: this.frames.completed,
      stoppedForPain: true,
    });
    text("live-badge", "Exercise stopped");
    text("live-phase", "Stopped after pain report");
    text("set-result-title", "This exercise is stopped.");
    text(
      "live-status",
      "You reported pain. Remaining sets of this exercise are skipped for this workout.",
    );
    text(
      "live-cue",
      "Stop this movement. Take a break; you can end your workout here.",
    );
    text(
      "live-next",
      this.hasNext() ? "Skip to the next exercise" : "View session summary",
    );
    this.renderControls();
    this.renderTime();
  }

  syncListening(speaking) {
    clearTimeout(this.listenTimer);
    if (speaking) this.commands?.suspend();
    else if (this.commands?.enabled) {
      this.listenTimer = setTimeout(() => this.commands.resume(), 500);
    }
  }

  async handleCommand({ type, text: transcript = "" }) {
    if (document.hidden || ["idle", "summary"].includes(this.stage)) return;
    if (type === "help") return this.requestHelp("voice");
    if (type === "pain") return this.stopForPain();
    if (type === "pause") return this.pause();
    if (type === "resume") {
      if (this.stage === "paused") {
        this.resumeWhenReady = true;
        await this.enableCamera();
      } else if (this.stage === "preparing") {
        if (this.cameraState?.ready) this.begin();
        else {
          this.resumeWhenReady = true;
          await this.enableCamera();
        }
      }
      return;
    }
    if (type === "more_rest") return this.moreRest();
    if (type === "repeat") {
      if (this.lastSpoken) {
        text("live-cue", this.lastSpoken);
        this.voice.headline(this.lastSpoken);
      } else text("live-cue", "No spoken cue to repeat yet.");
      return;
    }
    const feedback = {
      easy: "Felt easy",
      fatigue: "I felt fatigued",
      balance: "I felt off-balance",
    }[type];
    if (!feedback || this.painStopped) return;
    if (type === "balance" && this.stage === "active") this.pause();
    // Keep distinct reports from this set; a later easy report cannot erase balance concerns.
    const prior =
      this.stage === "finished" ? $("coach-feedback").value : this.setFeedback;
    this.setFeedback = prior.includes(feedback)
      ? prior
      : [prior, feedback].filter(Boolean).join(". ").slice(0, 500);
    if (this.stage === "finished") {
      $("coach-feedback").value = this.setFeedback;
      this.review.feedbackChanged({ committed: true });
    }
    text(
      "voice-action-status",
      `${feedback}. Saved for this set’s check-in. No review was sent.`,
    );
  }

  moreRest() {
    if (["idle", "summary"].includes(this.stage)) return;
    if (this.stage !== "finished") {
      this.pause();
      text(
        "voice-action-status",
        "Paused for a break. Say Resume or recheck the camera when ready.",
      );
      return;
    }
    this.manualRestUntil = Math.min(
      Math.max(performance.now(), this.restUntil) + 30000,
      performance.now() + 120000,
    );
    this.restUntil = this.manualRestUntil;
    this.renderTime();
    text(
      "voice-action-status",
      "Rest extended by up to 30 seconds, to a maximum of two minutes remaining.",
    );
  }

  saveReview() {
    if (!this.currentSetId) return;
    this.history.updateReview(this.currentSetId, {
      feedback: $("coach-feedback").value || "",
      effort:
        $("set-effort").value === "" ? null : Number($("set-effort").value),
      coaching: this.review.lastFeedback || null,
      adaptation: this.pendingAdaptation || null,
    });
  }

  requestHelp(trigger = "button") {
    if (this.onHelp) return this.onHelp({ trigger });
    // Standalone tracking fixtures retain a local stop when no SOS UI is mounted.
    this.commands.stop();
    this.review.cancel();
    this.voice.stop();
    this.endSession({ helpRequested: true });
  }

  endSession({ helpRequested = false } = {}) {
    if (["idle", "summary"].includes(this.stage)) return;
    this.commands.stop();
    this.review.cancel();
    if (this.stage !== "finished") this.finish(false);
    this.saveReview();
    this.stage = "summary";
    this.camera.stop();
    this.voice.stop();
    clearTimeout(this.listenTimer);
    clearInterval(this.interval);
    this.interval = null;
    this.resumeWhenReady = false;
    this.review.reset();
    this.frames.clear();
    this.tracker = null;
    this.lastSnapshot = null;
    $("worst-keyframe").removeAttribute("src");
    text("set-data", "");
    $("workout-live-shell").hidden = true;
    $("session-summary").hidden = false;
    $("view-workout").setAttribute("aria-labelledby", "summary-title");
    this.sessionSummary.open(this.history, { helpRequested });
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
    $("live-pain").hidden =
      ["idle", "summary"].includes(this.stage) || this.painStopped;
  }

  renderTime() {
    if (["idle", "summary"].includes(this.stage)) return;
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
          : this.painStopped
            ? "Remaining sets of this exercise were skipped."
            : "All planned sets have ended.",
      );
      $("live-next").disabled = this.hasNext() && remaining > 0;
    }
  }

  dispose() {
    this.stage = "idle";
    this.commands?.stop();
    clearTimeout(this.listenTimer);
    this.resumeWhenReady = false;
    this.history.clear();
    this.sessionSummary.clear();
    this.currentSetId = null;
    $("set-effort").value = "";
    this.lastSpoken = "";
    this.setFeedback = "";
    text("voice-action-status", "");
    this.review?.reset();
    this.camera.stop();
    this.voice.stop();
    this.frames.clear();
    this.tracker = null;
    this.workout = null;
    this.activeExercise = null;
    this.pendingAdaptation = null;
    this.lastSnapshot = null;
    this.cameraState = null;
    clearInterval(this.interval);
    this.interval = null;
    $("worst-keyframe").removeAttribute("src");
    text("set-data", "");
    $("set-result").hidden = true;
  }
}
