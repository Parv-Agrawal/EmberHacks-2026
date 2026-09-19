import test from "node:test";
import assert from "node:assert/strict";
import {
  SosSimulation,
  TEST_RECIPIENTS,
} from "../../app/static/js/sos-simulation.js";

const briefing = () => ({
  location: { value: "Demo gym, room 2", confirmed: true },
  caller: { name: "Demo user", callback: "+1 416 555 0100" },
  reason: "User requested help",
  checkIn: "Not answered",
  approvedDetails: { allergies: ["Demo allergy"] },
});

function fixture(options = {}) {
  const pending = new Map();
  const updates = [];
  let timerId = 0;
  let time = 1000;
  const simulator = new SosSimulation({
    now: () => time,
    onUpdate: (snapshot) => updates.push(snapshot),
    timers: {
      setTimeout(callback, delay) {
        const id = ++timerId;
        pending.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    ...options,
  });
  return {
    simulator,
    pending,
    updates,
    start(recipientId = TEST_RECIPIENTS[0].id) {
      return simulator.start({ recipientId, briefing: briefing() });
    },
    tick() {
      const entry = pending.entries().next().value;
      if (!entry) return;
      pending.delete(entry[0]);
      time += entry[1].delay;
      entry[1].callback();
    },
  };
}

test("the allowlist and each invalid-domain recipient are immutable", () => {
  assert.equal(TEST_RECIPIENTS.length, 2);
  assert.ok(Object.isFrozen(TEST_RECIPIENTS));
  for (const recipient of TEST_RECIPIENTS) {
    assert.ok(Object.isFrozen(recipient));
    assert.ok(recipient.address.endsWith("@example.invalid"));
  }
  assert.throws(() => {
    TEST_RECIPIENTS[0].address = "somebody@example.com";
  }, TypeError);
  assert.throws(() => TEST_RECIPIENTS.push({ id: "other" }), TypeError);
});

test("construction is idle and does not schedule work", () => {
  const f = fixture();
  assert.deepEqual(f.simulator.snapshot(), {
    status: "idle",
    id: null,
    recipient: null,
    briefing: null,
    events: [],
    revision: 0,
  });
  assert.equal(f.pending.size, 0);
  assert.equal(f.updates.length, 0);
});

test("each known recipient starts an immediate explicitly simulated connection", () => {
  for (const recipient of TEST_RECIPIENTS) {
    const f = fixture();
    const state = f.start(recipient.id);
    assert.equal(state.status, "connecting");
    assert.ok(state.id.startsWith("spotter-simulation-"));
    assert.deepEqual(state.recipient, recipient);
    assert.equal(state.revision, 1);
    assert.equal(state.events.length, 1);
    assert.match(state.events[0].message, /SIMULATION.*No call or message/);
    assert.equal(f.updates[0].status, "connecting");
    assert.equal(f.pending.size, 1);
  }
});

test("unknown identifiers and recipient objects fail before any state or timer changes", () => {
  for (const recipientId of [
    undefined,
    null,
    "someone@example.com",
    "spotter-test-desk ",
    "SPOTTER-TEST-DESK",
    "__proto__",
    { id: TEST_RECIPIENTS[0].id },
    new String(TEST_RECIPIENTS[0].id),
  ]) {
    const f = fixture();
    const before = f.simulator.snapshot();
    assert.throws(
      () => f.simulator.start({ recipientId, briefing: briefing() }),
      /Choose an allowlisted simulation recipient/,
    );
    assert.deepEqual(f.simulator.snapshot(), before);
    assert.equal(f.pending.size, 0);
    assert.equal(f.updates.length, 0);
  }
});

test("start does not accept arbitrary addresses, recipient overrides, or transport settings", () => {
  for (const extra of [
    { address: "somebody@example.com" },
    { recipient: { ...TEST_RECIPIENTS[0], address: "somebody@example.com" } },
    { transport: "sms" },
  ]) {
    const f = fixture();
    assert.throws(
      () =>
        f.simulator.start({
          recipientId: TEST_RECIPIENTS[0].id,
          briefing: briefing(),
          ...extra,
        }),
      TypeError,
    );
    assert.equal(f.simulator.snapshot().status, "idle");
    assert.equal(f.pending.size, 0);
  }
  for (const options of [null, undefined, "spotter-test-desk", []])
    assert.throws(() => fixture().simulator.start(options), TypeError);
});

test("the finite timeline reaches handoff then acknowledgement with no remaining timers", () => {
  const f = fixture();
  f.start();
  f.tick();
  assert.equal(f.simulator.snapshot().status, "handoff");
  assert.equal(f.pending.size, 1);
  f.tick();
  const state = f.simulator.snapshot();
  assert.equal(state.status, "acknowledged");
  assert.equal(f.pending.size, 0);
  assert.deepEqual(
    state.events.map((event) => event.status),
    ["connecting", "handoff", "acknowledged"],
  );
  assert.deepEqual(
    state.events.map((event) => event.at),
    [1000, 2200, 3700],
  );
  assert.ok(
    state.events.every((event) => event.message.startsWith("SIMULATION:")),
  );
  assert.match(state.events.at(-1).message, /Real help has not been contacted/);
});

test("duplicate starts preserve the incident, briefing, recipient, and active timer", () => {
  const f = fixture();
  f.start();
  for (const status of ["connecting", "handoff", "acknowledged"]) {
    const before = f.simulator.snapshot();
    assert.equal(before.status, status);
    const pending = [...f.pending];
    const updateCount = f.updates.length;
    const duplicate = f.simulator.start({
      recipientId: TEST_RECIPIENTS[1].id,
      briefing: "Different content must not silently replace the briefing.",
    });
    assert.deepEqual(duplicate, before);
    assert.deepEqual([...f.pending], pending);
    assert.equal(f.updates.length, updateCount);
    f.tick();
  }
});

test("invalid recipient validation still runs during an existing incident", () => {
  const f = fixture();
  f.start();
  const before = f.simulator.snapshot();
  assert.throws(() => f.start("not-allowed"), TypeError);
  assert.deepEqual(f.simulator.snapshot(), before);
  assert.equal(f.pending.size, 1);
});

test("briefing revisions before and after acknowledgement are explicit and local", () => {
  const f = fixture();
  f.start();
  let state = f.simulator.updateBriefing({
    ...briefing(),
    checkIn: "Responsive",
  });
  assert.equal(state.status, "connecting");
  assert.equal(state.revision, 2);
  assert.equal(state.briefing.checkIn, "Responsive");
  assert.match(
    state.events.at(-1).message,
    /local briefing revised.*revision 2/,
  );
  assert.equal(f.pending.size, 1);
  f.tick();
  f.tick();
  state = f.simulator.updateBriefing("New confirmed local briefing");
  assert.equal(state.status, "acknowledged");
  assert.equal(state.revision, 3);
  assert.equal(state.briefing, "New confirmed local briefing");
  assert.match(state.events.at(-1).message, /Nothing was transmitted/);
  assert.equal(f.pending.size, 0);
});

test("cancellation clears work and stale callbacks cannot resurrect an incident", () => {
  for (const stage of ["connecting", "handoff", "acknowledged"]) {
    const f = fixture();
    f.start();
    if (stage !== "connecting") f.tick();
    if (stage === "acknowledged") f.tick();
    const stale = [...f.pending.values()].map((entry) => entry.callback);
    const result = f.simulator.cancel();
    assert.equal(result.status, "cancelled");
    assert.equal(f.pending.size, 0);
    assert.match(
      result.events.at(-1).message,
      /SIMULATION.*No real call or message/,
    );
    for (const callback of stale) callback();
    assert.deepEqual(f.simulator.snapshot(), result);
    assert.deepEqual(f.simulator.cancel(), result);
    assert.deepEqual(f.simulator.updateBriefing("Later"), result);
  }
});

test("a new incident after cancellation cannot be advanced by an old callback", () => {
  const f = fixture();
  const first = f.start();
  const stale = [...f.pending.values()][0].callback;
  f.simulator.cancel();
  const second = f.start(TEST_RECIPIENTS[1].id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.events.length, 1);
  stale();
  assert.deepEqual(f.simulator.snapshot(), second);
  assert.equal(f.pending.size, 1);
  f.tick();
  assert.equal(f.simulator.snapshot().status, "handoff");
});

test("reset releases the incident and all pending work", () => {
  const f = fixture();
  const idle = f.simulator.snapshot();
  f.start();
  const stale = [...f.pending.values()][0].callback;
  assert.deepEqual(f.simulator.reset(), idle);
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.updates.at(-1), idle);
  stale();
  assert.deepEqual(f.simulator.snapshot(), idle);
  assert.deepEqual(f.simulator.updateBriefing("No incident"), idle);
  assert.equal(f.start().status, "connecting");
});

test("disposal is permanent, releases private incident data, and tolerates repeated cleanup", () => {
  const f = fixture();
  f.start();
  const stale = [...f.pending.values()][0].callback;
  f.simulator.dispose();
  f.simulator.dispose();
  stale();
  assert.equal(f.pending.size, 0);
  assert.equal(f.simulator.snapshot().status, "idle");
  assert.equal(f.simulator.snapshot().briefing, null);
  assert.throws(() => f.start(), /unavailable/);
  assert.equal(f.simulator.updateBriefing(briefing()).status, "idle");
});

test("input, returned snapshots, and update callbacks never share incident references", () => {
  const f = fixture();
  const input = briefing();
  const returned = f.simulator.start({
    recipientId: TEST_RECIPIENTS[0].id,
    briefing: input,
  });
  input.location.value = "Changed input";
  returned.briefing.approvedDetails.allergies.push("Changed return");
  returned.recipient.address = "Changed return";
  f.updates[0].briefing.caller.name = "Changed callback";
  f.updates[0].events[0].message = "Changed callback";
  const state = f.simulator.snapshot();
  assert.deepEqual(state.briefing, briefing());
  assert.deepEqual(state.recipient, TEST_RECIPIENTS[0]);
  assert.match(state.events[0].message, /^SIMULATION/);
  const update = briefing();
  f.simulator.updateBriefing(update);
  update.location.value = "Changed update input";
  assert.equal(
    f.simulator.snapshot().briefing.location.value,
    "Demo gym, room 2",
  );
});

test("briefing copy errors are safe and leave the existing incident intact", () => {
  const f = fixture();
  const privateValue = "Sensitive content never belongs in an error";
  for (const invalid of [
    undefined,
    null,
    42,
    "",
    "   ",
    { privateValue, fn() {} },
  ]) {
    assert.throws(
      () =>
        f.simulator.start({
          recipientId: TEST_RECIPIENTS[0].id,
          briefing: invalid,
        }),
      (error) =>
        error instanceof TypeError && !error.message.includes(privateValue),
    );
    assert.equal(f.simulator.snapshot().status, "idle");
    assert.equal(f.pending.size, 0);
  }
  f.start();
  const before = f.simulator.snapshot();
  assert.throws(() => f.simulator.updateBriefing({ fn() {} }), TypeError);
  assert.deepEqual(f.simulator.snapshot(), before);
});

test("a failing update callback cannot strand the simulator between transitions", () => {
  const f = fixture({
    onUpdate() {
      throw new Error("A rendering error");
    },
  });
  assert.doesNotThrow(() => f.start());
  assert.doesNotThrow(() => f.tick());
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.simulator.snapshot().status, "acknowledged");
  assert.equal(f.pending.size, 0);
  assert.doesNotThrow(() => f.simulator.reset());
});

test("synchronous cancellation during a transition does not schedule later work", () => {
  for (const stage of ["connecting", "handoff"]) {
    const f = fixture();
    f.simulator.onUpdate = (snapshot) => {
      if (snapshot.status === stage) f.simulator.cancel();
    };
    f.start();
    if (stage === "handoff") f.tick();
    assert.equal(f.simulator.snapshot().status, "cancelled");
    assert.equal(f.pending.size, 0);
  }
});

test("default timers preserve the browser-global receiver required by native APIs", (t) => {
  const pending = new Map();
  let sequence = 0;
  t.mock.method(globalThis, "setTimeout", function (callback, delay) {
    assert.equal(
      this,
      globalThis,
      "native timers require their global receiver",
    );
    const id = ++sequence;
    pending.set(id, { callback, delay });
    return id;
  });
  const cleared = t.mock.method(globalThis, "clearTimeout", function (id) {
    assert.equal(
      this,
      globalThis,
      "native timer cleanup requires its global receiver",
    );
    pending.delete(id);
  });
  const simulator = new SosSimulation();
  const state = simulator.start({
    recipientId: TEST_RECIPIENTS[0].id,
    briefing: briefing(),
  });
  assert.equal(state.status, "connecting");
  assert.equal(pending.size, 1);
  const first = pending.entries().next().value;
  pending.delete(first[0]);
  first[1].callback();
  assert.equal(simulator.snapshot().status, "handoff");
  assert.equal(pending.size, 1);
  simulator.cancel();
  assert.equal(simulator.snapshot().status, "cancelled");
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(pending.size, 0);
});

test("timer scheduling failures safely terminate both connecting and handoff without late transitions", () => {
  for (const failOn of [1, 2]) {
    const callbacks = [];
    let calls = 0;
    const f = fixture({
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          calls += 1;
          if (calls === failOn)
            throw new Error("Potentially sensitive host error must not escape");
          return calls;
        },
        clearTimeout() {},
      },
    });
    assert.doesNotThrow(() => f.start());
    if (failOn === 2) assert.doesNotThrow(() => callbacks[0]());
    const stopped = f.simulator.snapshot();
    assert.equal(stopped.status, "cancelled");
    assert.match(
      stopped.events.at(-1).message,
      /^SIMULATION:.*timer was unavailable/,
    );
    assert.match(
      stopped.events.at(-1).message,
      /No real call or message was sent/,
    );
    assert.doesNotMatch(JSON.stringify(stopped.events), /sensitive host error/);
    for (const callback of callbacks) assert.doesNotThrow(() => callback());
    assert.deepEqual(f.simulator.snapshot(), stopped);
    assert.equal(f.updates.at(-1).status, "cancelled");
  }
});

test("a timer cleanup failure cannot prevent cancellation or reset of private incident data", () => {
  for (const action of ["cancel", "reset", "dispose"]) {
    let stale;
    const f = fixture({
      timers: {
        setTimeout(callback) {
          stale = callback;
          return 1;
        },
        clearTimeout() {
          throw new Error("Host timer cleanup unavailable");
        },
      },
    });
    f.start();
    assert.doesNotThrow(() => f.simulator[action]());
    const stopped = f.simulator.snapshot();
    assert.equal(stopped.status, action === "cancel" ? "cancelled" : "idle");
    if (action !== "cancel") assert.equal(stopped.briefing, null);
    stale();
    assert.deepEqual(f.simulator.snapshot(), stopped);
  }
});
