import { evaluateLandmarks, MAX_FRAME_AGE_MS } from "./calibration.js";

// Demo heuristics, not clinical measurements. Angles use MediaPipe world space:
// 2D projections of a frontal view cannot reliably distinguish knee/elbow flexion.
// Missing/degenerate world coordinates therefore make assessment unavailable.
export const MOVEMENT_RULES = Object.freeze({
  squat: Object.freeze({
    joints: [
      [23, 25, 27],
      [24, 26, 28],
    ],
    startAngle: 160,
    departAngle: 148,
    minimumFlexion: 140,
    fullFlexion: 105,
    outbound: "eccentric",
    turn: "bottom",
    inbound: "concentric",
  }),
  bicep_curl: Object.freeze({
    joints: [
      [11, 13, 15],
      [12, 14, 16],
    ],
    startAngle: 155,
    departAngle: 140,
    minimumFlexion: 115,
    fullFlexion: 65,
    outbound: "concentric",
    turn: "inflection",
    inbound: "eccentric",
  }),
});
const ARM_DWELL_MS = 300;
const DEPART_DWELL_MS = 120;
const REVERSE_DWELL_MS = 120;
const FINISH_DWELL_MS = 180;
const MIN_REP_MS = 700;
const MAX_REP_MS = 30_000;
const REVERSE_DELTA = 9;
const MAX_TARGET_REPS = 100;

const round = (number, digits = 1) => Number(number.toFixed(digits));
const cloneRep = (rep) => ({ ...rep, faults: [...rep.faults] });

/** An interior joint angle in degrees, or null when geometry is unusable. */
export function jointAngle(a, b, c) {
  if (
    ![a, b, c].every(
      (point) => point && [point.x, point.y, point.z].every(Number.isFinite),
    )
  )
    return null;
  const first = [a.x - b.x, a.y - b.y, a.z - b.z];
  const second = [c.x - b.x, c.y - b.y, c.z - b.z];
  const denominator = Math.hypot(...first) * Math.hypot(...second);
  if (!Number.isFinite(denominator) || denominator < 1e-8) return null;
  const cosine =
    first.reduce((sum, value, index) => sum + value * second[index], 0) /
    denominator;
  if (!Number.isFinite(cosine)) return null;
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

/** Pure, bounded set tracking. It neither owns a camera nor retains images. */
export class MovementTracker {
  constructor({ exerciseId, targetReps }) {
    if (!Object.hasOwn(MOVEMENT_RULES, exerciseId))
      throw new RangeError("Unsupported exercise.");
    if (
      !Number.isInteger(targetReps) ||
      targetReps < 1 ||
      targetReps > MAX_TARGET_REPS
    )
      throw new RangeError(
        `Target reps must be an integer between 1 and ${MAX_TARGET_REPS}.`,
      );
    this.exerciseId = exerciseId;
    this.targetReps = targetReps;
    this.rules = MOVEMENT_RULES[exerciseId];
    this.reps = [];
    this.lastCapturedAt = null;
    this.lastNow = null;
    this.resetPartial();
  }

  resetPartial() {
    this.phase = "start";
    this.armed = false;
    this.startSince = null;
    this.departSince = null;
    this.reverseSince = null;
    this.finishSince = null;
    this.partial = null;
  }

  get done() {
    return this.reps.length >= this.targetReps;
  }

  startMessage() {
    return this.exerciseId === "squat"
      ? "Stand tall with both legs straight briefly to begin."
      : "Lower both arms and hold them straight briefly to begin.";
  }

  snapshot(overrides = {}) {
    return {
      available: true,
      phase: this.done ? "completion" : this.phase,
      repCount: this.reps.length,
      targetReps: this.targetReps,
      angle: null,
      formMessage: this.startMessage(),
      faults: [],
      captureCandidate: false,
      discardCandidate: false,
      completedRep: null,
      done: this.done,
      ...overrides,
    };
  }

  /** Camera loss/pause discards only the incomplete rep, never completed reps. */
  invalidate(
    message = "Assessment Unavailable. Restore full-body visibility, then return to the starting position.",
  ) {
    this.resetPartial();
    return this.snapshot({
      available: false,
      discardCandidate: true,
      formMessage: message,
    });
  }

  update({ landmarks, worldLandmarks, now, capturedAt = now } = {}) {
    const framing = evaluateLandmarks(landmarks, { now, capturedAt });
    const chronological =
      Number.isFinite(now) &&
      Number.isFinite(capturedAt) &&
      (this.lastNow === null || now > this.lastNow) &&
      (this.lastCapturedAt === null || capturedAt > this.lastCapturedAt);
    const gap =
      this.lastCapturedAt === null ? 0 : capturedAt - this.lastCapturedAt;
    // Watermarks never move backward. Repeated cached frames cannot accumulate
    // dwell time, nor can a late inference rewind a partially observed movement.
    if (Number.isFinite(now) && (this.lastNow === null || now > this.lastNow))
      this.lastNow = now;
    if (
      framing.fresh &&
      (this.lastCapturedAt === null || capturedAt > this.lastCapturedAt)
    )
      this.lastCapturedAt = capturedAt;
    if (!chronological)
      return this.invalidate(
        "Assessment Unavailable. Waiting for a new, correctly timed camera frame.",
      );
    if (!framing.allVisible)
      return this.invalidate(
        `Assessment Unavailable. ${framing.message.replace(/^Assessment Unavailable\.\s*/, "")}`,
      );
    if (gap > MAX_FRAME_AGE_MS)
      return this.invalidate(
        "Assessment Unavailable. Camera frames were interrupted. Return to the starting position.",
      );
    const angles = this.rules.joints.map(([a, b, c]) =>
      jointAngle(worldLandmarks?.[a], worldLandmarks?.[b], worldLandmarks?.[c]),
    );
    if (angles.some((angle) => angle === null))
      return this.invalidate(
        "Assessment Unavailable. Reliable 3D joint measurements are missing. Adjust your angle or restart the camera.",
      );
    // Both sides must reach flexion and extension; an average can mistake a
    // one-arm curl for a completed bilateral rep.
    const flexionAngle = Math.max(...angles);
    const extensionAngle = Math.min(...angles);
    const state = this.snapshot({ angle: round(flexionAngle) });
    if (this.done)
      return {
        ...state,
        formMessage: "Set complete. Rest and review your measured reps.",
      };

    if (!this.armed) {
      this.startSince =
        extensionAngle >= this.rules.startAngle
          ? (this.startSince ?? capturedAt)
          : null;
      if (
        this.startSince !== null &&
        capturedAt - this.startSince >= ARM_DWELL_MS
      ) {
        this.armed = true;
        state.formMessage =
          "Ready. Move both sides together at a controlled pace.";
      }
      return state;
    }

    if (!this.partial) {
      this.departSince =
        flexionAngle <= this.rules.departAngle
          ? (this.departSince ?? capturedAt)
          : null;
      state.formMessage =
        "Ready. Move both sides together at a controlled pace.";
      if (
        this.departSince === null ||
        capturedAt - this.departSince < DEPART_DWELL_MS
      )
        return state;
      this.partial = {
        startedAt: this.departSince,
        bottomAt: capturedAt,
        peakAngle: flexionAngle,
        maxAsymmetry: 0,
        asymmetricSince: null,
      };
      this.phase = this.rules.outbound;
      this.departSince = null;
      state.captureCandidate = true;
    }

    const rep = this.partial;
    if (capturedAt - rep.startedAt > MAX_REP_MS)
      return this.invalidate(
        "Assessment Unavailable. This movement took too long to assess. Return to the starting position.",
      );
    // Capture the exact observed pose, not a delayed smoothed-angle minimum.
    // One-degree hysteresis avoids replacing identical candidate images.
    if (flexionAngle < rep.peakAngle - 1) {
      rep.peakAngle = flexionAngle;
      rep.bottomAt = capturedAt;
      state.captureCandidate = true;
    }
    const asymmetry = Math.abs(angles[0] - angles[1]);
    if (asymmetry > 20) {
      rep.asymmetricSince ??= capturedAt;
      if (capturedAt - rep.asymmetricSince >= 150)
        rep.maxAsymmetry = Math.max(rep.maxAsymmetry, asymmetry);
    } else rep.asymmetricSince = null;

    if (
      this.phase === this.rules.outbound &&
      flexionAngle <= this.rules.fullFlexion
    )
      this.phase = this.rules.turn;
    if (this.phase === this.rules.outbound || this.phase === this.rules.turn) {
      const reversed = flexionAngle >= rep.peakAngle + REVERSE_DELTA;
      this.reverseSince = reversed ? (this.reverseSince ?? capturedAt) : null;
      if (
        this.reverseSince !== null &&
        capturedAt - this.reverseSince >= REVERSE_DWELL_MS
      ) {
        // A shallow turn is still an inflection, visible for one observation.
        if (this.phase === this.rules.outbound) this.phase = this.rules.turn;
        else this.phase = this.rules.inbound;
      }
    }
    // A bounce to deeper flexion after beginning the return remains the same
    // rep and requires a fresh, sustained reversal before it can finish.
    if (
      this.phase === this.rules.inbound &&
      flexionAngle <= rep.peakAngle + 3
    ) {
      this.phase = this.rules.turn;
      this.reverseSince = null;
      this.finishSince = null;
    }
    state.phase = this.phase;
    if (rep.maxAsymmetry > 20) state.faults.push("uneven_range");
    // Range is only assessable after the observed turn, never while the user
    // could still be lowering/curling farther in this rep.
    if (
      this.phase === this.rules.inbound &&
      rep.peakAngle > this.rules.fullFlexion
    )
      state.faults.push(
        this.exerciseId === "squat" ? "shallow_depth" : "limited_curl_range",
      );
    state.formMessage =
      this.faultMessage(state.faults) || this.movementMessage(rep);

    if (this.phase === this.rules.inbound) {
      this.finishSince =
        extensionAngle >= this.rules.startAngle
          ? (this.finishSince ?? capturedAt)
          : null;
      if (
        this.finishSince !== null &&
        capturedAt - this.finishSince >= FINISH_DWELL_MS
      ) {
        const duration = capturedAt - rep.startedAt;
        if (
          rep.peakAngle > this.rules.minimumFlexion ||
          duration < MIN_REP_MS
        ) {
          this.resetPartial();
          return {
            ...state,
            phase: "start",
            discardCandidate: true,
            captureCandidate: false,
            formMessage:
              "Partial movement skipped. Return to the starting position and use a controlled range.",
          };
        }
        const faults = [];
        if (rep.peakAngle > this.rules.fullFlexion)
          faults.push(
            this.exerciseId === "squat"
              ? "shallow_depth"
              : "limited_curl_range",
          );
        if (rep.maxAsymmetry > 20) faults.push("uneven_range");
        if (duration < 1400) faults.push("fast_cadence");
        const score = round(
          Math.max(0, rep.peakAngle - this.rules.fullFlexion) +
            Math.max(0, rep.maxAsymmetry - 20) / 2 +
            (duration < 1400 ? 20 : 0),
        );
        const completedRep = {
          rep_number: this.reps.length + 1,
          started_at_ms: round(rep.startedAt),
          bottom_at_ms: round(rep.bottomAt),
          completed_at_ms: round(capturedAt),
          peak_angle_deg: round(rep.peakAngle),
          cadence_seconds: round(duration / 1000, 2),
          faults,
          score,
        };
        this.reps.push(completedRep);
        this.resetPartial();
        // Completion itself is a sustained start pose, so the next rep may
        // depart immediately; an interruption still forces a complete re-arm.
        this.armed = true;
        this.phase = "completion";
        return this.snapshot({
          angle: round(flexionAngle),
          completedRep: cloneRep(completedRep),
          faults: [...faults],
          formMessage: `${this.done ? "Set complete." : `Rep ${this.reps.length} complete.`} ${
            this.faultMessage(faults) ||
            (this.done
              ? "Rest and review your measured reps."
              : "Reset and continue with control.")
          }`,
        });
      }
    }
    return state;
  }

  faultMessage(faults) {
    if (faults.includes("uneven_range"))
      return "Move both sides together through a similar range.";
    if (faults.includes("shallow_depth"))
      return "On your next rep, lower a little further within a comfortable range.";
    if (faults.includes("limited_curl_range"))
      return "On your next rep, curl both hands closer to your shoulders.";
    if (faults.includes("fast_cadence"))
      return "Slow down and control the next rep in both directions.";
    return "";
  }

  movementMessage(rep) {
    if (rep.maxAsymmetry > 20)
      return "Move both sides together through a similar range.";
    if (this.exerciseId === "squat")
      return this.phase === "concentric"
        ? "Stand tall with control."
        : this.phase === "bottom"
          ? "Reverse smoothly and stand tall."
          : "Lower at a controlled pace within a comfortable range.";
    return this.phase === "eccentric"
      ? "Lower both arms with control."
      : this.phase === "inflection"
        ? "Reverse smoothly; keep your elbows steady."
        : "Curl both arms smoothly; keep your elbows steady.";
  }

  summary() {
    return {
      exercise_id: this.exerciseId,
      target_reps: this.targetReps,
      completed_reps: this.reps.length,
      reps: this.reps.map(cloneRep),
      detected_faults: [...new Set(this.reps.flatMap((rep) => rep.faults))],
    };
  }
}
