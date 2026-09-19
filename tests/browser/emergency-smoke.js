// Local-only Phase 5 fixture. Synthetic exercise input and mocked recognition.
import "/test-session.js";
import { workout } from "/test-workout.js";
import { EmergencyAssistant } from "/static/js/emergency-assistant.js";
const $ = (id) => document.getElementById(id);
const banner = $("fixture-status").parentElement;
const note = document.createElement("p");
note.id = "emergency-fixture-status";
note.textContent =
  "PHASE 5 FIXTURE · Fictitious profile only. SOS uses the production local simulator; voice events and movement are synthetic. No camera, microphone, or external dispatch.";
banner.append(note);
const emergency = new EmergencyAssistant({
  onPause: () => {
    workout.commands.stop();
    workout.review.cancel();
    workout.pause();
    workout.voice.stop();
    workout.sessionSummary.replay.pause();
  },
  onStop: () => {
    workout.commands.stop();
    workout.review.cancel();
    workout.voice.stop();
    workout.sessionSummary.replay.pause();
    workout.endSession();
    note.textContent =
      "PASS · SOS stopped the workout, microphone intent, camera, speech, and pending review before starting the local simulation.";
    return {
      reason: "Synthetic fixture user requested help during a test set",
    };
  },
});
workout.onHelp = (context) => emergency.trigger(context);
emergency.setUser({ name: "Demo Tester", utorid: "fixture-only" });
const reset = document.createElement("button");
reset.className = "button secondary";
reset.textContent = "Simulate sign-out and check emergency cleanup";
reset.addEventListener("click", () => {
  emergency.clear();
  emergency.setUser(null);
  workout.dispose();
  const clean =
    emergency.profile === null &&
    emergency.incidentProfile === null &&
    emergency.simulation.snapshot().status === "idle" &&
    !$("sos-briefing").textContent &&
    !$("ep-callback").value;
  note.textContent = clean
    ? "PASS · Profile, medical data, briefing, simulation timers, and workout cleared."
    : "FAIL · Emergency data remains.";
});
banner.append(reset);
window.addEventListener("pagehide", () => emergency.clear());
