import {
  emptyEmergencyProfile,
  validateEmergencyProfile,
  buildEmergencyBriefing,
} from "./emergency-profile.js";
import { SosSimulation, TEST_RECIPIENTS } from "./sos-simulation.js";

const fields = {
  name: "name",
  callback: "callback",
  language: "language",
  location: "location",
  conditions: "conditions",
  medications: "medications",
  allergies: "allergies",
  contactName: "contact-name",
  contactPhone: "contact-phone",
  locationConfirmed: "location-confirmed",
  medicationsConfirmed: "medications-confirmed",
  shareMedical: "share-medical",
};
const flags = new Set([
  "locationConfirmed",
  "medicationsConfirmed",
  "shareMedical",
]);
const activeStatuses = new Set(["connecting", "handoff", "acknowledged"]);

/** All emergency data and dispatch states are local, ephemeral demo objects. */
export class EmergencyAssistant {
  constructor({
    root = document,
    onStop = () => {},
    onPause = () => {},
    now = () => Date.now(),
    simulationOptions = {},
  } = {}) {
    this.root = root;
    this.onStop = onStop;
    this.onPause = onPause;
    this.now = now;
    this.profile = null;
    this.incidentProfile = null;
    this.defaultName = "";
    this.userKey = null;
    this.recipientId = TEST_RECIPIENTS[0].id;
    this.simulation = new SosSimulation({
      ...simulationOptions,
      now,
      onUpdate: (state) => this.renderIncident(state),
    });
    const bind = (id, event, action) =>
      this.el(id).addEventListener(event, action);
    bind("emergency-profile-open", "click", () => this.openProfile());
    bind("ep-close", "click", () => this.closeProfile());
    bind("ep-clear", "click", () => {
      this.clear();
      this.openProfile();
    });
    bind("emergency-profile-form", "submit", (event) => {
      event.preventDefault();
      this.saveProfile();
    });
    bind("emergency-profile-dialog", "cancel", (event) => {
      event.preventDefault();
      this.closeProfile();
    });
    bind("ep-location", "input", () => {
      this.el("ep-location-confirmed").checked = false;
    });
    bind("ep-medications", "input", () => {
      this.el("ep-medications-confirmed").checked = false;
    });
    for (const field of ["ep-conditions", "ep-medications", "ep-allergies"])
      bind(field, "input", () => {
        this.el("ep-share-medical").checked = false;
      });
    bind("sos-location", "input", () =>
      this.text(
        "sos-location-status",
        "Edited location is not confirmed. The briefing still shows the last confirmed location.",
      ),
    );
    bind("spotter-sos", "click", () => this.trigger({ trigger: "button" }));
    bind("ep-sos", "click", () => this.trigger({ trigger: "button" }));
    bind("sos-cancel", "click", () => this.simulation.cancel());
    bind("sos-close", "click", () => this.closeIncident());
    bind("sos-dialog", "cancel", (event) => {
      event.preventDefault();
      this.closeIncident();
    });
    bind("sos-check-in", "change", () => this.updateBriefing());
    bind("sos-update", "click", () => this.updateBriefing());
    bind("sos-location-confirm", "click", () => this.confirmLocation());
    this.el("ep-recipient").replaceChildren(
      ...TEST_RECIPIENTS.map((recipient) => {
        const option = this.root.createElement("option");
        option.value = recipient.id;
        option.textContent = `${recipient.name} · ${recipient.address}`;
        return option;
      }),
    );
    this.fillProfile(emptyEmergencyProfile());
    this.renderProfileStatus();
  }

  el(id) {
    return this.root.getElementById(id);
  }
  text(id, value) {
    this.el(id).textContent = String(value ?? "");
  }

  setUser(user) {
    const key = user ? user.utorid || user.email || user.name : null;
    if (key !== this.userKey) this.clear();
    this.userKey = key;
    this.defaultName = user?.name || "";
  }

  fillProfile(profile) {
    for (const [key, suffix] of Object.entries(fields)) {
      const field = this.el(`ep-${suffix}`);
      if (flags.has(key)) field.checked = profile[key] === true;
      else field.value = profile[key] || "";
      field.removeAttribute("aria-invalid");
    }
    this.el("ep-recipient").value = this.recipientId;
    this.text("ep-errors", "");
    this.el("ep-errors").hidden = true;
  }

  openProfile() {
    this.onPause();
    this.fillProfile(
      this.profile || {
        ...emptyEmergencyProfile(this.defaultName),
        language: "English",
      },
    );
    // Every save requires an explicit new location confirmation.
    this.el("ep-location-confirmed").checked = false;
    if (!this.el("emergency-profile-dialog").open)
      this.el("emergency-profile-dialog").showModal();
    this.el("ep-name").focus();
  }

  closeProfile() {
    this.el("emergency-profile-dialog").close();
    // Unsaved drafts never become briefing data, and are removed on close.
    this.fillProfile(emptyEmergencyProfile());
  }

  saveProfile() {
    const input = Object.fromEntries(
      Object.entries(fields).map(([key, suffix]) => [
        key,
        flags.has(key)
          ? this.el(`ep-${suffix}`).checked
          : this.el(`ep-${suffix}`).value,
      ]),
    );
    const result = validateEmergencyProfile(input, { now: this.now() });
    const recipientId = this.el("ep-recipient").value;
    if (!TEST_RECIPIENTS.some((recipient) => recipient.id === recipientId))
      result.errors.recipient = "Choose an allowlisted demo recipient.";
    for (const [key, suffix] of Object.entries(fields))
      this.el(`ep-${suffix}`).setAttribute(
        "aria-invalid",
        String(Boolean(result.errors[key])),
      );
    if (Object.keys(result.errors).length) {
      this.text("ep-errors", Object.values(result.errors).join(" "));
      this.el("ep-errors").hidden = false;
      this.el("ep-errors").focus();
      return false;
    }
    this.profile = structuredClone(result.profile);
    this.recipientId = recipientId;
    this.closeProfile();
    this.renderProfileStatus();
    return true;
  }

  renderProfileStatus() {
    this.text(
      "ep-profile-status",
      this.profile
        ? "Emergency profile saved in this page only."
        : "Emergency profile not set. SOS demo still works.",
    );
  }

  trigger({ trigger = "button", reason } = {}) {
    // Stop movement and pending AI work synchronously, before any simulation timers.
    const context = this.onStop() || {};
    this.closeProfile();
    if (!activeStatuses.has(this.simulation.snapshot().status)) {
      this.simulation.reset();
      this.incidentProfile = this.profile
        ? structuredClone(this.profile)
        : null;
      this.triggerSource = trigger === "voice" ? "voice" : "button";
      this.reason = (reason || context.reason || "User requested help").slice(
        0,
        240,
      );
      this.el("sos-reason").value = this.reason;
      this.el("sos-location").value = this.incidentProfile?.location || "";
      this.el("sos-check-in").value = "Not answered";
      this.text(
        "sos-location-status",
        "Location has not been reconfirmed for this alert.",
      );
      try {
        this.simulation.start({
          recipientId: this.recipientId,
          briefing: this.briefing(),
        });
      } catch {
        this.simulation.cancel();
        this.text(
          "sos-status",
          "Simulation could not start. No call or message was sent.",
        );
        this.el("sos-cancel").disabled = true;
      }
    }
    if (!this.el("sos-dialog").open) this.el("sos-dialog").showModal();
    this.el("sos-title").focus();
  }

  briefing() {
    return buildEmergencyBriefing({
      profile: this.incidentProfile,
      reason: this.reason,
      trigger: this.triggerSource,
      checkIn: this.el("sos-check-in").value,
      now: this.now(),
    });
  }

  updateBriefing() {
    if (!activeStatuses.has(this.simulation.snapshot().status)) return;
    this.reason =
      this.el("sos-reason").value.trim().slice(0, 240) || "User requested help";
    this.simulation.updateBriefing(this.briefing());
  }

  confirmLocation() {
    if (!activeStatuses.has(this.simulation.snapshot().status)) return;
    const location = this.el("sos-location").value.trim();
    if (!location || location.length > 240) {
      this.text(
        "sos-location-status",
        "Enter a physical location of 1–240 characters before confirming.",
      );
      return;
    }
    this.incidentProfile = {
      ...(this.incidentProfile || emptyEmergencyProfile()),
      location,
      locationConfirmed: true,
      locationConfirmedAt: new Date(this.now()).toISOString(),
    };
    this.text(
      "sos-location-status",
      "Location confirmed by you for this alert. No GPS or address verification was performed.",
    );
    this.simulation.updateBriefing(this.briefing());
  }

  renderIncident(state) {
    const labels = {
      idle: "Simulation idle",
      connecting: "Connecting to the local demo recipient…",
      handoff: "Simulated connection · preparing the briefing",
      acknowledged: "Demo acknowledgement · no real responder was contacted",
      cancelled: "Simulation cancelled · no call or message was sent",
    };
    this.text("sos-status", labels[state.status] || "Simulation unavailable");
    this.text(
      "sos-recipient",
      state.recipient
        ? `Allowlisted test recipient: ${state.recipient.name} (${state.recipient.address})`
        : "",
    );
    this.el("sos-timeline").replaceChildren(
      ...(state.events || []).map((event) => {
        const item = this.root.createElement("li");
        item.textContent = event.message;
        return item;
      }),
    );
    const b = state.briefing;
    const rows = b
      ? [
          ["Caller", b.caller.name],
          ["Callback number", b.caller.callback],
          ["Preferred language", b.caller.language],
          ["Physical location", b.location.text],
          [
            "Location confirmation",
            b.location.confirmedAt
              ? `Last user confirmation: ${b.location.confirmedAt}; location is not independently verified.`
              : "Unknown / unconfirmed",
          ],
          ["Alert reason", b.alert.reason],
          ["Triggered by", b.alert.trigger],
          ["Check-in response", b.alert.checkIn],
          [
            "Emergency contact (reference only)",
            `${b.emergencyContact.name} · ${b.emergencyContact.phone}`,
          ],
          [
            "Medical-detail approval",
            b.medical.approved
              ? "Approved by user for this simulated briefing"
              : "Not approved · details withheld",
          ],
          ["Reported conditions", b.medical.conditions],
          ["Confirmed medications / doses", b.medical.medications],
          ["Reported allergies", b.medical.allergies],
        ]
      : [];
    this.el("sos-briefing").replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const term = this.root.createElement("dt");
        const detail = this.root.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        return [term, detail];
      }),
    );
    const active = activeStatuses.has(state.status);
    this.el("sos-cancel").disabled = !active;
    for (const id of [
      "sos-check-in",
      "sos-reason",
      "sos-update",
      "sos-location",
      "sos-location-confirm",
    ])
      this.el(id).disabled = !active;
  }

  closeIncident() {
    this.simulation.cancel();
    this.simulation.reset();
    this.incidentProfile = null;
    this.reason = "";
    this.triggerSource = "";
    this.el("sos-reason").value = "";
    this.el("sos-location").value = "";
    this.el("sos-check-in").value = "Not answered";
    this.text("sos-location-status", "");
    this.el("sos-dialog").close();
  }

  clear() {
    this.closeIncident();
    this.profile = null;
    this.recipientId = TEST_RECIPIENTS[0].id;
    this.closeProfile();
    this.renderProfileStatus();
  }
}
