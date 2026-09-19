import { SessionReplay } from "./session-replay.js";

const $ = (id) => document.getElementById(id);
const node = (tag, content, className = "") => {
  const element = document.createElement(tag);
  element.textContent = content;
  element.className = className;
  return element;
};

/** Temporary, measured session results. Leaving this view releases all replay images. */
export class SessionSummary {
  constructor() {
    this.replay = new SessionReplay();
  }

  open(history, { helpRequested = false } = {}) {
    const result = history.summary();
    const sets = history.sets;
    $("summary-help").hidden = !helpRequested;
    $("summary-reps").textContent = result.totalReps;
    $("summary-sets").textContent =
      `${result.completedSets} / ${result.totalSets}`;
    $("summary-time").textContent =
      `${Math.floor(result.activeSeconds / 60)}:${String(Math.floor(result.activeSeconds % 60)).padStart(2, "0")}`;
    $("summary-effort").textContent =
      result.averageEffort === null
        ? "Not rated"
        : `${result.averageEffort} / 10`;
    $("summary-exercises").replaceChildren();
    for (const exercise of result.exercises) {
      const card = node("article", "", "summary-exercise surface");
      card.append(
        node("h3", exercise.name),
        node(
          "p",
          `${exercise.reps} measured reps · ${exercise.sets} ${exercise.sets === 1 ? "set" : "sets"} ended · ${exercise.flaggedReps} reps with a flag`,
          "summary-volume",
        ),
        node("p", exercise.formTrend),
        node("p", exercise.focus, "field-hint"),
      );
      $("summary-exercises").append(card);
    }
    $("summary-focus").replaceChildren(
      ...result.futureFocus.map((focus) => node("li", focus)),
    );
    $("summary-set-list").replaceChildren();
    for (const set of sets) {
      const item = node("li", "", "summary-set");
      item.append(
        node("h3", `${set.exercise.name} · Set ${set.setNumber}`),
        node(
          "p",
          `${set.summary.completed_reps} / ${set.summary.target_reps} reps · Effort ${set.effort === null ? "not rated" : `${set.effort}/10`}${set.stoppedForPain ? " · Stopped after pain report" : ""}`,
        ),
      );
      item.append(
        node(
          "p",
          set.feedback
            ? `You reported: ${set.feedback}`
            : "No feedback recorded.",
          "field-hint",
        ),
      );
      if (set.coaching?.headline)
        item.append(
          node(
            "p",
            `${set.coaching.source === "gemini" ? "Gemini review" : "Local guidance"}: ${set.coaching.headline}`,
          ),
        );
      if (set.adaptation)
        item.append(
          node(
            "p",
            `Accepted next set: ${set.adaptation.reps} reps · ${set.adaptation.rest_seconds}s rest`,
            "field-hint",
          ),
        );
      $("summary-set-list").append(item);
    }
    this.replay.open(sets);
    $(helpRequested ? "summary-help" : "summary-title").focus();
  }

  clear() {
    this.replay.clear();
    for (const id of ["summary-exercises", "summary-focus", "summary-set-list"])
      $(id).replaceChildren();
    for (const id of [
      "summary-reps",
      "summary-sets",
      "summary-time",
      "summary-effort",
    ])
      $(id).textContent = "—";
    $("summary-help").hidden = true;
    $("session-summary").hidden = true;
  }
}
