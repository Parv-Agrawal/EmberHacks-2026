export const CUE_COOLDOWN_MS = 3500;
export const FORM_CUE_DEDUPE_MS = 10000;

/** One utterance at a time. Stale movement advice is discarded, never queued. */
export class VoiceCoach {
  constructor({
    synthesis = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    now = () => performance.now(),
    onCue = () => {},
    onSpeaking = () => {},
  } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.now = now;
    this.onCue = onCue;
    this.onSpeaking = onSpeaking;
    this.supported = Boolean(
      synthesis &&
        typeof synthesis.speak === "function" &&
        typeof synthesis.cancel === "function" &&
        typeof Utterance === "function",
    );
    this.enabled = true;
    this.lastStartedAt = -Infinity;
    this.lastSubmittedAt = -Infinity;
    this.active = null;
    this.recent = new Map();
    this.deliveredMilestones = new Set();
    this.disposed = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.stop();
  }

  cue(text, { key = text } = {}) {
    if (!this.#canSpeak(text) || this.active) return false;
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      now - Math.max(this.lastStartedAt, this.lastSubmittedAt) < CUE_COOLDOWN_MS
    )
      return false;

    // Bound memory even when callers supply changing cue keys.
    for (const [recentKey, submittedAt] of this.recent) {
      if (now - submittedAt >= FORM_CUE_DEDUPE_MS)
        this.recent.delete(recentKey);
    }
    if (this.recent.has(key)) return false;

    return this.#speak(text, now, { key, deduplicate: true });
  }

  /** Post-set findings replace stale cues and are delivered without an in-set delay. */
  headline(text) {
    if (!this.#canSpeak(text)) return false;
    const now = this.now();
    if (!Number.isFinite(now) || !this.stop()) return false;
    return this.#speak(text, now);
  }

  #canSpeak(text) {
    return (
      this.supported &&
      this.enabled &&
      !this.disposed &&
      typeof text === "string" &&
      Boolean(text.trim())
    );
  }

  #speak(text, now, { key, deduplicate = false } = {}) {
    let utterance;
    let failed = false;
    const finish = (isError = false) => {
      if (this.active !== utterance) return;
      failed = isError;
      this.active = null;
      this.onSpeaking(false);
      if (isError && deduplicate) this.recent.delete(key);
      utterance.onstart = null;
      utterance.onend = null;
      utterance.onerror = null;
    };
    try {
      // Respect audio from other page features, too: do not append to its queue.
      if (this.synthesis.speaking || this.synthesis.pending) return false;
      utterance = new this.Utterance(text.trim());
      utterance.rate = 1;
      utterance.onstart = () => {
        if (this.active !== utterance) return;
        const startedAt = this.now();
        if (Number.isFinite(startedAt)) this.lastStartedAt = startedAt;
      };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(true);
      this.active = utterance;
      this.onSpeaking(true);
      // Also throttle browsers that omit the start event or reject speech later.
      this.lastSubmittedAt = now;
      if (deduplicate) this.recent.set(key, now);
      this.synthesis.speak(utterance);
    } catch {
      if (utterance) finish(true);
      return false;
    }
    if (failed) return false;
    try {
      this.onCue(text.trim());
    } catch {
      // A display callback must never interrupt the movement loop.
    }
    return true;
  }

  /** Returns an accepted cue, or null so a suppressed milestone can be retried. */
  milestone(repCount, targetReps) {
    if (
      !Number.isInteger(repCount) ||
      !Number.isInteger(targetReps) ||
      repCount <= 0 ||
      targetReps <= 0
    )
      return null;
    let key;
    let text;
    if (repCount >= targetReps) {
      key = "complete";
      text = "Set complete. Nice effort!";
    } else if (repCount === 1) {
      key = "first";
      text = "First rep complete. Keep it controlled.";
    } else if (repCount === Math.ceil(targetReps / 2)) {
      key = "halfway";
      text = "Halfway there. Keep a steady pace.";
    } else if (repCount >= targetReps - 2) {
      key = "final";
      const remaining = targetReps - repCount;
      text = `${remaining === 1 ? "One rep" : "Two reps"} to go. Stay controlled.`;
    } else return null;
    if (this.deliveredMilestones.has(key)) return null;
    if (!this.cue(text, { key: `milestone:${key}` })) return null;
    this.deliveredMilestones.add(key);
    return text;
  }

  resetMilestones() {
    this.deliveredMilestones.clear();
    for (const key of this.recent.keys()) {
      if (typeof key === "string" && key.startsWith("milestone:"))
        this.recent.delete(key);
    }
  }

  stop() {
    const active = this.active;
    this.active = null;
    if (active) this.onSpeaking(false);
    if (active) {
      active.onstart = null;
      active.onend = null;
      active.onerror = null;
    }
    try {
      this.synthesis?.cancel();
      return true;
    } catch {
      // Speech is optional; cancellation errors cannot stop workout controls.
      return false;
    }
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.enabled = false;
    this.recent.clear();
    this.deliveredMilestones.clear();
  }
}
