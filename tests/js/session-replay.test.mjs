import test from "node:test";
import assert from "node:assert/strict";
import { SessionReplay } from "../../app/static/js/session-replay.js";

class Element extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.src = "";
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }
}

function fixture() {
  const root = new EventTarget();
  const elements = new Map();
  root.hidden = false;
  root.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const selected = [];
  const replay = new SessionReplay({
    root,
    intervalMs: 100,
    onSelect: (entry, index) => selected.push([entry, index]),
  });
  return {
    root,
    replay,
    selected,
    element: (name) => root.getElementById(`replay-${name}`),
  };
}

function rep(number, score = 0) {
  return {
    rep_number: number,
    started_at_ms: 6000,
    bottom_at_ms: 7250,
    completed_at_ms: 8500,
    peak_angle_deg: 100.25,
    cadence_seconds: 2.5,
    score,
    faults: score ? ["shallow_depth", "fast_cadence"] : [],
  };
}

function set(number, { image = true, frames = true, reps = true } = {}) {
  const completed = [rep(1), rep(2, 10)];
  return {
    id: `squat-${number}`,
    exercise: { id: "squat", name: "Squats" },
    setNumber: number,
    summary: { reps: reps ? completed : [] },
    keyframes:
      frames && reps
        ? [
            {
              rep: completed[1],
              image: image ? `data:image/jpeg;base64,set-${number}` : null,
            },
          ]
        : [],
  };
}

test("opens one retained worst-rep highlight per set with accurate still labels and metrics", () => {
  const f = fixture();
  const sets = [set(1), set(2)];
  f.replay.open(sets);
  assert.equal(f.replay.entries.length, 2);
  assert.equal(f.element("image").src, "data:image/jpeg;base64,set-1");
  assert.equal(f.element("image").hidden, false);
  assert.equal(f.element("empty").hidden, true);
  assert.match(f.element("caption").textContent, /Squats · Set 1 · Rep 2/);
  assert.match(f.element("caption").textContent, /Worst-rep bottom keyframe/);
  assert.match(f.element("detail").textContent, /Bottom 1.3s after rep start/);
  assert.match(f.element("detail").textContent, /Peak angle 100.3°/);
  assert.match(f.element("detail").textContent, /Cadence 2.5s/);
  assert.match(f.element("detail").textContent, /Shallow depth, Fast cadence/);
  assert.equal(f.element("position").textContent, "1 of 2 highlights");
  assert.equal(f.element("slider").max, "1");
  assert.equal(f.selected[0][1], 0);
  sets[0].keyframes[0].rep.faults.push("later_change");
  assert.deepEqual(f.replay.entries[0].rep.faults, [
    "shallow_depth",
    "fast_cadence",
  ]);
  f.replay.dispose();
});

test("buttons and slider select within bounds and never invent additional frames", () => {
  const f = fixture();
  f.replay.open([set(1), set(2), set(3)]);
  assert.equal(f.element("prev").disabled, true);
  f.replay.previous();
  assert.equal(f.replay.index, 0);
  f.element("next").dispatchEvent(new Event("click"));
  assert.equal(f.replay.index, 1);
  f.element("slider").value = "2";
  f.element("slider").dispatchEvent(new Event("input"));
  assert.equal(f.replay.index, 2);
  assert.equal(f.element("next").disabled, true);
  assert.equal(f.element("image").src, "data:image/jpeg;base64,set-3");
  f.replay.next();
  assert.equal(f.replay.index, 2);
  f.replay.select(Number.NaN);
  assert.equal(f.replay.index, 2);
  f.replay.select(-999);
  assert.equal(f.replay.index, 0);
  f.replay.dispose();
});

test("a missing JPEG clears prior image without hiding that set's recorded metrics", () => {
  const f = fixture();
  f.replay.open([set(1), set(2, { image: false })]);
  f.replay.next();
  assert.equal(f.element("image").src, "");
  assert.equal(f.element("image").hidden, true);
  assert.equal(f.element("image").alt, "");
  assert.equal(f.element("empty").hidden, false);
  assert.equal(
    f.element("empty").textContent,
    "No keyframe retained for this completed rep.",
  );
  assert.match(f.element("caption").textContent, /Set 2 · Rep 2/);
  assert.match(f.element("detail").textContent, /Cadence 2.5s/);
  f.replay.dispose();
});

test("sets without frame records show their worst measured rep, while empty sets add nothing", () => {
  const f = fixture();
  f.replay.open([
    set(1, { frames: false }),
    set(2, { frames: false, reps: false }),
  ]);
  assert.equal(f.replay.entries.length, 1);
  assert.equal(f.replay.entries[0].rep.rep_number, 2);
  assert.equal(f.element("empty").hidden, false);
  assert.equal(f.element("play").disabled, true);
  assert.equal(f.element("slider").disabled, true);
  f.replay.dispose();
});

test("external image URLs are never loaded and unknown faults render as plain text", () => {
  const f = fixture();
  const value = set(1);
  value.keyframes[0].image = "https://example.test/frame.jpg";
  value.keyframes[0].rep.faults = ["<script>alert(1)</script>"];
  delete value.keyframes[0].rep.started_at_ms;
  value.keyframes[0].rep.peak_angle_deg = Number.NaN;
  value.keyframes[0].rep.cadence_seconds = undefined;
  f.replay.open([value]);
  assert.equal(f.element("image").src, "");
  assert.equal(
    f.element("detail").textContent,
    "Form flags: <script>alert(1)</script>",
  );
  f.replay.dispose();
});

test("autoplay visits missing highlights and stops at the last still", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  f.replay.open([set(1), set(2, { image: false }), set(3)]);
  f.element("play").dispatchEvent(new Event("click"));
  assert.equal(f.replay.playing, true);
  assert.equal(f.element("play").textContent, "Pause keyframes");
  t.mock.timers.tick(100);
  assert.equal(f.replay.index, 1);
  assert.equal(f.element("image").hidden, true);
  t.mock.timers.tick(100);
  assert.equal(f.replay.index, 2);
  assert.equal(f.replay.playing, false);
  assert.equal(f.replay.timer, null);
  assert.equal(f.element("play").textContent, "Play keyframes");
  t.mock.timers.tick(1000);
  assert.equal(f.replay.index, 2);
  f.replay.play();
  assert.equal(f.replay.index, 0);
  assert.equal(f.replay.playing, true);
  f.replay.dispose();
});

test("manual selection pauses playback and hidden pages cannot restart it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  f.replay.open([set(1), set(2), set(3)]);
  f.replay.play();
  f.replay.select(1);
  assert.equal(f.replay.playing, false);
  t.mock.timers.tick(1000);
  assert.equal(f.replay.index, 1);
  f.replay.play();
  f.root.hidden = true;
  f.root.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.replay.playing, false);
  assert.equal(f.replay.timer, null);
  f.replay.play();
  assert.equal(f.replay.playing, false);
  f.root.hidden = false;
  f.root.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.replay.playing, false);
  f.replay.dispose();
});

test("clear releases JPEG references, timers and displayed metrics and can open another session", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  f.replay.open([set(1), set(2)]);
  f.replay.play();
  f.replay.clear();
  assert.deepEqual(f.replay.entries, []);
  assert.equal(f.replay.timer, null);
  assert.equal(f.element("image").src, "");
  assert.equal(f.element("detail").textContent, "");
  assert.equal(f.element("position").textContent, "0 highlights");
  assert.equal(f.element("play").disabled, true);
  t.mock.timers.tick(1000);
  assert.equal(f.replay.index, 0);
  f.replay.open([set(4)]);
  assert.equal(f.element("image").src, "data:image/jpeg;base64,set-4");
  f.replay.dispose();
});

test("dispose removes control listeners, clears retained stills, and prevents reuse", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  f.replay.open([set(1), set(2)]);
  f.replay.play();
  f.replay.dispose();
  f.element("play").dispatchEvent(new Event("click"));
  f.element("next").dispatchEvent(new Event("click"));
  f.replay.open([set(3)]);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.replay.entries, []);
  assert.equal(f.replay.onSelect, null);
  assert.equal(f.element("image").src, "");
  assert.equal(f.replay.timer, null);
});
