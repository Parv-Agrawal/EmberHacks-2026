import test from "node:test";
import assert from "node:assert/strict";
import { EmergencyAssistant } from "../../app/static/js/emergency-assistant.js";
import { TEST_RECIPIENTS } from "../../app/static/js/sos-simulation.js";

const NOW = Date.UTC(2026, 8, 19, 15, 30);
const TIMESTAMP = "2026-09-19T15:30:00.000Z";

function fakeDocument() {
  const elements = new Map();
  const root = { activeElement: null };
  function node(tagName = "div") {
    const element = new EventTarget();
    Object.assign(element, {
      tagName: tagName.toUpperCase(),
      value: "",
      checked: false,
      textContent: "",
      disabled: false,
      hidden: false,
      open: false,
      children: [],
      attributes: new Map(),
      setAttribute(key, value) {
        this.attributes.set(key, String(value));
      },
      getAttribute(key) {
        return this.attributes.get(key) ?? null;
      },
      removeAttribute(key) {
        this.attributes.delete(key);
      },
      append(...children) {
        this.children.push(...children);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.children = [...children];
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      focus() {
        root.activeElement = this;
      },
    });
    Object.defineProperty(element, "innerHTML", {
      set() {
        throw new Error("Emergency details must be rendered as text.");
      },
    });
    return element;
  }
  root.createElement = node;
  root.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  return root;
}

function fixture(t, { stopContext = {} } = {}) {
  const root = fakeDocument();
  const pending = new Map();
  const order = [];
  let nextTimer = 0;
  let time = NOW;
  let stops = 0;
  let pauses = 0;
  const assistant = new EmergencyAssistant({
    root,
    now: () => time,
    onStop() {
      stops += 1;
      order.push("stop");
      return stopContext;
    },
    onPause() {
      pauses += 1;
    },
    simulationOptions: {
      timers: {
        setTimeout(callback, delay) {
          order.push("timer");
          const id = ++nextTimer;
          pending.set(id, { callback, delay });
          return id;
        },
        clearTimeout(id) {
          pending.delete(id);
        },
      },
    },
  });
  t.after(() => assistant.clear());
  const get = (id) => root.getElementById(id);
  const fire = (id, type = "click") => {
    const event = new Event(type, { cancelable: true });
    get(id).dispatchEvent(event);
    return event;
  };
  return {
    assistant,
    get,
    root,
    fire,
    pending,
    order,
    stops: () => stops,
    pauses: () => pauses,
    setTime(value) {
      time = value;
    },
    tick() {
      const entry = pending.entries().next().value;
      if (!entry) return;
      pending.delete(entry[0]);
      time += entry[1].delay;
      entry[1].callback();
    },
    fill(overrides = {}) {
      const values = {
        name: "Terry Lee",
        callback: "+1 (416) 555-0100",
        language: "English",
        location: "Demo gym, north entrance",
        "location-confirmed": true,
        ...overrides,
      };
      for (const [suffix, value] of Object.entries(values)) {
        const field = get(`ep-${suffix}`);
        if (typeof value === "boolean") field.checked = value;
        else field.value = value;
      }
    },
    save(overrides = {}) {
      assistant.openProfile();
      this.fill(overrides);
      return assistant.saveProfile();
    },
    renderedBriefing() {
      const children = get("sos-briefing").children;
      return Object.fromEntries(
        children.flatMap((child, index) =>
          index % 2 === 0
            ? [[child.textContent, children[index + 1].textContent]]
            : [],
        ),
      );
    },
  };
}

test("profile setup is idle, offers only allowlisted test recipients, and pauses exercise", (t) => {
  const f = fixture(t);
  assert.equal(f.pending.size, 0);
  assert.equal(f.assistant.profile, null);
  assert.deepEqual(
    f.get("ep-recipient").children.map((option) => option.value),
    TEST_RECIPIENTS.map((recipient) => recipient.id),
  );
  assert.ok(
    f
      .get("ep-recipient")
      .children.every((option) =>
        option.textContent.includes("@example.invalid"),
      ),
  );
  f.assistant.setUser({ utorid: "leeterry", name: "Terry Lee" });
  f.fire("emergency-profile-open");
  assert.equal(f.pauses(), 1);
  assert.equal(f.get("emergency-profile-dialog").open, true);
  assert.equal(f.get("ep-name").value, "Terry Lee");
  assert.equal(f.get("ep-location-confirmed").checked, false);
  assert.equal(f.root.activeElement, f.get("ep-name"));
});

test("invalid profile save stays open with field errors and saves no partial data", (t) => {
  const f = fixture(t);
  f.assistant.openProfile();
  const event = f.fire("emergency-profile-form", "submit");
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.assistant.profile, null);
  assert.equal(f.get("emergency-profile-dialog").open, true);
  assert.equal(f.get("ep-name").getAttribute("aria-invalid"), "true");
  assert.match(f.get("ep-errors").textContent, /Name is required/);
  assert.equal(f.root.activeElement, f.get("ep-errors"));
  assert.equal(f.pending.size, 0);
});

test("profile save rejects recipient tampering and preserves an earlier valid profile", (t) => {
  const f = fixture(t);
  assert.equal(f.save(), true);
  const prior = structuredClone(f.assistant.profile);
  f.assistant.openProfile();
  f.fill({ name: "Unsaved changed name" });
  f.get("ep-recipient").value = "outside@example.com";
  assert.equal(f.assistant.saveProfile(), false);
  assert.deepEqual(f.assistant.profile, prior);
  assert.equal(f.assistant.recipientId, TEST_RECIPIENTS[0].id);
  assert.match(f.get("ep-errors").textContent, /allowlisted demo recipient/);
  assert.equal(f.pending.size, 0);
});

test("saved profile is trimmed, closes and clears form, and uses the chosen allowlisted recipient", (t) => {
  const f = fixture(t);
  assert.equal(
    f.save({ name: " Terry Lee ", recipient: TEST_RECIPIENTS[1].id }),
    true,
  );
  assert.equal(f.assistant.profile.name, "Terry Lee");
  assert.equal(f.assistant.profile.locationConfirmedAt, TIMESTAMP);
  assert.equal(f.get("emergency-profile-dialog").open, false);
  assert.equal(f.get("ep-name").value, "");
  assert.equal(f.get("ep-callback").value, "");
  assert.match(
    f.get("ep-profile-status").textContent,
    /saved in this page only/,
  );
  f.assistant.trigger();
  assert.equal(
    f.assistant.simulation.snapshot().recipient.id,
    TEST_RECIPIENTS[1].id,
  );
});

test("SOS without a profile stops synchronously before simulated timers and displays unknown details", (t) => {
  const f = fixture(t, {
    stopContext: { reason: "Help requested during Squats" },
  });
  f.fire("spotter-sos");
  assert.deepEqual(f.order, ["stop", "timer"]);
  assert.equal(f.stops(), 1);
  const state = f.assistant.simulation.snapshot();
  assert.equal(state.status, "connecting");
  assert.equal(state.briefing.mode, "SIMULATION / DEMO MODE");
  assert.equal(state.briefing.caller.name, "Unknown");
  assert.equal(state.briefing.location.text, "Unknown");
  assert.equal(state.briefing.alert.reason, "Help requested during Squats");
  assert.equal(state.briefing.alert.checkIn, "Not answered");
  assert.equal(f.get("sos-dialog").open, true);
  assert.equal(f.root.activeElement, f.get("sos-title"));
  assert.equal(f.renderedBriefing()["Physical location"], "Unknown");
});

test("draft medical details and unsaved identity are never used by an SOS trigger", (t) => {
  const f = fixture(t);
  f.assistant.openProfile();
  f.fill({
    name: "PRIVATE DRAFT NAME",
    conditions: "PRIVATE DRAFT CONDITION",
    medications: "PRIVATE DRAFT MEDICATION",
    "medications-confirmed": true,
    "share-medical": true,
  });
  f.fire("ep-sos");
  assert.doesNotMatch(
    JSON.stringify(f.assistant.simulation.snapshot()),
    /PRIVATE DRAFT/,
  );
  assert.equal(f.get("emergency-profile-dialog").open, false);
  assert.equal(f.get("ep-name").value, "");
  assert.equal(f.get("ep-conditions").value, "");
  assert.equal(f.get("ep-medications").value, "");
  assert.equal(f.get("ep-share-medical").checked, false);
});

test("closing or escaping profile clears unsaved drafts without changing saved profile", (t) => {
  const f = fixture(t);
  f.save();
  for (const [id, eventType] of [
    ["ep-close", "click"],
    ["emergency-profile-dialog", "cancel"],
  ]) {
    f.assistant.openProfile();
    f.fill({ name: "UNSAVED", allergies: "PRIVATE UNSAVED" });
    const event = f.fire(id, eventType);
    if (eventType === "cancel") assert.equal(event.defaultPrevented, true);
    assert.equal(f.get("emergency-profile-dialog").open, false);
    assert.equal(f.get("ep-name").value, "");
    assert.equal(f.get("ep-allergies").value, "");
    assert.equal(f.assistant.profile.name, "Terry Lee");
    assert.equal(f.assistant.profile.allergies, "");
  }
});

test("medical text remains withheld unless saved with explicit sharing and medication confirmation", (t) => {
  const f = fixture(t);
  f.save({
    conditions: "PRIVATE CONDITION",
    medications: "PRIVATE MEDICATION 5 mg",
    allergies: "PRIVATE ALLERGY",
    "medications-confirmed": true,
  });
  f.assistant.trigger();
  let state = f.assistant.simulation.snapshot();
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
  assert.equal(
    f.renderedBriefing()["Confirmed medications / doses"],
    "Withheld",
  );
  f.assistant.closeIncident();
  f.assistant.openProfile();
  f.get("ep-share-medical").checked = true;
  f.get("ep-medications-confirmed").checked = false;
  f.get("ep-location-confirmed").checked = true;
  assert.equal(f.assistant.saveProfile(), false);
  assert.match(f.get("ep-errors").textContent, /medication names and doses/);
  f.get("ep-medications-confirmed").checked = true;
  assert.equal(f.assistant.saveProfile(), true);
  f.assistant.trigger();
  state = f.assistant.simulation.snapshot();
  assert.equal(state.briefing.medical.approved, true);
  assert.equal(state.briefing.medical.medications, "PRIVATE MEDICATION 5 mg");
});

test("editing medications resets its confirmation and opening profile requires fresh location confirmation", (t) => {
  const f = fixture(t);
  f.save({ medications: "Example 5 mg", "medications-confirmed": true });
  f.assistant.openProfile();
  assert.equal(f.get("ep-medications-confirmed").checked, true);
  assert.equal(f.get("ep-location-confirmed").checked, false);
  assert.equal(f.assistant.saveProfile(), false);
  f.get("ep-location-confirmed").checked = true;
  f.get("ep-medications").value = "Changed example 10 mg";
  f.fire("ep-medications", "input");
  assert.equal(f.get("ep-medications-confirmed").checked, false);
  assert.equal(f.assistant.saveProfile(), false);
  assert.equal(f.assistant.profile.medications, "Example 5 mg");
  f.get("ep-location-confirmed").checked = true;
  f.get("ep-location").value = "Changed location";
  f.fire("ep-location", "input");
  assert.equal(f.get("ep-location-confirmed").checked, false);
});

test("check-in and reason update a new briefing snapshot without mutating the original", (t) => {
  const f = fixture(t);
  f.save();
  f.assistant.trigger({ trigger: "voice", reason: "Initial user request" });
  const original = f.assistant.simulation.snapshot();
  f.get("sos-check-in").value = "I can respond";
  f.fire("sos-check-in", "change");
  const revised = f.assistant.simulation.snapshot();
  assert.equal(revised.revision, original.revision + 1);
  assert.equal(revised.briefing.alert.checkIn, "I can respond");
  assert.equal(revised.briefing.alert.trigger, "voice");
  assert.equal(original.briefing.alert.checkIn, "Not answered");
  f.get("sos-reason").value = "  User wants assistance standing up  ";
  f.fire("sos-update");
  assert.equal(
    f.assistant.simulation.snapshot().briefing.alert.reason,
    "User wants assistance standing up",
  );
  assert.equal(original.briefing.alert.reason, "Initial user request");
  assert.equal(f.assistant.profile.name, "Terry Lee");
});

test("confirming alert location updates only the incident with an explicit timestamp", (t) => {
  const f = fixture(t);
  f.save();
  f.assistant.trigger();
  const original = f.assistant.simulation.snapshot();
  for (const invalid of ["", " ", "x".repeat(241)]) {
    f.get("sos-location").value = invalid;
    f.fire("sos-location-confirm");
    assert.equal(f.assistant.simulation.snapshot().revision, original.revision);
    assert.match(f.get("sos-location-status").textContent, /1–240/);
  }
  f.setTime(NOW + 60000);
  f.get("sos-location").value = "  Demo gym, second floor  ";
  f.fire("sos-location-confirm");
  const revised = f.assistant.simulation.snapshot();
  assert.deepEqual(revised.briefing.location, {
    text: "Demo gym, second floor",
    confirmedAt: "2026-09-19T15:31:00.000Z",
    status: "user_confirmed",
  });
  assert.equal(original.briefing.location.text, "Demo gym, north entrance");
  assert.equal(f.assistant.profile.location, "Demo gym, north entrance");
  assert.match(f.get("sos-location-status").textContent, /No GPS/);
});

test("location can be confirmed during an alert without requiring a complete profile", (t) => {
  const f = fixture(t);
  f.assistant.trigger();
  f.get("sos-location").value = "Gym reception, main entrance";
  f.fire("sos-location-confirm");
  const state = f.assistant.simulation.snapshot();
  assert.equal(state.briefing.location.text, "Gym reception, main entrance");
  assert.equal(state.briefing.location.confirmedAt, TIMESTAMP);
  assert.equal(state.briefing.caller.name, "Unknown");
  assert.equal(state.briefing.medical.approved, false);
  assert.equal(f.assistant.profile, null);
});

test("repeated SOS preserves the same incident and timer across all active states", (t) => {
  const f = fixture(t);
  f.assistant.trigger({ trigger: "voice", reason: "Original request" });
  for (const status of ["connecting", "handoff", "acknowledged"]) {
    const before = f.assistant.simulation.snapshot();
    const timers = [...f.pending];
    assert.equal(before.status, status);
    f.fire("spotter-sos");
    assert.deepEqual(f.assistant.simulation.snapshot(), before);
    assert.deepEqual([...f.pending], timers);
    assert.equal(f.get("sos-dialog").open, true);
    f.tick();
  }
  assert.equal(f.stops(), 4);
  assert.equal(f.pending.size, 0);
  assert.match(f.get("sos-status").textContent, /no real responder/);
});

test("cancel clears timers, disables updates, and cannot be revived by a stale callback", (t) => {
  const f = fixture(t);
  f.assistant.trigger();
  const stale = [...f.pending.values()][0].callback;
  f.fire("sos-cancel");
  const cancelled = f.assistant.simulation.snapshot();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.pending.size, 0);
  assert.equal(f.get("sos-cancel").disabled, true);
  assert.equal(f.get("sos-update").disabled, true);
  assert.match(f.get("sos-status").textContent, /no call or message was sent/);
  f.get("sos-reason").value = "Should not change cancelled briefing";
  f.fire("sos-update");
  f.get("sos-location").value = "Should not replace cancelled location";
  f.fire("sos-location-confirm");
  stale();
  assert.deepEqual(f.assistant.simulation.snapshot(), cancelled);
});

test("closing or escaping incident clears its medical snapshot, UI, and pending timers", (t) => {
  const f = fixture(t);
  f.save({ conditions: "Private report", "share-medical": true });
  for (const [id, eventType] of [
    ["sos-close", "click"],
    ["sos-dialog", "cancel"],
  ]) {
    f.assistant.trigger();
    const stale = [...f.pending.values()][0].callback;
    const event = f.fire(id, eventType);
    if (eventType === "cancel") assert.equal(event.defaultPrevented, true);
    assert.equal(f.pending.size, 0);
    assert.equal(f.assistant.incidentProfile, null);
    assert.equal(f.assistant.simulation.snapshot().briefing, null);
    assert.equal(f.get("sos-dialog").open, false);
    assert.equal(f.get("sos-reason").value, "");
    assert.equal(f.get("sos-location").value, "");
    assert.equal(f.get("sos-briefing").children.length, 0);
    assert.equal(f.get("sos-timeline").children.length, 0);
    stale();
    assert.equal(f.assistant.simulation.snapshot().status, "idle");
    assert.equal(f.assistant.profile.conditions, "Private report");
  }
});

test("clear profile wipes saved and incident details and resets recipient to default", (t) => {
  const f = fixture(t);
  f.assistant.setUser({ utorid: "leeterry", name: "Terry Lee" });
  f.save({
    conditions: "PRIVATE REPORT",
    "share-medical": true,
    recipient: TEST_RECIPIENTS[1].id,
  });
  f.assistant.trigger();
  f.fire("ep-clear");
  assert.equal(f.assistant.profile, null);
  assert.equal(f.assistant.incidentProfile, null);
  assert.equal(f.assistant.recipientId, TEST_RECIPIENTS[0].id);
  assert.equal(f.pending.size, 0);
  assert.equal(f.get("sos-dialog").open, false);
  assert.equal(f.get("ep-conditions").value, "");
  assert.equal(f.get("ep-name").value, "Terry Lee");
  assert.equal(f.get("ep-location-confirmed").checked, false);
  assert.equal(f.get("emergency-profile-dialog").open, true);
  assert.match(f.get("ep-profile-status").textContent, /not set/);
});

test("sign-out or identity switch wipes private state while same identity preserves saved profile", (t) => {
  const f = fixture(t);
  const user = { utorid: "leeterry", name: "Terry Lee" };
  f.assistant.setUser(user);
  f.save({ allergies: "PRIVATE ALLERGY", "share-medical": true });
  f.assistant.setUser({ ...user });
  assert.equal(f.assistant.profile.allergies, "PRIVATE ALLERGY");
  f.assistant.trigger();
  f.assistant.setUser({ utorid: "otheruser", name: "New User" });
  assert.equal(f.assistant.profile, null);
  assert.equal(f.assistant.incidentProfile, null);
  assert.equal(f.pending.size, 0);
  assert.equal(f.get("sos-dialog").open, false);
  f.assistant.openProfile();
  assert.equal(f.get("ep-name").value, "New User");
  assert.equal(f.get("ep-allergies").value, "");
  f.assistant.setUser(null);
  assert.equal(f.assistant.userKey, null);
  assert.equal(f.assistant.defaultName, "");
  f.assistant.openProfile();
  assert.equal(f.get("ep-name").value, "");
  assert.equal(f.get("ep-callback").value, "");
});

test("briefing rendering uses text nodes for user content and never HTML", (t) => {
  const f = fixture(t);
  const markup = '<img src=x onerror="alert(1)">';
  f.save({ name: markup, conditions: markup, "share-medical": true });
  f.assistant.trigger({ reason: markup });
  const rendered = f.renderedBriefing();
  assert.equal(rendered.Caller, markup);
  assert.equal(rendered["Reported conditions"], markup);
  assert.equal(rendered["Alert reason"], markup);
  assert.ok(
    f
      .get("sos-briefing")
      .children.every((child) => child.children.length === 0),
  );
});
