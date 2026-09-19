// Test-only: ordinary authenticated API requests using synthetic workout frames.
// The production app has neither this route nor a synthetic-pose bypass.
import { workout } from "/test-workout.js";
const banner = document.createElement("div");
banner.className = "notice";
banner.style.margin = "20px";
const label = document.createElement("p");
label.textContent =
  "PHASE 3 TEST FIXTURE · Synthetic exercise images only. Setting up the demo session…";
banner.append(label);
document.body.prepend(banner);
let csrf;
async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
      : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.csrf_token) csrf = data.csrf_token;
  return { data, response };
}
workout.review.requestCoach = async (payload, signal) => {
  const { data, response } = await api("/api/coach", payload, signal);
  return {
    feedback: data,
    source: response.headers.get("X-Spotter-Coach-Source"),
    reason: response.headers.get("X-Spotter-Coach-Reason"),
  };
};
try {
  await api("/api/session");
  await api("/api/auth/barcode", { code: "leeterry" });
  const { data } = await api("/api/workout/draft", {
    goal: "fitness",
    experience: "beginner",
    minutes: 20,
    equipment: ["bodyweight", "dumbbells"],
    avoid: [],
    restrictions: "",
  });
  for (const exercise of data.workout.exercises) {
    exercise.sets = 2;
    exercise.reps = 4;
    exercise.rest_seconds = 30;
  }
  await api("/api/workout/confirm", { workout: data.workout });
  // Each synthetic run has another planned set, so the adaptation controls appear.
  const originalOpen = workout.open.bind(workout);
  workout.open = (plan) => {
    const copy = structuredClone(plan);
    copy.exercises.forEach((exercise) => {
      exercise.sets = 2;
    });
    originalOpen(copy);
  };
  label.textContent =
    "PHASE 3 TEST FIXTURE · Demo session ready. Run a synthetic set, select feedback, and request review. With no API key, expect clearly labelled LOCAL GUIDANCE. This page never tests physical exercise accuracy.";
} catch (error) {
  label.textContent = `FIXTURE FAILED · ${error.message}`;
}
