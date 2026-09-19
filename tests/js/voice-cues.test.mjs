import test from "node:test";
import assert from "node:assert/strict";
import { VoiceCoach } from "../../app/static/js/voice-cues.js";

function fixture({ autoStart = true, ...options } = {}) {
  let time = 0;
  const spoken = [];
  const displayed = [];
  let cancelled = 0;
  const synthesis = {
    speaking: false,
    pending: false,
    speak(utterance) {
      spoken.push(utterance);
      this.speaking = autoStart;
      this.pending = !autoStart;
      if (autoStart) utterance.onstart?.();
    },
    cancel() {
      cancelled += 1;
      this.speaking = false;
      this.pending = false;
    },
  };
  const coach = new VoiceCoach({
    synthesis,
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    now: () => time,
    onCue: (text) => displayed.push(text),
    ...options,
  });
  return {
    coach,
    synthesis,
    spoken,
    displayed,
    cancelled: () => cancelled,
    at(value) {
      time = value;
    },
    start() {
      synthesis.speaking = true;
      synthesis.pending = false;
      spoken.at(-1).onstart?.();
    },
    end() {
      synthesis.speaking = false;
      synthesis.pending = false;
      spoken.at(-1).onend?.();
    },
    error() {
      synthesis.speaking = false;
      synthesis.pending = false;
      spoken.at(-1).onerror?.({ error: "not-allowed" });
    },
  };
}

test("utterance starts are at least 3500ms apart and rejected cues are not queued", () => {
  const f = fixture();
  assert.equal(f.coach.cue("Keep your chest up."), true);
  f.end();
  f.at(3499);
  assert.equal(f.coach.cue("Slow down."), false);
  f.at(3500);
  assert.equal(f.coach.cue("Keep a steady pace."), true);
  assert.deepEqual(f.displayed, ["Keep your chest up.", "Keep a steady pace."]);
  assert.equal(f.spoken.length, 2);
});

test("delayed starts anchor cooldown to actual playback, not submission", () => {
  const f = fixture({ autoStart: false });
  f.coach.cue("First cue.");
  f.at(5000);
  assert.equal(f.coach.cue("No overlap."), false);
  f.start();
  f.end();
  f.at(8499);
  assert.equal(f.coach.cue("Next cue."), false);
  f.at(8500);
  assert.equal(f.coach.cue("Next cue."), true);
});

test("long utterances and speech owned by another feature cannot overlap", () => {
  const f = fixture();
  f.coach.cue("First cue.");
  f.at(20000);
  assert.equal(f.coach.cue("Still speaking."), false);
  f.end();
  f.synthesis.pending = true;
  assert.equal(f.coach.cue("Another feature is pending."), false);
  f.synthesis.pending = false;
  f.synthesis.speaking = true;
  assert.equal(f.coach.cue("Another feature is speaking."), false);
  f.synthesis.speaking = false;
  assert.equal(f.coach.cue("Ready now."), true);
});

test("form cues sharing a key are deduplicated for ten seconds", () => {
  const f = fixture();
  f.coach.cue("Keep your chest up.", { key: "torso" });
  f.end();
  f.at(9999);
  assert.equal(f.coach.cue("Chest upright.", { key: "torso" }), false);
  f.at(10000);
  assert.equal(f.coach.cue("Chest upright.", { key: "torso" }), true);
});

test("cancellation clears pending playback but preserves cooldown", () => {
  const f = fixture({ autoStart: false });
  f.coach.cue("Old cue.");
  const oldStart = f.spoken[0].onstart;
  f.at(1000);
  f.coach.stop();
  assert.equal(f.cancelled(), 1);
  oldStart();
  f.at(3499);
  assert.equal(f.coach.cue("New cue."), false);
  f.at(3500);
  assert.equal(f.coach.cue("New cue."), true);
});

test("muting cancels speech and unmuting does not bypass cooldown", () => {
  const f = fixture();
  f.coach.cue("First cue.");
  f.coach.setEnabled(false);
  assert.equal(f.cancelled(), 1);
  f.at(10000);
  assert.equal(f.coach.cue("Muted."), false);
  f.coach.setEnabled(true);
  assert.equal(f.coach.cue("Enabled."), true);
  f.coach.setEnabled(false);
  f.coach.setEnabled(true);
  f.at(11000);
  assert.equal(f.coach.cue("Too soon."), false);
});

test("milestones retry after suppression, are spoken once, and reset for a new set", () => {
  const f = fixture();
  f.coach.cue("Set up.");
  f.end();
  f.at(2000);
  assert.equal(f.coach.milestone(1, 8), null);
  f.at(3500);
  assert.match(f.coach.milestone(1, 8), /first rep/i);
  f.end();
  f.at(7000);
  assert.equal(f.coach.milestone(1, 8), null);
  assert.match(f.coach.milestone(4, 8), /halfway/i);
  f.end();
  f.at(10500);
  assert.match(f.coach.milestone(6, 8), /two reps/i);
  f.end();
  f.at(14000);
  assert.match(f.coach.milestone(8, 8), /set complete/i);
  f.end();
  f.at(17500);
  assert.equal(f.coach.milestone(8, 8), null);
  f.coach.resetMilestones();
  assert.match(f.coach.milestone(1, 8), /first rep/i);
});

test("small sets prioritize completion and never play stale milestones", () => {
  const f = fixture();
  assert.match(f.coach.milestone(1, 1), /set complete/i);
  f.end();
  f.at(10000);
  assert.equal(f.coach.milestone(1, 1), null);
  assert.equal(f.coach.milestone(NaN, 8), null);
  assert.equal(f.coach.milestone(0, 8), null);
});

test("speech errors release the active utterance and allow a later retry", () => {
  const f = fixture();
  assert.equal(f.coach.cue("Retry me."), true);
  f.error();
  f.at(3500);
  assert.equal(f.coach.cue("Retry me."), true);
});

test("speech constructor, submission, cancellation, and display errors stay contained", () => {
  const f = fixture();
  f.synthesis.speak = () => {
    throw new Error("Device unavailable");
  };
  assert.equal(f.coach.cue("Unavailable."), false);
  assert.deepEqual(f.displayed, []);
  f.synthesis.cancel = () => {
    throw new Error("No speech engine");
  };
  assert.doesNotThrow(() => f.coach.stop());
  const badConstructor = fixture({
    Utterance: class {
      constructor() {
        throw new Error("Unsupported voice");
      }
    },
  });
  assert.equal(badConstructor.coach.cue("Unavailable."), false);
  const badDisplay = fixture({
    onCue() {
      throw new Error("UI unavailable");
    },
  });
  assert.equal(badDisplay.coach.cue("Still spoken."), true);
});

test("synchronous speech rejection is not reported as accepted", () => {
  const f = fixture();
  f.synthesis.speak = (utterance) => utterance.onerror?.();
  assert.equal(f.coach.cue("Rejected."), false);
  assert.deepEqual(f.displayed, []);
});

test("unsupported browsers and disposal remain safe", () => {
  const f = fixture({ synthesis: null, Utterance: null });
  assert.equal(f.coach.supported, false);
  assert.equal(f.coach.enabled, true);
  assert.equal(f.coach.cue("Text fallback belongs to the UI."), false);
  assert.doesNotThrow(() => f.coach.stop());
  const supported = fixture();
  supported.coach.cue("Finishing.");
  supported.coach.dispose();
  supported.at(10000);
  supported.coach.setEnabled(true);
  assert.equal(supported.coach.cue("Disposed."), false);
  assert.equal(supported.cancelled(), 1);
});
