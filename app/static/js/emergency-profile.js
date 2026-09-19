const REQUIRED_TEXT = Object.freeze({
  name: { label: "Name", limit: 80 },
  callback: { label: "Callback number", limit: 40 },
  language: { label: "Language", limit: 60 },
  location: { label: "Physical location", limit: 240 },
});
const OPTIONAL_TEXT = Object.freeze({
  conditions: { label: "Reported conditions", limit: 500 },
  medications: { label: "Medications and doses", limit: 500 },
  allergies: { label: "Allergies", limit: 500 },
  contactName: { label: "Emergency contact name", limit: 80 },
  contactPhone: { label: "Emergency contact number", limit: 40 },
});
const FLAGS = ["locationConfirmed", "medicationsConfirmed", "shareMedical"];
const text = (value) => (typeof value === "string" ? value.trim() : "");
const provided = (value) => text(value) || "Not provided";
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isoTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function confirmedTimestamp(value) {
  if (typeof value !== "string") return null;
  // Accept only timestamps produced by a saved profile, never a truthy label.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return isoTimestamp(parsed) === value ? value : null;
}

function validPhone(value) {
  if (!/^\+?[0-9 ()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  let parentheses = 0;
  for (const character of value) {
    if (character === "(" && ++parentheses > 1) return false;
    if (character === ")" && --parentheses < 0) return false;
  }
  return parentheses === 0;
}

/** A browser-memory draft only. No medical or location details are inferred. */
export function emptyEmergencyProfile(name = "") {
  return {
    name: text(name),
    callback: "",
    conditions: "",
    medications: "",
    allergies: "",
    contactName: "",
    contactPhone: "",
    language: "",
    location: "",
    locationConfirmed: false,
    medicationsConfirmed: false,
    shareMedical: false,
  };
}

/** Validate an explicit profile save. All returned errors belong to form fields. */
export function validateEmergencyProfile(input, { now = Date.now() } = {}) {
  const source = object(input) ? input : {};
  const profile = {};
  const errors = {};
  for (const [field, { label, limit }] of Object.entries({
    ...REQUIRED_TEXT,
    ...OPTIONAL_TEXT,
  })) {
    const value = source[field];
    profile[field] = text(value);
    if (value != null && typeof value !== "string")
      errors[field] = `${label} must be text.`;
    else if (profile[field].length > limit)
      errors[field] = `${label} must be ${limit} characters or fewer.`;
    else if (field in REQUIRED_TEXT && !profile[field])
      errors[field] = `${label} is required.`;
  }
  for (const field of FLAGS) {
    profile[field] = source[field] === true;
    if (typeof source[field] !== "boolean")
      errors[field] = "Choose this option explicitly.";
  }
  if (profile.callback && !validPhone(profile.callback))
    errors.callback = "Enter a callback number with 7–15 digits.";
  if (profile.contactPhone && !validPhone(profile.contactPhone))
    errors.contactPhone = "Enter a contact number with 7–15 digits.";
  if (profile.contactName && !profile.contactPhone)
    errors.contactPhone = "Add a phone number for this contact.";
  if (profile.contactPhone && !profile.contactName)
    errors.contactName = "Add a name for this contact.";
  if (!profile.locationConfirmed)
    errors.locationConfirmed = "Confirm your current physical location.";
  if (profile.medications && !profile.medicationsConfirmed)
    errors.medicationsConfirmed =
      "Confirm that the medication names and doses are accurate.";
  const timestamp = isoTimestamp(now);
  if (!timestamp)
    errors.locationConfirmed =
      "Confirm your location again to record its time.";
  if (Object.keys(errors).length) return { profile: null, errors };
  profile.locationConfirmedAt = timestamp;
  return { profile, errors };
}

/**
 * Build a new, frozen handoff snapshot without AI or network access. A confirmed
 * location is user-reported at the displayed time, not a live location reading.
 */
export function buildEmergencyBriefing({
  profile = null,
  reason = "User requested help",
  trigger = "button",
  checkIn = "Not answered",
  now = Date.now(),
} = {}) {
  const source = object(profile) ? profile : {};
  const locationTimestamp = confirmedTimestamp(source.locationConfirmedAt);
  const locationConfirmed =
    source.locationConfirmed === true &&
    Boolean(text(source.location)) &&
    Boolean(locationTimestamp);
  const medicalApproved = source.shareMedical === true;
  const briefing = {
    mode: "SIMULATION / DEMO MODE",
    createdAt: isoTimestamp(now) || "Unknown",
    caller: Object.freeze({
      name: text(source.name) || "Unknown",
      callback: provided(source.callback),
      language: provided(source.language),
    }),
    location: Object.freeze({
      text: locationConfirmed ? text(source.location) : "Unknown",
      confirmedAt: locationConfirmed ? locationTimestamp : null,
      status: locationConfirmed ? "user_confirmed" : "unconfirmed",
    }),
    alert: Object.freeze({
      reason: text(reason) || "User requested help",
      trigger: text(trigger) || "Unknown",
      checkIn: text(checkIn) || "Not answered",
    }),
    emergencyContact: Object.freeze({
      name: provided(source.contactName),
      phone: provided(source.contactPhone),
    }),
    medical: Object.freeze({
      approved: medicalApproved,
      conditions: medicalApproved ? provided(source.conditions) : "Withheld",
      medications:
        medicalApproved && source.medicationsConfirmed === true
          ? provided(source.medications)
          : "Withheld",
      allergies: medicalApproved ? provided(source.allergies) : "Withheld",
    }),
  };
  return Object.freeze(briefing);
}
