/** Local demo recipients only. No transport or delivery API exists here. */
export const TEST_RECIPIENTS = Object.freeze([
  Object.freeze({
    id: "spotter-test-desk",
    name: "Spotter test desk",
    address: "spotter-test-desk@example.invalid",
  }),
  Object.freeze({
    id: "spotter-test-buddy",
    name: "Demo training partner",
    address: "spotter-test-buddy@example.invalid",
  }),
]);

const ACTIVE = new Set(["connecting", "handoff", "acknowledged"]);
const clone = (value) => structuredClone(value);

function copyBriefing(briefing) {
  if (
    briefing === null ||
    (typeof briefing !== "object" && typeof briefing !== "string") ||
    (typeof briefing === "string" && !briefing.trim())
  )
    throw new TypeError("A local simulation briefing is required.");
  try {
    return clone(briefing);
  } catch {
    throw new TypeError("The local simulation briefing could not be copied.");
  }
}

/** An in-memory animation of a dispatcher handoff, never an actual dispatch. */
export class SosSimulation {
  #incident = null;
  #timer = null;
  #generation = 0;
  #sequence = 0;
  #disposed = false;

  constructor({
    onUpdate = () => {},
    timers = {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
    },
    now = () => Date.now(),
  } = {}) {
    this.onUpdate = onUpdate;
    this.timers = timers;
    this.now = now;
  }

  snapshot() {
    return this.#incident
      ? clone(this.#incident)
      : {
          status: "idle",
          id: null,
          recipient: null,
          briefing: null,
          events: [],
          revision: 0,
        };
  }

  start(options) {
    // Validate the identifier even for duplicate starts. Caller-provided
    // addresses, recipient objects, and transport settings are never accepted.
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => key !== "recipientId" && key !== "briefing",
      )
    )
      throw new TypeError("Choose an allowlisted simulation recipient.");
    const recipient = TEST_RECIPIENTS.find(
      (entry) =>
        typeof options.recipientId === "string" &&
        entry.id === options.recipientId,
    );
    if (!recipient)
      throw new TypeError("Choose an allowlisted simulation recipient.");
    if (this.#disposed) throw new Error("The local simulation is unavailable.");
    if (ACTIVE.has(this.#incident?.status)) return this.snapshot();

    const briefing = copyBriefing(options.briefing);
    this.#clearTimer();
    const generation = ++this.#generation;
    const at = this.now();
    this.#incident = {
      status: "connecting",
      id: `spotter-simulation-${at}-${++this.#sequence}`,
      recipient: clone(recipient),
      briefing,
      events: [
        {
          status: "connecting",
          at,
          message:
            "SIMULATION: connecting to the allowlisted local demo recipient. No call or message is being sent.",
        },
      ],
      revision: 1,
    };
    this.#notify();
    this.#schedule(generation, "connecting", "handoff", 1200);
    return this.snapshot();
  }

  updateBriefing(briefing) {
    if (this.#disposed || !ACTIVE.has(this.#incident?.status))
      return this.snapshot();
    const copy = copyBriefing(briefing);
    this.#incident.briefing = copy;
    this.#incident.revision += 1;
    this.#incident.events.push({
      status: this.#incident.status,
      at: this.now(),
      message: `SIMULATION: local briefing revised (revision ${this.#incident.revision}). Nothing was transmitted.`,
    });
    this.#notify();
    return this.snapshot();
  }

  cancel() {
    if (this.#disposed || !ACTIVE.has(this.#incident?.status))
      return this.snapshot();
    this.#clearTimer();
    this.#generation += 1;
    this.#incident.status = "cancelled";
    this.#incident.events.push({
      status: "cancelled",
      at: this.now(),
      message:
        "SIMULATION: cancelled locally. No real call or message was sent.",
    });
    this.#notify();
    return this.snapshot();
  }

  reset() {
    this.#clearTimer();
    this.#generation += 1;
    this.#incident = null;
    this.#notify();
    return this.snapshot();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.reset();
    this.onUpdate = () => {};
  }

  #clearTimer() {
    if (this.#timer === null) return;
    const timer = this.#timer;
    this.#timer = null;
    try {
      this.timers.clearTimeout(timer);
    } catch {
      // Cancellation/reset still invalidate the generation if a host timer
      // cannot be cleared, so its callback cannot advance an old incident.
    }
  }

  #current(generation, status) {
    return (
      !this.#disposed &&
      this.#generation === generation &&
      this.#incident?.status === status
    );
  }

  #schedule(generation, previous, next, delay) {
    // An update callback may cancel/reset synchronously while rendering.
    if (!this.#current(generation, previous)) return;
    try {
      this.#timer = this.timers.setTimeout(() => {
        if (!this.#current(generation, previous)) return;
        this.#timer = null;
        this.#incident.status = next;
        this.#incident.events.push({
          status: next,
          at: this.now(),
          message:
            next === "handoff"
              ? "SIMULATION: briefing handed to the local mock dispatcher. Nothing was transmitted."
              : "SIMULATION: the local mock dispatcher acknowledged the briefing. Real help has not been contacted.",
        });
        this.#notify();
        if (next === "handoff")
          this.#schedule(generation, "handoff", "acknowledged", 1500);
      }, delay);
    } catch {
      if (!this.#current(generation, previous)) return;
      this.#timer = null;
      this.#generation += 1;
      this.#incident.status = "cancelled";
      this.#incident.events.push({
        status: "cancelled",
        at: this.now(),
        message:
          "SIMULATION: stopped locally because the demo timer was unavailable. No real call or message was sent.",
      });
      this.#notify();
    }
  }

  #notify() {
    try {
      this.onUpdate(this.snapshot());
    } catch {
      // Rendering failures must not strand the simulator or expose the briefing
      // through console logs. Callers can always read the latest snapshot.
    }
  }
}
