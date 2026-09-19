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

test("post-set headlines speak immediately after a cue and bypass cue deduplication", () => {
  const f = fixture();
  assert.equal(f.coach.cue("Keep your chest up."), true);
  f.end();
  f.at(100);
  assert.equal(f.coach.headline("Keep your chest up."), true);
  assert.deepEqual(f.displayed, ["Keep your chest up.", "Keep your chest up."]);
  f.end();
  f.at(3599);
  assert.equal(f.coach.cue("Next set."), false);
  f.at(3600);
  assert.equal(f.coach.cue("Next set."), true);
});

test("headlines cancel active and queued in-set speech without reviving stale events", () => {
  for (const autoStart of [true, false]) {
    const f = fixture({ autoStart });
    f.coach.cue("Old movement cue.");
    const old = f.spoken[0];
    const oldStart = old.onstart;
    const oldEnd = old.onend;
    f.at(1000);
    assert.equal(f.coach.headline("Rep four was shallower."), true);
    assert.equal(f.cancelled(), 1);
    assert.equal(old.onstart, null);
    assert.equal(old.onend, null);
    assert.equal(old.onerror, null);
    f.at(2000);
    oldStart();
    oldEnd();
    assert.equal(f.coach.active, f.spoken[1]);
    assert.equal(f.coach.lastStartedAt, autoStart ? 1000 : -Infinity);
    assert.equal(f.spoken.length, 2);
    assert.equal(f.coach.cue("Never queue this."), false);
  }
});

test("later in-set cues wait 3500ms after the actual headline start", () => {
  const f = fixture({ autoStart: false });
  assert.equal(f.coach.headline("A controlled set."), true);
  f.at(6000);
  f.start();
  f.end();
  f.at(9499);
  assert.equal(f.coach.cue("Next set."), false);
  f.at(9500);
  assert.equal(f.coach.cue("Next set."), true);
});

test("a newer headline replaces the previous headline without cooldown or deduplication", () => {
  const f = fixture();
  f.coach.headline("A controlled set.");
  f.at(1000);
  assert.equal(f.coach.headline("A controlled set."), true);
  assert.equal(f.cancelled(), 2);
  f.end();
  f.at(4499);
  assert.equal(f.coach.cue("Next set."), false);
  f.at(4500);
  assert.equal(f.coach.cue("Next set."), true);
});

test("muted, unsupported, disposed, and invalid headlines do not interrupt speech", () => {
  const muted = fixture();
  muted.coach.setEnabled(false);
  assert.equal(muted.coach.headline("Muted."), false);
  assert.equal(muted.cancelled(), 1);
  assert.equal(muted.spoken.length, 0);

  const unsupported = fixture({ synthesis: null, Utterance: null });
  assert.equal(unsupported.coach.headline("Text remains visible."), false);

  const disposed = fixture();
  disposed.coach.dispose();
  disposed.coach.setEnabled(true);
  assert.equal(disposed.coach.headline("Disposed."), false);
  assert.equal(disposed.cancelled(), 1);

  const f = fixture();
  f.coach.cue("Current cue.");
  for (const text of ["", "  ", null, undefined, 42]) {
    assert.equal(f.coach.headline(text), false);
  }
  f.at(NaN);
  assert.equal(f.coach.headline("Invalid clock."), false);
  assert.equal(f.cancelled(), 0);
  assert.equal(f.coach.active, f.spoken[0]);
});

test("headline speech failures remain contained and never enqueue after failed cancellation", () => {
  const cancellation = fixture();
  cancellation.coach.cue("Old cue.");
  cancellation.synthesis.cancel = () => {
    throw new Error("Cannot cancel");
  };
  assert.equal(cancellation.coach.headline("Cannot overlap."), false);
  assert.equal(cancellation.spoken.length, 1);

  const constructor = fixture({
    Utterance: class {
      constructor() {
        throw new Error("Unsupported voice");
      }
    },
  });
  assert.equal(constructor.coach.headline("Unavailable."), false);

  for (const synchronousError of [true, false]) {
    const f = fixture();
    f.synthesis.speak = (utterance) => {
      if (synchronousError) utterance.onerror?.();
      else throw new Error("Device unavailable");
    };
    assert.equal(f.coach.headline("Rejected."), false);
    assert.equal(f.coach.active, null);
    assert.deepEqual(f.displayed, []);
  }

  const asynchronous = fixture();
  assert.equal(asynchronous.coach.headline("First finding."), true);
  asynchronous.error();
  assert.equal(asynchronous.coach.active, null);
  assert.equal(asynchronous.coach.headline("Retry finding."), true);
});

test("speaking hook suspends recognition before audio submission, including queued audio", () => {
  for (const autoStart of [true, false]) {
    const transitions = [];
    const f = fixture({
      autoStart,
      onSpeaking(speaking) {
        transitions.push(speaking);
        if (speaking) assert.ok(f.coach.active);
      },
    });
    const speak = f.synthesis.speak.bind(f.synthesis);
    f.synthesis.speak = (utterance) => {
      assert.deepEqual(transitions, [true]);
      assert.equal(f.coach.active, utterance);
      speak(utterance);
    };
    assert.equal(f.coach.cue("Keep the movement controlled."), true);
    assert.deepEqual(transitions, [true]);
    if (!autoStart) f.start();
    assert.deepEqual(transitions, [true], "start does not suspend twice");
    f.end();
    assert.deepEqual(transitions, [true, false]);
  }
});

test("end, error, cancellation, and muting each release speaking state once", () => {
  for (const finish of [
    (f) => f.end(),
    (f) => f.error(),
    (f) => f.coach.stop(),
    (f) => f.coach.setEnabled(false),
    (f) => f.coach.dispose(),
  ]) {
    const transitions = [];
    const f = fixture({ onSpeaking: (value) => transitions.push(value) });
    f.coach.cue("A cue to finish.");
    const oldEnd = f.spoken[0].onend;
    const oldError = f.spoken[0].onerror;
    finish(f);
    assert.equal(f.coach.active, null);
    assert.deepEqual(transitions, [true, false]);
    oldEnd();
    oldError();
    f.coach.stop();
    assert.deepEqual(transitions, [true, false]);
  }
});

test("stale utterance events cannot resume recognition during a newer headline", () => {
  const transitions = [];
  const f = fixture({
    autoStart: false,
    onSpeaking: (value) => transitions.push(value),
  });
  f.coach.cue("Old cue.");
  const old = {
    start: f.spoken[0].onstart,
    end: f.spoken[0].onend,
    error: f.spoken[0].onerror,
  };
  assert.equal(f.coach.headline("Current set finding."), true);
  assert.deepEqual(transitions, [true, false, true]);
  old.start();
  old.end();
  old.error();
  assert.deepEqual(transitions, [true, false, true]);
  assert.equal(f.coach.active, f.spoken[1]);
  f.start();
  f.end();
  assert.deepEqual(transitions, [true, false, true, false]);
});

test("rejected speech releases the microphone gate and suppressed cues do not reopen it", () => {
  for (const reject of [
    (utterance) => utterance.onerror?.(),
    () => {
      throw new Error("Audio unavailable");
    },
  ]) {
    const transitions = [];
    const f = fixture({ onSpeaking: (value) => transitions.push(value) });
    f.synthesis.speak = reject;
    assert.equal(f.coach.cue("Could not play."), false);
    assert.deepEqual(transitions, [true, false]);
  }
  const transitions = [];
  const f = fixture({ onSpeaking: (value) => transitions.push(value) });
  f.coach.cue("Still playing.");
  f.at(10000);
  assert.equal(f.coach.cue("Cannot overlap."), false);
  assert.equal(f.coach.headline(""), false);
  assert.deepEqual(transitions, [true]);
  f.end();
  assert.deepEqual(transitions, [true, false]);
});
