import test from "node:test";
import assert from "node:assert/strict";
import {
  CoachReview,
  validCoachFeedback,
} from "../../app/static/js/coach-review.js";

const feedback = () => ({
  headline:
    "Eight reps stayed controlled; you reported feeling ready for more.",
  tips: [
    "Keep your knees tracking over your toes.",
    "Maintain the same controlled pace next set.",
  ],
  encouragement: "Good work completing your set.",
});

const context = () => ({
  summary: {
    exercise: "squat",
    completed_reps: 8,
    target_reps: 8,
    reps: Array.from({ length: 8 }, (_, index) => ({
      rep_number: index + 1,
      peak_angle_deg: 90,
      cadence_seconds: 3,
      bottom_at_ms: index * 3000 + 1500,
      score: 0,
      faults: [],
    })),
    detected_faults: [],
  },
  image: "data:image/jpeg;base64,a2V5ZnJhbWU=",
  exercise: { id: "squat", name: "Squats", reps: 8, rest_seconds: 60 },
  hasNextSet: true,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(
  t,
  {
    requestCoach = async () => ({ source: "gemini", feedback: feedback() }),
    set = context(),
  } = {},
) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) {
      const node = new EventTarget();
      Object.assign(node, {
        value: "",
        textContent: "",
        hidden: false,
        disabled: false,
        attributes: new Map(),
        setAttribute(key, value) {
          this.attributes.set(key, value);
        },
      });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const document = { hidden: false, getElementById: get };
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  const calls = [];
  const decisions = [];
  let pains = 0;
  const voice = {
    headlines: [],
    stops: 0,
    stop() {
      this.stops += 1;
    },
    headline(text) {
      this.headlines.push(text);
    },
  };
  const review = new CoachReview({
    requestCoach:
      requestCoach === null
        ? null
        : (body, signal) => {
            calls.push({ body, signal });
            return requestCoach(body, signal);
          },
    voice,
    onDecision: (proposal) => decisions.push(proposal),
    onPain: () => {
      pains += 1;
      review.markPain();
    },
  });
  t.after(() => {
    review.reset();
    if (savedDocument)
      Object.defineProperty(globalThis, "document", savedDocument);
    else delete globalThis.document;
  });
  review.open(set);
  return {
    review,
    calls,
    decisions,
    voice,
    get,
    document,
    set,
    pains: () => pains,
    input(value) {
      get("coach-feedback").value = value;
      get("coach-feedback").dispatchEvent(new Event("input"));
    },
    commit() {
      get("coach-feedback").dispatchEvent(new Event("change"));
    },
    click(id) {
      get(id).dispatchEvent(new Event("click"));
    },
  };
}

test("review fuses measured telemetry, feedback, and the worst-rep image only after explicit submission", async (t) => {
  const f = fixture(t);
  const original = structuredClone(f.set);
  f.set.summary.reps[0].peak_angle_deg = 999;
  f.set.image = "changed externally";
  f.input("  Felt easy  ");
  assert.equal(f.calls.length, 0);
  assert.equal(f.get("coach-panel").hidden, false);
  assert.equal(f.get("coach-submit").disabled, false);
  await f.review.submit();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    set_summary: original.summary,
    user_feedback: "Felt easy",
    keyframe_image: original.image,
  });
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.get("coach-headline").textContent, feedback().headline);
  assert.equal(f.get("coach-tip-one").textContent, feedback().tips[0]);
  assert.equal(f.get("coach-tip-two").textContent, feedback().tips[1]);
  assert.equal(
    f.get("coach-encouragement").textContent,
    feedback().encouragement,
  );
  assert.equal(f.get("coach-source").textContent, "YOUR SET REVIEW");
  assert.equal(f.get("coach-result").hidden, false);
  assert.deepEqual(f.voice.headlines, [feedback().headline]);
  assert.equal(f.review.pending, false);
  assert.equal(f.get("coach-submit").attributes.get("aria-busy"), "false");
});

test("pending requests cannot duplicate and show an explicit cancel control", async (t) => {
  const response = deferred();
  const f = fixture(t, { requestCoach: () => response.promise });
  f.input("Felt easy");
  const submission = f.review.submit();
  assert.equal(f.review.pending, true);
  assert.equal(f.get("coach-submit").disabled, true);
  assert.equal(f.get("coach-submit").attributes.get("aria-busy"), "true");
  assert.equal(f.get("coach-cancel").hidden, false);
  await f.review.submit();
  assert.equal(f.calls.length, 1);
  response.resolve({ source: "gemini", feedback: feedback() });
  await submission;
  assert.equal(f.get("coach-cancel").hidden, true);
});

for (const action of ["edit", "reset", "pain", "new set", "cancel"]) {
  test(`late responses are ignored after ${action}, even when the transport ignores abort`, async (t) => {
    const response = deferred();
    const f = fixture(t, { requestCoach: () => response.promise });
    f.input("Felt easy");
    const submission = f.review.submit();
    const signal = f.calls[0].signal;
    if (action === "edit") f.input("I felt fatigued");
    else if (action === "reset") f.review.reset();
    else if (action === "pain") f.review.markPain();
    else if (action === "new set")
      f.review.open({
        ...context(),
        exercise: { ...context().exercise, reps: 10 },
      });
    else f.click("coach-cancel");
    const status = f.get("coach-status").textContent;
    assert.equal(signal.aborted, true);
    response.resolve({ source: "gemini", feedback: feedback() });
    await submission;
    assert.equal(f.get("coach-result").hidden, true);
    assert.equal(f.get("coach-status").textContent, status);
    assert.deepEqual(f.voice.headlines, []);
    assert.equal(f.review.pending, false);
  });
}

test("an older failed request cannot clear a newer pending request or replace its result", async (t) => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const f = fixture(t, {
    requestCoach: () => (++count === 1 ? first : second).promise,
  });
  f.input("Felt easy");
  const initial = f.review.submit();
  f.input("I felt fatigued");
  const current = f.review.submit();
  first.reject(new Error("Late failure"));
  await initial;
  assert.equal(f.review.pending, true);
  assert.equal(f.get("coach-result").hidden, true);
  assert.equal(f.calls[1].signal.aborted, false);
  const fatigueFeedback = {
    ...feedback(),
    headline: "Eight reps recorded; you reported fatigue.",
  };
  second.resolve({ source: "gemini", feedback: fatigueFeedback });
  await current;
  assert.equal(f.review.pending, false);
  assert.deepEqual(f.voice.headlines, [fatigueFeedback.headline]);
});

test("pain feedback stops immediately without calling the coach endpoint", async (t) => {
  const f = fixture(t);
  f.click("feedback-pain");
  assert.equal(f.pains(), 1);
  assert.equal(f.review.stopped, true);
  assert.equal(f.get("coach-feedback").disabled, false);
  assert.equal(f.get("coach-submit").disabled, true);
  assert.equal(f.get("adapt-panel").hidden, true);
  assert.match(f.get("coach-status").textContent, /Exercise stopped/);
  await f.review.submit();
  f.review.decide(true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.voice.headlines, []);
  assert.equal(
    f.decisions.every((decision) => decision === null),
    true,
  );
});

test("submit rechecks pain even if the input event was missed", async (t) => {
  const f = fixture(t);
  f.get("coach-feedback").value = "My knee hurts";
  await f.review.submit();
  assert.equal(f.pains(), 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.review.stopped, true);
});

test("typing pain-free does not abort on its incomplete prefix, while committing pain stops immediately", (t) => {
  const f = fixture(t);
  f.input("Felt easy");
  f.review.decide(true);
  f.input("pain");
  assert.equal(f.pains(), 0);
  assert.equal(f.review.stopped, false);
  assert.equal(f.review.proposal, null);
  assert.equal(f.get("adapt-panel").hidden, true);
  assert.equal(f.decisions.at(-1), null);
  f.input("pain-free");
  f.commit();
  assert.equal(f.pains(), 0);
  assert.equal(f.review.stopped, false);
  f.input("My knee hurts");
  assert.equal(f.pains(), 0);
  f.commit();
  assert.equal(f.pains(), 1);
  assert.equal(f.review.stopped, true);
  assert.equal(f.calls.length, 0);
});

test("accepting an existing proposal rechecks pain before applying any change", (t) => {
  const f = fixture(t);
  f.input("Felt easy");
  f.get("coach-feedback").value = "I felt pain";
  f.review.decide(true);
  assert.equal(f.pains(), 1);
  assert.equal(f.review.stopped, true);
  assert.equal(
    f.decisions.every((decision) => decision === null),
    true,
  );
  assert.equal(f.calls.length, 0);
});

test("a server safety response invokes the immediate stop path and is never spoken", async (t) => {
  const f = fixture(t, { requestCoach: async () => ({ source: "safety" }) });
  f.input("I want to check this set");
  await f.review.submit();
  assert.equal(f.pains(), 1);
  assert.equal(f.review.stopped, true);
  assert.equal(f.get("coach-result").hidden, true);
  assert.equal(f.review.pending, false);
  assert.deepEqual(f.voice.headlines, []);
});

test("accepted changes require an explicit decision and never mutate the current exercise", async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.review.context);
  f.click("feedback-easy");
  assert.equal(f.review.proposal.kind, "increase");
  assert.equal(f.get("adapt-panel").hidden, false);
  assert.deepEqual(f.decisions, [null]);
  await f.review.submit();
  assert.deepEqual(f.decisions, [null]);
  assert.deepEqual(f.review.context, before);
  f.click("adapt-accept");
  const accepted = f.decisions.at(-1);
  assert.equal(accepted.reps, 9);
  assert.equal(accepted.rest_seconds, 60);
  assert.notEqual(accepted, f.review.proposal);
  assert.equal(f.get("adapt-accept").disabled, true);
  assert.deepEqual(f.review.context, before);
  accepted.reps = 99;
  assert.equal(f.review.proposal.reps, 9);
  f.click("adapt-keep");
  assert.equal(f.decisions.at(-1), null);
  assert.equal(f.get("adapt-keep").disabled, true);
  f.input("I felt fatigued");
  assert.equal(f.decisions.at(-1), null);
  assert.equal(f.review.proposal.kind, "rest");
  assert.equal(f.get("adapt-accept").disabled, false);
});

test("a final set offers coaching without an unneeded next-set decision", async (t) => {
  const f = fixture(t, { set: { ...context(), hasNextSet: false } });
  f.input("Felt easy");
  await f.review.submit();
  assert.equal(f.get("adapt-panel").hidden, true);
  const decisionCount = f.decisions.length;
  f.review.decide(true);
  assert.equal(f.decisions.length, decisionCount);
  assert.equal(f.get("coach-result").hidden, false);
});

test("missing images or request capability yield a neutral review without upload", async (t) => {
  const f = fixture(t, { set: { ...context(), image: null } });
  assert.match(f.get("coach-status").textContent, /No completed-rep image/);
  f.input("I felt fatigued");
  assert.equal(f.get("coach-submit").textContent, "Review locally");
  await f.review.submit();
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.get("coach-source").textContent,
    "YOUR SET REVIEW",
  );
  assert.equal(f.get("coach-status").textContent, "");
  assert.match(f.get("coach-headline").textContent, /8 completed reps/);
  assert.match(f.get("coach-headline").textContent, /reported fatigue/);
  assert.equal(f.voice.headlines.length, 1);
  f.review.reset();
  f.review.requestCoach = null;
  f.review.open(context());
  f.input("Felt easy");
  await f.review.submit();
  assert.equal(f.calls.length, 0);
  assert.match(f.get("coach-source").textContent, /YOUR SET REVIEW/);
});

test("valid server fallback uses a neutral heading without provider status", async (t) => {
  const f = fixture(t, {
    requestCoach: async () => ({
      source: "fallback",
      reason: "missing_api_key",
      feedback: feedback(),
    }),
  });
  f.input("Felt easy");
  await f.review.submit();
  assert.equal(
    f.get("coach-source").textContent,
    "YOUR SET REVIEW",
  );
  assert.equal(f.get("coach-status").textContent, "");
  assert.deepEqual(f.voice.headlines, [feedback().headline]);
});

for (const malformed of [
  null,
  {},
  { source: "gemini", feedback: { headline: "Missing fields" } },
  { source: "invented", feedback: feedback() },
]) {
  test(`malformed provider output falls back without claiming a Gemini result: ${JSON.stringify(malformed)}`, async (t) => {
    const f = fixture(t, { requestCoach: async () => malformed });
    f.input("I felt off-balance");
    await f.review.submit();
    assert.match(f.get("coach-source").textContent, /YOUR SET REVIEW/);
    assert.match(f.get("coach-headline").textContent, /8 completed reps/);
    assert.match(f.get("coach-headline").textContent, /gentler/);
    assert.equal(f.review.pending, false);
    assert.equal(f.voice.headlines.length, 1);
  });
}

test("network failures produce local coaching and preserve a usable proposal", async (t) => {
  const f = fixture(t, {
    requestCoach: async () => {
      throw new Error("Network down");
    },
  });
  f.input("I felt fatigued");
  await f.review.submit();
  assert.match(f.get("coach-source").textContent, /YOUR SET REVIEW/);
  assert.equal(f.review.proposal.rest_seconds, 90);
  assert.equal(f.get("coach-submit").disabled, false);
  f.review.decide(true);
  assert.equal(f.decisions.at(-1).rest_seconds, 90);
});

test("blank feedback cannot submit and a hidden tab displays results without speaking", async (t) => {
  const f = fixture(t);
  f.input("  ");
  assert.equal(f.get("coach-submit").disabled, true);
  assert.equal(f.get("adapt-panel").hidden, true);
  await f.review.submit();
  assert.equal(f.calls.length, 0);
  f.input("Felt easy");
  f.document.hidden = true;
  await f.review.submit();
  assert.equal(f.get("coach-result").hidden, false);
  assert.deepEqual(f.voice.headlines, []);
});

test("structured feedback validation enforces exactly two tips and concise strings", () => {
  assert.equal(validCoachFeedback(feedback()), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...feedback(), headline: " " },
    { ...feedback(), headline: "word ".repeat(25) },
    { ...feedback(), tips: ["One only"] },
    { ...feedback(), tips: ["One", "Two", "Three"] },
    { ...feedback(), tips: ["One", "  "] },
    { ...feedback(), tips: ["One", 2] },
    { ...feedback(), encouragement: "word ".repeat(15) },
    { ...feedback(), tips: ["word ".repeat(40), "word ".repeat(20)] },
    { ...feedback(), extra: "Unexpected" },
  ])
    assert.equal(validCoachFeedback(invalid), false);
});

test("review sends all captured keyframes even if the worst-rep image is missing", async (t) => {
  const set = context();
  set.image = null;
  set.keyframes = [
    { rep_number: 1, image: "data:image/jpeg;base64,Zmlyc3Q=" },
    { rep_number: 2, image: "data:image/jpeg;base64,c2Vjb25k" },
  ];
  const expected = structuredClone(set.keyframes);
  const f = fixture(t, { set });
  set.keyframes[0].image = "external change";
  f.input("Felt easy");
  assert.equal(f.get("coach-submit").textContent, "Review set with Gemini");
  assert.equal(f.calls.length, 0);
  await f.review.submit();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.keyframes, expected);
  assert.equal(Object.hasOwn(f.calls[0].body, "keyframe_image"), false);
});

test("an accidental pain choice can be corrected for review without proposing another set", async (t) => {
  const f = fixture(t);
  f.click("feedback-pain");
  assert.equal(f.get("feedback-fatigue").disabled, false);
  assert.match(f.get("coach-status").textContent, /selected by mistake/);
  f.click("feedback-fatigue");
  assert.equal(f.get("coach-submit").disabled, false);
  assert.equal(f.get("adapt-panel").hidden, true);
  await f.review.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.user_feedback, "I felt fatigued");
  f.review.decide(true);
  assert.ok(f.decisions.every((decision) => decision === null));
  f.click("feedback-pain");
  assert.equal(f.get("coach-submit").disabled, true);
  await f.review.submit();
  assert.equal(f.calls.length, 1);
});
