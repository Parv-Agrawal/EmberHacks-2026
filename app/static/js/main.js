import { LiveWorkout } from "./live-workout.js";
import { BarcodeScanner } from "./barcode.js";
import { CameraCalibration, MAX_FRAME_AGE_MS } from "./calibration.js";

const $ = (id) => document.getElementById(id);
const state = {
  view: "signin",
  user: null,
  workout: null,
  csrf: "",
  email: "",
  calibration: null,
};
const steps = ["signin", "onboarding", "plan", "calibration"];
const goals = {
  strength: "Build strength",
  fitness: "Get moving",
  confidence: "Find confidence",
};
let audioContext;
let authPending = false;
let bootPromise;

function notice(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function api(path, body, { signal, coach = false } = {}) {
  if (body !== undefined && !state.csrf) await bootPromise;
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "We couldn’t reach Spotter. Check that the local server is running, then try again.",
    );
  }
  const result = await response.json().catch(() => ({}));
  const sessionEnded =
    response.status === 401 && result.code === "sign_in_required";
  const sessionChanged =
    response.status === 403 && result.code === "csrf_rejected";
  if ((sessionEnded || sessionChanged) && state.user) {
    resetSessionView();
    notice(
      "signin-error",
      "Your session has ended or changed. Refresh this page to check in again.",
    );
  }
  if (!response.ok)
    throw new Error(result.error || "Something went wrong. Please try again.");
  if (result.csrf_token) state.csrf = result.csrf_token;
  if (coach)
    return {
      feedback: result,
      source: response.headers.get("X-Spotter-Coach-Source"),
      reason: response.headers.get("X-Spotter-Coach-Reason"),
    };
  return result;
}

function disableControls(controls) {
  const previous = [...new Set(controls)].map((control) => [
    control,
    control.disabled,
  ]);
  previous.forEach(([control]) => {
    control.disabled = true;
  });
  return () =>
    previous.forEach(([control, disabled]) => {
      control.disabled = disabled;
    });
}

async function action(button, errorId, task, scope) {
  if (button.disabled) return;
  const restore = disableControls([
    button,
    ...(scope?.querySelectorAll("button, input, select, textarea") || []),
  ]);
  button.setAttribute("aria-busy", "true");
  notice(errorId);
  try {
    await task();
  } catch (error) {
    notice(errorId, error.message);
  } finally {
    restore();
    button.removeAttribute("aria-busy");
  }
}

function showView(view, { focus = true } = {}) {
  state.view = view;
  liveWorkout.dispose();
  scanner.stop();
  calibration.stop();
  state.calibration = null;
  updateScanner({
    status: "stopped",
    message: "Hold the barcode side of your TCard toward the camera.",
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });
  const current = ["ready", "workout"].includes(view) ? 4 : steps.indexOf(view);
  document.querySelectorAll("[data-step]").forEach((item, index) => {
    item.classList.toggle("complete", index < current);
    if (index === current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  notice("global-error");
  if (view === "calibration")
    updateCalibration({
      status: "stopped",
      ready: false,
      message: "Enable your camera when you’re ready.",
      checks: {},
    });
  if (focus) {
    document.querySelector(`#view-${view} h1`)?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

function setUser(user) {
  state.user = user;
  $("sign-out").hidden = !user;
  if (user) {
    const firstName = user.name.split(" ")[0];
    $("greeting-name").textContent = firstName.toUpperCase();
    $("ready-name").textContent = firstName;
    $("sign-out").title = `Sign out ${user.name}`;
  }
}

function restorePreferences(preferences) {
  if (
    !preferences ||
    typeof preferences !== "object" ||
    Array.isArray(preferences)
  )
    return;
  const form = $("onboarding-form");
  for (const name of ["goal", "minutes"]) {
    const controls = [...form.querySelectorAll(`input[name="${name}"]`)];
    const value =
      name === "minutes" && Number.isInteger(preferences[name])
        ? String(preferences[name])
        : preferences[name];
    if (
      typeof value === "string" &&
      controls.some((input) => input.value === value)
    ) {
      controls.forEach((input) => {
        input.checked = input.value === value;
      });
    }
  }
  const experience = $("experience");
  if (
    [...experience.options].some(
      (option) => option.value === preferences.experience,
    )
  )
    experience.value = preferences.experience;
  for (const name of ["equipment", "avoid"]) {
    if (!Array.isArray(preferences[name])) continue;
    for (const input of form.querySelectorAll(`input[name="${name}"]`))
      input.checked = preferences[name].includes(input.value);
  }
  if (typeof preferences.restrictions === "string")
    $("restrictions").value = preferences.restrictions.slice(0, 500);
}

function resetSessionView() {
  setUser(null);
  state.workout = null;
  state.email = "";
  $("onboarding-form").reset();
  $("email-request-form").reset();
  $("demo-code").value = "";
  $("email-code").value = "";
  $("email-request-form").hidden = false;
  $("email-verify-form").hidden = true;
  $("email-status").textContent = "Request a new verification code to sign in.";
  $("exercise-list").replaceChildren();
  for (const id of [
    "plan-minutes",
    "plan-exercise-count",
    "plan-set-count",
    "plan-estimate",
    "plan-goal",
  ])
    $(id).textContent = "—";
  $("confirm-workout").disabled = true;
  $("greeting-name").textContent = "";
  $("ready-name").textContent = "";
  $("ready-workout").textContent = "Workout confirmed";
  $("sign-out").title = "Sign out";
  document.querySelectorAll(".notice").forEach((item) => {
    item.hidden = true;
    item.textContent = "";
  });
  showView("signin");
  selectTab("card");
}

function selectTab(method, focus = false) {
  scanner.stop();
  updateScanner({
    status: "stopped",
    message: "Hold the barcode side of your TCard toward the camera.",
  });
  for (const type of ["card", "email"]) {
    const active = method === type;
    $(`tab-${type}`).setAttribute("aria-selected", String(active));
    $(`tab-${type}`).tabIndex = active ? 0 : -1;
    $(`panel-${type}`).hidden = !active;
  }
  notice("signin-error");
  if (focus) $(`tab-${method}`).focus();
}

for (const method of ["card", "email"]) {
  $(`tab-${method}`).addEventListener("click", () => selectTab(method));
  $(`tab-${method}`).addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      selectTab(
        event.key === "Home"
          ? "card"
          : event.key === "End"
            ? "email"
            : method === "card"
              ? "email"
              : "card",
        true,
      );
    }
  });
}

function prepareTone() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (Audio) {
      if (!audioContext || audioContext.state === "closed")
        audioContext = new Audio();
      audioContext.resume().catch(() => {});
    }
  } catch {
    /* Audio is optional; visual confirmation is always present. */
  }
}

function confirmationTone() {
  if (!audioContext || audioContext.state !== "running") return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.frequency.setValueAtTime(660, now);
  oscillator.frequency.setValueAtTime(880, now + 0.08);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.06, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.22);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

function updateScanner({ status, message }) {
  const active = ["loading", "scanning", "unknown", "detected"].includes(
    status,
  );
  const videoVisible = Boolean($("barcode-video").srcObject);
  $("scanner-placeholder").hidden = videoVisible;
  $("scanner-label").textContent =
    status === "detected"
      ? "TCARD RECOGNIZED"
      : active
        ? "CAMERA ON"
        : "CAMERA OFF";
  $("scanner-status").textContent = message;
  $("start-scanner").hidden = active;
  $("stop-scanner").hidden = !active;
  document.querySelector(".scanner-preview").classList.toggle("active", active);
  if (status === "detected") confirmationTone();
}

async function signInCode(code) {
  if (authPending) return;
  authPending = true;
  const restore = disableControls(
    $("view-signin").querySelectorAll("button, input"),
  );
  notice("signin-error");
  try {
    const result = await api("/api/auth/barcode", { code });
    setUser(result.user);
    $("demo-code").value = "";
    showView("onboarding");
  } catch (error) {
    scanner.stop();
    updateScanner({
      status: "error",
      message: "Check-in didn’t finish. Try again or use email.",
    });
    notice("signin-error", error.message);
  } finally {
    restore();
    authPending = false;
  }
}

const scanner = new BarcodeScanner($("barcode-video"), $("barcode-overlay"), {
  onStatus: (update) => {
    if (state.view === "signin") updateScanner(update);
  },
  onDetected: ({ code }) => {
    if (state.view === "signin" && !$("panel-card").hidden) signInCode(code);
  },
});
$("start-scanner").addEventListener("click", () => {
  notice("signin-error");
  prepareTone();
  scanner.start();
});
$("stop-scanner").addEventListener("click", () => {
  scanner.stop();
  updateScanner({
    status: "stopped",
    message: "Camera is off. You can enable it again or use email.",
  });
});
$("demo-form").addEventListener("submit", (event) => {
  event.preventDefault();
  scanner.stop();
  const button = event.submitter;
  action(button, "signin-error", () => signInCode($("demo-code").value.trim()));
});

$("email-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await action(
    event.submitter,
    "signin-error",
    async () => {
      const email = $("email-address").value.trim();
      const result = await api("/api/auth/email/request", { email });
      state.email = email;
      $("email-request-form").hidden = true;
      $("email-verify-form").hidden = false;
      $("email-code").value = "";
      $("email-status").textContent =
        result.delivery === "console"
          ? "LOCAL DEMO: Find the six-digit code in the server terminal. It expires in 5 minutes. This does not verify email ownership."
          : "Check your email for a six-digit verification code. It expires in 5 minutes.";
    },
    $("view-signin"),
  );
  if (
    state.view === "signin" &&
    !$("panel-email").hidden &&
    !$("email-verify-form").hidden
  )
    $("email-code").focus();
});
$("email-verify-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(
    event.submitter,
    "signin-error",
    async () => {
      const result = await api("/api/auth/email/verify", {
        email: state.email,
        code: $("email-code").value.trim(),
      });
      $("email-code").value = "";
      setUser(result.user);
      showView("onboarding");
    },
    $("view-signin"),
  );
});
$("change-email").addEventListener("click", () => {
  $("email-request-form").hidden = false;
  $("email-verify-form").hidden = true;
  $("email-code").value = "";
  $("email-address").focus();
  notice("signin-error");
});
$("sign-out").addEventListener("click", (event) => {
  scanner.stop();
  calibration.stop();
  liveWorkout.pause();
  liveWorkout.voice.stop();
  liveWorkout.review.reset();
  action(event.currentTarget, "global-error", async () => {
    await api("/api/logout", {});
    resetSessionView();
  });
});

$("onboarding-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  action(
    event.submitter,
    "onboarding-error",
    async () => {
      const result = await api("/api/workout/draft", {
        goal: form.get("goal"),
        experience: form.get("experience"),
        minutes: Number(form.get("minutes")),
        equipment: form.getAll("equipment"),
        avoid: form.getAll("avoid"),
        restrictions: form.get("restrictions").trim(),
      });
      if (state.view !== "onboarding" || !state.user) return;
      state.workout = result.workout;
      if (!result.workout) {
        notice("onboarding-error", result.warnings.join(" "));
        return;
      }
      notice("plan-warnings", result.warnings.join(" "));
      renderWorkout();
      showView("plan");
    },
    $("onboarding-form"),
  );
});

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function renderWorkout() {
  const list = $("exercise-list");
  list.replaceChildren();
  state.workout.exercises.forEach((exercise, index) => {
    const card = node("article", "exercise-card");
    const art = node(
      "div",
      `exercise-art ${exercise.id === "bicep_curl" ? "curl" : ""}`,
    );
    art.setAttribute("aria-hidden", "true");
    // Static artwork only. All account, API, and user text uses textContent.
    art.innerHTML =
      exercise.id === "squat"
        ? '<svg viewBox="0 0 90 90"><circle cx="49" cy="16" r="7"/><path d="m45 27-8 23 22 7-12 22H34m4-30-18 8 10 22H17m28-49 20 14 13-2M8 83h72"/></svg>'
        : '<svg viewBox="0 0 90 90"><circle cx="44" cy="16" r="7"/><path d="M44 27v28m-3-25-15 19-9-18m31-1 15 19 9-18M44 55 30 79H19m25-24 13 24h12M10 27h13m43 0h13M8 83h72"/></svg>';
    const body = node("div", "exercise-body");
    body.append(
      node(
        "p",
        "exercise-tag",
        `0${index + 1} / ${exercise.id === "squat" ? "BODYWEIGHT · LOWER BODY" : "DUMBBELLS · UPPER BODY"}`,
      ),
    );
    const heading = node("div", "exercise-heading");
    heading.append(node("h3", "", exercise.name));
    const remove = node("button", "", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${exercise.name}`);
    remove.addEventListener("click", () => {
      state.workout.exercises.splice(index, 1);
      renderWorkout();
    });
    heading.append(remove);
    body.append(heading, node("p", "exercise-cue", exercise.cue));
    const fields = node("div", "exercise-fields");
    for (const [key, label, min, max] of [
      ["sets", "Sets", 1, 4],
      ["reps", "Reps / set", 4, 15],
      ["rest_seconds", "Rest (sec)", 30, 120],
    ]) {
      const wrapper = node("label", "", label);
      const input = node("input");
      input.type = "number";
      input.min = min;
      input.max = max;
      input.step = "1";
      input.required = true;
      input.value = exercise[key];
      input.name = `${exercise.id}-${key}`;
      input.setAttribute("aria-label", `${exercise.name}: ${label}`);
      input.addEventListener("input", () => {
        exercise[key] = input.valueAsNumber;
        updatePlanSummary();
      });
      wrapper.append(input);
      fields.append(wrapper);
    }
    body.append(fields);
    card.append(art, body);
    list.append(card);
  });
  if (!state.workout.exercises.length)
    list.append(
      node(
        "p",
        "notice",
        "Your workout is empty. Edit your preferences to build a new draft.",
      ),
    );
  updatePlanSummary();
}

function updatePlanSummary() {
  const workout = state.workout;
  const valid =
    workout.exercises.length > 0 &&
    [...$("exercise-list").querySelectorAll("input")].every(
      (input) => input.validity.valid,
    );
  const sets = workout.exercises.reduce(
    (sum, exercise) => sum + (exercise.sets || 0),
    0,
  );
  const seconds =
    120 +
    workout.exercises.reduce(
      (sum, exercise) =>
        sum +
        exercise.sets * exercise.reps * 4 +
        (exercise.sets - 1) * exercise.rest_seconds,
      0,
    );
  $("plan-minutes").textContent = workout.available_minutes;
  $("plan-exercise-count").textContent = workout.exercises.length;
  $("plan-set-count").textContent = valid ? sets : "—";
  $("plan-estimate").textContent = valid
    ? `${Math.ceil(seconds / 60)} min`
    : "—";
  $("plan-goal").textContent = goals[workout.goal];
  $("confirm-workout").disabled =
    !valid || seconds > workout.available_minutes * 60;
  notice(
    "plan-error",
    valid && seconds > workout.available_minutes * 60
      ? "This exceeds your available time. Reduce the sets or reps, or edit your preferences."
      : "",
  );
}
$("edit-preferences").addEventListener("click", () => showView("onboarding"));
$("back-to-plan").addEventListener("click", () => {
  renderWorkout();
  showView("plan");
});
$("ready-edit").addEventListener("click", () => {
  renderWorkout();
  showView("plan");
});
$("confirm-workout").addEventListener("click", (event) => {
  for (const input of $("exercise-list").querySelectorAll("input"))
    if (!input.reportValidity()) return;
  action(
    event.currentTarget,
    "plan-error",
    async () => {
      const result = await api("/api/workout/confirm", {
        workout: state.workout,
      });
      if (state.view !== "plan" || !state.user) return;
      state.workout = result.workout;
      showView("calibration");
    },
    $("view-plan"),
  );
});

function updateCalibration(update) {
  if (state.view !== "calibration") return;
  state.calibration = { ...update, receivedAt: performance.now() };
  const active = ["loading", "unavailable", "stabilizing", "ready"].includes(
    update.status,
  );
  const badge = $("calibration-badge");
  badge.textContent = update.ready
    ? "Ready"
    : update.status === "loading"
      ? "Preparing camera…"
      : update.status === "stopped"
        ? "Camera is off"
        : "Assessment Unavailable";
  badge.classList.toggle("ready", Boolean(update.ready));
  if ($("calibration-status").textContent !== update.message)
    $("calibration-status").textContent = update.message;
  $("calibration-placeholder").hidden = Boolean(
    $("calibration-video").srcObject,
  );
  $("start-calibration").hidden = active;
  $("stop-calibration").hidden = !active;
  $("finish-calibration").disabled = !update.ready;
  for (const [name, visible] of Object.entries(update.checks || {})) {
    const row = document.querySelector(`[data-check="${name}"]`);
    row.dataset.visible = Boolean(visible);
    row.querySelector(".check-state").textContent = visible
      ? "Visible ✓"
      : active
        ? "Adjust view"
        : "Waiting";
  }
  const progress = Math.min(
    100,
    Math.round(
      (100 * (update.stableMs || 0)) / (update.requiredStableMs || 1200),
    ),
  );
  $("stability-fill").style.width = `${progress}%`;
  document
    .querySelector(".stability-track")
    .setAttribute("aria-valuenow", String(progress));
}
const calibration = new CameraCalibration(
  $("calibration-video"),
  $("calibration-overlay"),
  { onUpdate: updateCalibration },
);
$("start-calibration").addEventListener("click", () =>
  calibration.start({ exerciseId: state.workout.exercises[0].id }),
);
$("stop-calibration").addEventListener("click", () => calibration.stop());
$("finish-calibration").addEventListener("click", () => {
  if (
    !state.calibration?.ready ||
    performance.now() - calibration.lastFrameAt > MAX_FRAME_AGE_MS ||
    document.hidden
  ) {
    calibration.invalidate(
      "Assessment Unavailable. Hold your position while we check a fresh camera frame.",
    );
    return;
  }
  $("ready-workout").textContent =
    `${state.workout.exercises.length} exercise${state.workout.exercises.length === 1 ? "" : "s"} planned`;
  showView("ready");
});
const liveWorkout = new LiveWorkout({
  requestCoach: (payload, signal) =>
    api("/api/coach", payload, { signal, coach: true }),
  onExit: () => {
    renderWorkout();
    showView("plan");
  },
});
$("ready-start").addEventListener("click", () => {
  showView("workout");
  liveWorkout.open(state.workout);
});
window.addEventListener("pagehide", () => {
  liveWorkout.dispose();
  scanner.stop();
  calibration.stop();
  audioContext?.close().catch(() => {});
});

bootPromise = (async () => {
  try {
    const result = await api("/api/session");
    state.csrf = result.csrf_token;
    $("email-address").value = result.demo_email || "terry.lee@example.com";
    $("email-address").defaultValue = $("email-address").value;
    setUser(result.user);
    if (result.user) restorePreferences(result.preferences);
    if (result.user && result.workout) {
      state.workout = result.workout;
      renderWorkout();
      showView("plan", { focus: false });
    } else showView(result.user ? "onboarding" : "signin", { focus: false });
  } catch (error) {
    notice("global-error", error.message);
  }
})();
