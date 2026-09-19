import { reportsPain, proposeNextSet } from "./adaptation.js";

const $ = (id) => document.getElementById(id);
const text = (id, value) => {
  $(id).textContent = value;
};
const words = (value) => value.trim().split(/\s+/).length;

export function validCoachFeedback(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === "encouragement,headline,tips" &&
      typeof value.headline === "string" &&
      value.headline.trim() &&
      words(value.headline) < 25 &&
      Array.isArray(value.tips) &&
      value.tips.length === 2 &&
      value.tips.every((tip) => typeof tip === "string" && tip.trim()) &&
      typeof value.encouragement === "string" &&
      value.encouragement.trim() &&
      words(value.encouragement) < 15 &&
      words([value.headline, ...value.tips, value.encouragement].join(" ")) <
        60,
  );
}

function localGuidance(summary, proposal) {
  const count = summary.completed_reps;
  const guidance = {
    increase: [
      "You reported an easy set.",
      "Keep the same controlled pace if you accept more reps.",
    ],
    rest: [
      "You reported fatigue.",
      "Take the proposed extra rest before another set.",
    ],
    reduce: [
      "A gentler next set is proposed.",
      "Use a comfortable range and a steady pace.",
    ],
    keep: [
      "Review how the movement felt.",
      "Keep a steady pace within a comfortable range.",
    ],
  }[proposal.kind] || [
    "Pause and review how you feel.",
    "End the exercise if it feels uncomfortable.",
  ];
  return {
    headline: `${count} completed reps recorded. ${guidance[0]}`,
    tips: [guidance[1], "Keep all required joints visible to the camera."],
    encouragement: "Thank you for checking in with yourself.",
  };
}

/** Post-set review with explicit upload, cancel-safe async ownership, and local proposals. */
export class CoachReview {
  constructor({ requestCoach, voice, onPain, onDecision }) {
    this.requestCoach = requestCoach;
    this.voice = voice;
    this.onPain = onPain;
    this.onDecision = onDecision;
    this.epoch = 0;
    this.context = null;
    this.pending = false;
    $("coach-feedback").addEventListener("input", () => this.feedbackChanged());
    $("coach-feedback").addEventListener("change", () =>
      this.feedbackChanged({ committed: true }),
    );
    for (const [id, value] of [
      ["feedback-easy", "Felt easy"],
      ["feedback-fatigue", "I felt fatigued"],
      ["feedback-balance", "I felt off-balance"],
      ["feedback-pain", "I felt pain"],
    ])
      $(id).addEventListener("click", () => {
        $("coach-feedback").value = value;
        this.feedbackChanged({ committed: true });
      });
    $("coach-submit").addEventListener("click", () => this.submit());
    $("coach-cancel").addEventListener("click", () => {
      this.cancel();
      text(
        "coach-status",
        "Review cancelled. You can keep your planned set or try again.",
      );
    });
    $("adapt-accept").addEventListener("click", () => this.decide(true));
    $("adapt-keep").addEventListener("click", () => this.decide(false));
  }

  open(context) {
    this.reset();
    this.context = structuredClone(context);
    $("coach-panel").hidden = false;
    text(
      "coach-status",
      context.image
        ? "Tell us how it felt, then choose whether to send this set for review."
        : "No completed-rep image is available. Your feedback can still guide a local next-set proposal.",
    );
    this.render();
  }

  cancel() {
    this.epoch += 1;
    this.controller?.abort();
    this.controller = null;
    this.pending = false;
    this.render();
  }

  reset() {
    this.cancel();
    this.voice.stop();
    this.context = null;
    this.lastFeedback = null;
    this.proposal = null;
    this.stopped = false;
    $("coach-feedback").value = "";
    $("coach-panel").hidden = true;
    $("coach-result").hidden = true;
    $("adapt-panel").hidden = true;
    for (const id of [
      "coach-headline",
      "coach-tip-one",
      "coach-tip-two",
      "coach-encouragement",
      "coach-source",
      "coach-status",
      "adapt-reason",
      "adapt-values",
      "adapt-status",
    ])
      text(id, "");
  }

  feedbackChanged({ committed = false } = {}) {
    if (!this.context || this.stopped) return;
    const feedback = $("coach-feedback").value.trim();
    this.lastFeedback = null;
    this.cancel();
    this.voice.stop();
    $("coach-result").hidden = true;
    this.onDecision(null);
    if (reportsPain(feedback)) {
      if (committed) {
        this.onPain();
        return;
      }
      this.proposal = null;
      this.renderProposal();
      text(
        "coach-status",
        "Finish your feedback or use the pain button to stop this exercise.",
      );
      this.render();
      return;
    }
    this.proposal = feedback
      ? proposeNextSet({
          summary: this.context.summary,
          userFeedback: feedback,
          exercise: this.context.exercise,
        })
      : null;
    this.renderProposal();
    text(
      "coach-status",
      feedback
        ? "Feedback updated. Review this set when you’re ready."
        : "Tell us how the set felt.",
    );
    this.render();
  }

  markPain() {
    this.lastFeedback = null;
    if (!this.context) return;
    this.cancel();
    this.stopped = true;
    this.proposal = null;
    this.voice.stop();
    $("coach-feedback").value = "I felt pain";
    $("coach-result").hidden = true;
    $("adapt-panel").hidden = true;
    text(
      "coach-status",
      "Exercise stopped after your pain report. Remaining sets of this movement are skipped. No AI review is needed.",
    );
    this.render();
  }

  render() {
    const unavailable = !this.context || this.stopped;
    $("coach-submit").disabled =
      unavailable || this.pending || !$("coach-feedback").value.trim();
    text(
      "coach-submit",
      this.context?.image ? "Review set with Gemini" : "Review locally",
    );
    $("coach-submit").setAttribute("aria-busy", String(this.pending));
    $("coach-cancel").hidden = !this.pending;
    $("coach-feedback").disabled = unavailable;
    for (const id of [
      "feedback-easy",
      "feedback-fatigue",
      "feedback-balance",
      "feedback-pain",
    ])
      $(id).disabled = unavailable;
  }

  renderProposal() {
    const available =
      this.context?.hasNextSet && this.proposal && !this.stopped;
    $("adapt-panel").hidden = !available;
    if (!available) return;
    const current = this.context.exercise;
    text(
      "adapt-values",
      `${current.reps} → ${this.proposal.reps} reps · ${current.rest_seconds} → ${this.proposal.rest_seconds} seconds rest`,
    );
    text("adapt-reason", this.proposal.reason);
    text(
      "adapt-status",
      "Your current plan stays in place until you accept a change.",
    );
    $("adapt-accept").disabled = false;
    $("adapt-keep").disabled = false;
  }

  decide(accept) {
    if (!this.context?.hasNextSet || !this.proposal || this.stopped) return;
    if (reportsPain($("coach-feedback").value)) {
      this.onPain();
      return;
    }
    this.onDecision(accept ? structuredClone(this.proposal) : null);
    text(
      "adapt-status",
      accept
        ? "Accepted for the next set. Its rest timer is updated."
        : "Keeping your current plan for the next set.",
    );
    $("adapt-accept").disabled = accept;
    $("adapt-keep").disabled = !accept;
  }

  showFeedback(feedback, source, reason = "") {
    this.lastFeedback = { ...structuredClone(feedback), source };
    text("coach-headline", feedback.headline);
    text("coach-tip-one", feedback.tips[0]);
    text("coach-tip-two", feedback.tips[1]);
    text("coach-encouragement", feedback.encouragement);
    text(
      "coach-source",
      source === "gemini"
        ? "GEMINI · MULTIMODAL REVIEW"
        : reason === "no_image"
          ? "LOCAL GUIDANCE · NO KEYFRAME"
          : "LOCAL GUIDANCE · GEMINI UNAVAILABLE",
    );
    $("coach-result").hidden = false;
    text(
      "coach-status",
      source === "gemini"
        ? "Review ready. Camera measurements are estimates; your reported experience adds context."
        : reason === "no_image"
          ? "No completed-rep image is available, so nothing was sent to Gemini. Showing local guidance."
          : reason === "missing_api_key"
            ? "Gemini is not configured on this server. Showing local guidance based on your measurements and feedback."
            : "Gemini analysis was unavailable. Showing local guidance based on your measurements and feedback.",
    );
    if (!document.hidden) this.voice.headline(feedback.headline);
  }

  async submit() {
    if (!this.context || this.stopped || this.pending) return;
    const userFeedback = $("coach-feedback").value.trim();
    if (!userFeedback) return;
    if (reportsPain(userFeedback)) {
      this.onPain();
      return;
    }
    this.cancel();
    const epoch = this.epoch;
    this.controller = new AbortController();
    this.pending = true;
    this.proposal = proposeNextSet({
      summary: this.context.summary,
      userFeedback,
      exercise: this.context.exercise,
    });
    this.renderProposal();
    this.render();
    const proposal = this.proposal;
    const summary = this.context.summary;
    text(
      "coach-status",
      this.context.image
        ? "Reviewing your keyframe, measurements, and feedback…"
        : "Preparing local guidance…",
    );
    $("coach-result").hidden = true;
    try {
      if (!this.context.image || !this.requestCoach) {
        this.showFeedback(
          localGuidance(summary, proposal),
          "fallback",
          !this.context.image ? "no_image" : "unavailable",
        );
        return;
      }
      const result = await this.requestCoach(
        {
          set_summary: summary,
          user_feedback: userFeedback,
          keyframe_image: this.context.image,
        },
        this.controller.signal,
      );
      if (epoch !== this.epoch || !this.context || this.stopped) return;
      if (result.source === "safety") {
        this.onPain();
        return;
      }
      if (
        !["gemini", "fallback"].includes(result.source) ||
        !validCoachFeedback(result.feedback)
      )
        throw new Error("Invalid coaching response");
      this.showFeedback(result.feedback, result.source, result.reason);
    } catch {
      if (epoch !== this.epoch || !this.context || this.stopped) return;
      this.showFeedback(localGuidance(summary, proposal), "fallback");
    } finally {
      if (epoch === this.epoch) {
        this.pending = false;
        this.controller = null;
        this.render();
      }
    }
  }
}
