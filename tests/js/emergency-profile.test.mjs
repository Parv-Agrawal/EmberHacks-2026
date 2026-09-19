import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyEmergencyProfile,
  validateEmergencyProfile,
  buildEmergencyBriefing,
} from "../../app/static/js/emergency-profile.js";

const NOW = Date.UTC(2026, 8, 19, 15, 30);
const TIMESTAMP = "2026-09-19T15:30:00.000Z";
const draft = (overrides = {}) => ({
  ...emptyEmergencyProfile("Terry Lee"),
  callback: "+1 (416) 555-0100",
  language: "English",
  location: "Robarts Library, ground floor, west entrance",
  locationConfirmed: true,
  ...overrides,
});
const saved = (overrides = {}) =>
  validateEmergencyProfile(draft(overrides), { now: NOW }).profile;

test("a new draft only carries an explicitly supplied name", () => {
  const profile = emptyEmergencyProfile("  Terry Lee  ");
  assert.equal(profile.name, "Terry Lee");
  for (const field of [
    "callback",
    "conditions",
    "medications",
    "allergies",
    "contactName",
    "contactPhone",
    "language",
    "location",
  ])
    assert.equal(profile[field], "");
  for (const field of [
    "locationConfirmed",
    "medicationsConfirmed",
    "shareMedical",
  ])
    assert.equal(profile[field], false);
  assert.equal(emptyEmergencyProfile(null).name, "");
  assert.notEqual(emptyEmergencyProfile(), emptyEmergencyProfile());
});

test("a valid save trims fields and records explicit location confirmation", () => {
  const input = draft({
    name: " Terry Lee ",
    callback: " +1 (416) 555-0100 ",
    conditions: " Asthma reported by user ",
    medications: " Example medication, user-entered dose ",
    medicationsConfirmed: true,
    allergies: " Not sure ",
    contactName: " Jordan ",
    contactPhone: " 416-555-0123 ",
    shareMedical: true,
    studentId: "SHOULD-NOT-BE-COPIED",
    locationConfirmedAt: "untrusted old timestamp",
  });
  const original = structuredClone(input);
  const { profile, errors } = validateEmergencyProfile(input, { now: NOW });
  assert.deepEqual(errors, {});
  assert.equal(profile.locationConfirmedAt, TIMESTAMP);
  assert.equal(profile.name, "Terry Lee");
  assert.equal(profile.medications, "Example medication, user-entered dose");
  assert.equal(profile.allergies, "Not sure");
  assert.equal(profile.contactPhone, "416-555-0123");
  assert.equal(profile.shareMedical, true);
  assert.equal(profile.studentId, undefined);
  assert.deepEqual(input, original);
  assert.notEqual(profile, input);
});

test("required fields and location confirmation have individual errors", () => {
  const { profile, errors } = validateEmergencyProfile(
    emptyEmergencyProfile(),
    {
      now: NOW,
    },
  );
  assert.equal(profile, null);
  assert.deepEqual(Object.keys(errors).sort(), [
    "callback",
    "language",
    "location",
    "locationConfirmed",
    "name",
  ]);
  assert.match(errors.locationConfirmed, /Confirm/);
});

test("profile text limits fail instead of truncating emergency information", () => {
  for (const [field, limit] of [
    ["name", 80],
    ["language", 60],
    ["location", 240],
    ["conditions", 500],
    ["medications", 500],
    ["allergies", 500],
    ["contactName", 80],
  ]) {
    const extra = {
      medicationsConfirmed: true,
      contactName: "Jordan",
      contactPhone: "4165550123",
    };
    const valid = validateEmergencyProfile(
      draft({ ...extra, [field]: "x".repeat(limit) }),
      { now: NOW },
    );
    assert.ok(valid.profile, `${field} accepts its limit`);
    const invalid = validateEmergencyProfile(
      draft({ ...extra, [field]: "x".repeat(limit + 1) }),
      { now: NOW },
    );
    assert.equal(invalid.profile, null, field);
    assert.match(invalid.errors[field], /characters or fewer/, field);
  }
});

test("callback accepts common formatting and only 7–15 digits", () => {
  for (const callback of [
    "5550100",
    "416-555-0100",
    "+1 (416) 555-0100",
    "+123456789012345",
    "(416) 555 0100",
  ])
    assert.ok(saved({ callback }), callback);
  for (const callback of [
    "123456",
    "1234567890123456",
    "++14165550100",
    "416+5550100",
    "call 4165550100",
    "4165550100 ext 20",
    "416\n5550100",
    "(4165550100",
    "416)5550100",
    "+1 ((416)) 5550100",
  ]) {
    const result = validateEmergencyProfile(draft({ callback }), { now: NOW });
    assert.equal(result.profile, null, callback);
    assert.ok(result.errors.callback, callback);
  }
});

test("emergency contact is optional but name and valid phone must be paired", () => {
  assert.ok(saved());
  assert.ok(saved({ contactName: "Jordan", contactPhone: "+1 416 555 0123" }));
  for (const [overrides, field] of [
    [{ contactName: "Jordan" }, "contactPhone"],
    [{ contactPhone: "4165550123" }, "contactName"],
    [{ contactName: "Jordan", contactPhone: "911" }, "contactPhone"],
  ]) {
    const result = validateEmergencyProfile(draft(overrides), { now: NOW });
    assert.equal(result.profile, null);
    assert.ok(result.errors[field]);
  }
});

test("medication text needs explicit name and dose confirmation even without sharing", () => {
  for (const shareMedical of [true, false]) {
    const result = validateEmergencyProfile(
      draft({ medications: "User-entered medication 5 mg", shareMedical }),
      { now: NOW },
    );
    assert.equal(result.profile, null);
    assert.match(result.errors.medicationsConfirmed, /names and doses/);
  }
  assert.ok(saved({ medications: "", medicationsConfirmed: false }));
  assert.ok(
    saved({
      medications: "Exact user text; no dose inference",
      medicationsConfirmed: true,
    }),
  );
});

test("consent and confirmations reject truthy strings, numbers, and missing flags", () => {
  for (const field of [
    "locationConfirmed",
    "medicationsConfirmed",
    "shareMedical",
  ]) {
    for (const value of ["true", "false", 1, 0, null, undefined, {}, []]) {
      const result = validateEmergencyProfile(draft({ [field]: value }), {
        now: NOW,
      });
      assert.equal(result.profile, null, `${field}: ${String(value)}`);
      assert.ok(result.errors[field]);
    }
  }
});

test("wrong text types and invalid clocks produce field errors without coercion", () => {
  for (const field of ["name", "callback", "conditions", "allergies"])
    assert.ok(
      validateEmergencyProfile(
        draft({ [field]: { toString: () => "secret" } }),
        {
          now: NOW,
        },
      ).errors[field],
    );
  for (const now of [NaN, Infinity, "2026-09-19", 1e20]) {
    const result = validateEmergencyProfile(draft(), { now });
    assert.equal(result.profile, null);
    assert.ok(result.errors.locationConfirmed);
  }
  for (const input of [undefined, null, [], "name", 1])
    assert.equal(validateEmergencyProfile(input, { now: NOW }).profile, null);
});

test("SOS briefing works immediately without a profile and states unknown details", () => {
  assert.deepEqual(buildEmergencyBriefing({ now: NOW }), {
    mode: "SIMULATION / DEMO MODE",
    createdAt: TIMESTAMP,
    caller: {
      name: "Unknown",
      callback: "Not provided",
      language: "Not provided",
    },
    location: { text: "Unknown", confirmedAt: null, status: "unconfirmed" },
    alert: {
      reason: "User requested help",
      trigger: "button",
      checkIn: "Not answered",
    },
    emergencyContact: { name: "Not provided", phone: "Not provided" },
    medical: {
      approved: false,
      conditions: "Withheld",
      medications: "Withheld",
      allergies: "Withheld",
    },
  });
});

test("unapproved medical details never enter the handoff snapshot", () => {
  for (const shareMedical of [false, undefined, "true", 1]) {
    const profile = {
      ...saved({
        conditions: "PRIVATE CONDITION",
        medications: "PRIVATE MEDICATION",
        medicationsConfirmed: true,
        allergies: "PRIVATE ALLERGY",
      }),
      shareMedical,
    };
    const briefing = buildEmergencyBriefing({ profile, now: NOW });
    assert.equal(briefing.medical.approved, false);
    assert.doesNotMatch(JSON.stringify(briefing), /PRIVATE/);
  }
});

test("approved details remain verbatim and unconfirmed medications stay withheld", () => {
  const profile = saved({
    shareMedical: true,
    conditions: "Unsure; user reported",
    medications: "Example medication 5 mg, user confirmed",
    medicationsConfirmed: true,
    allergies: "No allergies reported by user",
  });
  const briefing = buildEmergencyBriefing({ profile, now: NOW });
  assert.deepEqual(briefing.medical, {
    approved: true,
    conditions: profile.conditions,
    medications: profile.medications,
    allergies: profile.allergies,
  });
  for (const medicationsConfirmed of [false, "true", undefined]) {
    const guarded = buildEmergencyBriefing({
      profile: { ...profile, medicationsConfirmed },
      now: NOW,
    });
    assert.equal(guarded.medical.medications, "Withheld");
    assert.equal(guarded.medical.conditions, profile.conditions);
  }
});

test("only explicitly confirmed location with its recorded timestamp enters briefing", () => {
  const profile = saved();
  const confirmed = buildEmergencyBriefing({ profile, now: NOW + 60000 });
  assert.deepEqual(confirmed.location, {
    text: profile.location,
    confirmedAt: TIMESTAMP,
    status: "user_confirmed",
  });
  for (const changes of [
    { locationConfirmed: false },
    { locationConfirmed: "true" },
    { locationConfirmedAt: undefined },
    { locationConfirmedAt: "just now" },
    { locationConfirmedAt: "2026-02-30T15:30:00.000Z" },
    { location: "" },
  ]) {
    const briefing = buildEmergencyBriefing({
      profile: { ...profile, ...changes },
      now: NOW,
    });
    assert.deepEqual(briefing.location, {
      text: "Unknown",
      confirmedAt: null,
      status: "unconfirmed",
    });
  }
});

test("briefing is a frozen snapshot with no references to later profile edits", () => {
  const profile = saved({ shareMedical: true, conditions: "Original report" });
  const briefing = buildEmergencyBriefing({
    profile,
    reason: "Voice help request",
    trigger: "voice",
    checkIn: "User says they can respond",
    now: NOW,
  });
  profile.name = "Different user";
  profile.conditions = "Changed report";
  profile.location = "Changed location";
  assert.equal(briefing.caller.name, "Terry Lee");
  assert.equal(briefing.medical.conditions, "Original report");
  assert.notEqual(briefing.location.text, profile.location);
  assert.deepEqual(briefing.alert, {
    reason: "Voice help request",
    trigger: "voice",
    checkIn: "User says they can respond",
  });
  assert.ok(Object.isFrozen(briefing));
  for (const section of [
    "caller",
    "location",
    "alert",
    "emergencyContact",
    "medical",
  ])
    assert.ok(Object.isFrozen(briefing[section]), section);
  assert.throws(() => {
    briefing.caller.name = "Mutated";
  }, TypeError);
});

test("plain user strings are not executed or transformed into medical claims", () => {
  const value = '<img src=x onerror="alert(1)">';
  const profile = saved({ name: value, conditions: value, shareMedical: true });
  const briefing = buildEmergencyBriefing({ profile, reason: value, now: NOW });
  assert.equal(briefing.caller.name, value);
  assert.equal(briefing.medical.conditions, value);
  assert.equal(briefing.alert.reason, value);
  // Rendering uses textContent; this pure module must not emit HTML markup.
  assert.equal(typeof briefing.caller.name, "string");
});

test("empty approved details are explicit and an invalid clock never blocks SOS", () => {
  const briefing = buildEmergencyBriefing({
    profile: saved({ shareMedical: true, medicationsConfirmed: true }),
    reason: {},
    trigger: null,
    checkIn: " ",
    now: NaN,
  });
  assert.equal(briefing.createdAt, "Unknown");
  assert.equal(briefing.alert.reason, "User requested help");
  assert.equal(briefing.alert.trigger, "Unknown");
  assert.equal(briefing.alert.checkIn, "Not answered");
  assert.deepEqual(briefing.medical, {
    approved: true,
    conditions: "Not provided",
    medications: "Not provided",
    allergies: "Not provided",
  });
});
