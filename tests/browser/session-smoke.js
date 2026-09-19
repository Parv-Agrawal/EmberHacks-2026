// Developer-only simulated recognition. No microphone or outbound speech service.
import { workout } from "/test-workout.js";
const $ = (id) => document.getElementById(id);
const banner = $("fixture-status").parentElement;
const intro = document.createElement("p");
intro.textContent =
  "PHASE 4 FIXTURE · Speech events are simulated; no microphone opens. Run a synthetic squat, then enable voice commands and send a phrase. Add an image-free test set to check replay fallback.";
banner.append(intro);
class FixtureRecognition {
  start() {
    this.results = [];
    this.onstart?.();
  }
  abort() {
    this.onend?.();
  }
  emit(transcript) {
    const result = [{ transcript }];
    result.isFinal = true;
    this.results.push(result);
    this.onresult?.({
      resultIndex: this.results.length - 1,
      results: this.results,
    });
  }
}
workout.commands.Recognition = FixtureRecognition;
workout.commands.supported = true;
$("live-listen").disabled = false;
const label = document.createElement("label");
label.textContent = "Simulated spoken phrase ";
const input = document.createElement("input");
input.id = "fixture-phrase";
input.value = "That felt easy";
label.htmlFor = input.id;
const send = document.createElement("button");
send.className = "button secondary";
send.textContent = "Send simulated final speech";
send.addEventListener("click", () =>
  workout.commands.recognition?.emit(input.value),
);
banner.append(label, input, send);
const add = document.createElement("button");
add.className = "button secondary";
add.textContent = "Add image-free synthetic set";
add.addEventListener("click", () => {
  workout.history.recordSet({
    id: "fixture:curl",
    exercise: { id: "bicep_curl", name: "Synthetic curl" },
    setNumber: 1,
    summary: {
      exercise_id: "bicep_curl",
      target_reps: 2,
      completed_reps: 2,
      reps: [1, 2].map((n) => ({
        rep_number: n,
        started_at_ms: n * 2000,
        bottom_at_ms: n * 2000 + 1000,
        completed_at_ms: n * 2000 + 1900,
        peak_angle_deg: 50,
        cadence_seconds: 1.9,
        faults: [],
        score: 0,
      })),
    },
    elapsedMs: 4000,
    keyframes: [],
  });
  workout.history.updateReview("fixture:curl", {
    feedback: "Felt easy",
    effort: 3,
  });
  intro.textContent =
    "Image-free synthetic curl set added. End workout to view both sets and the missing-frame replay state.";
});
banner.append(add);
const audit = document.createElement("button");
audit.className = "button secondary";
audit.textContent = "Check session cleanup";
audit.addEventListener("click", () => {
  const cleared =
    workout.history.sets.length === 0 &&
    workout.sessionSummary.replay.entries.length === 0 &&
    !workout.commands.enabled &&
    !$("replay-image").getAttribute("src");
  intro.textContent = cleared
    ? "PASS · Session images, history, replay, and microphone intent cleared."
    : "Session is still retained. Leave the summary first.";
});
banner.append(audit);
