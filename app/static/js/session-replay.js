const FAULT_LABELS = {
  shallow_depth: "Shallow depth",
  limited_curl_range: "Limited curl range",
  uneven_range: "Uneven range",
  fast_cadence: "Fast cadence",
  valgus_knee_collapse: "Knee drift",
};

function displayNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits)).toString()
    : null;
}

function completedFrames(sets) {
  return (Array.isArray(sets) ? sets : []).flatMap((set) => {
    const keyframes = Array.isArray(set.keyframes) ? set.keyframes : [];
    const reps = Array.isArray(set.summary?.reps) ? set.summary.reps : [];
    const worstRep = reps.reduce(
      (worst, rep) => (!worst || rep.score > worst.score ? rep : worst),
      null,
    );
    const highlights = keyframes.length
      ? keyframes
      : worstRep
        ? [{ rep: worstRep, image: null }]
        : [];
    return highlights
      .filter((frame) => frame?.rep)
      .map((frame) => {
        const rep = frame.rep;
        return {
          setId: set.id,
          exerciseId: set.exercise?.id,
          exerciseName: set.exercise?.name || "Exercise",
          setNumber: set.setNumber,
          rep: { ...rep, faults: [...(rep.faults || [])] },
          image:
            typeof frame?.image === "string" &&
            frame.image.startsWith("data:image/jpeg;base64,")
              ? frame.image
              : null,
        };
      });
  });
}

/** In-memory slideshow of completed-rep inflection stills, never a video player. */
export class SessionReplay {
  constructor({ root = document, onSelect, intervalMs = 1600 } = {}) {
    this.root = root;
    this.document = root.ownerDocument || root;
    this.onSelect = onSelect;
    this.intervalMs =
      Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1600;
    this.entries = [];
    this.index = 0;
    this.playing = false;
    this.timer = null;
    this.disposed = false;
    this.elements = Object.fromEntries(
      [
        "image",
        "empty",
        "caption",
        "detail",
        "position",
        "prev",
        "next",
        "play",
        "slider",
      ].map((name) => [
        name,
        root.getElementById?.(`replay-${name}`) ||
          root.querySelector?.(`#replay-${name}`),
      ]),
    );
    this.handlers = {
      prev: () => this.previous(),
      next: () => this.next(),
      play: () => (this.playing ? this.pause() : this.play()),
      slider: () => this.select(Number(this.elements.slider.value)),
    };
    for (const [name, handler] of Object.entries(this.handlers)) {
      this.elements[name]?.addEventListener(
        name === "slider" ? "input" : "click",
        handler,
      );
    }
    this.onVisibility = () => {
      if (this.document.hidden) this.pause();
    };
    this.document.addEventListener?.("visibilitychange", this.onVisibility);
    this.render();
  }

  open(sets) {
    if (this.disposed) return;
    this.clear();
    this.entries = completedFrames(sets);
    this.render();
    this.notifySelection();
  }

  select(index) {
    if (this.disposed || !this.entries.length || !Number.isFinite(index))
      return;
    this.pause();
    this.index = Math.max(
      0,
      Math.min(this.entries.length - 1, Math.floor(index)),
    );
    this.render();
    this.notifySelection();
  }

  previous() {
    this.select(this.index - 1);
  }

  next() {
    this.select(this.index + 1);
  }

  play() {
    if (
      this.disposed ||
      this.playing ||
      this.document.hidden ||
      this.entries.length < 2
    )
      return;
    if (this.index === this.entries.length - 1) this.index = 0;
    this.playing = true;
    this.render();
    this.notifySelection();
    this.timer = setInterval(() => {
      if (!this.playing) return;
      if (this.document.hidden) {
        this.pause();
        return;
      }
      this.index += 1;
      if (this.index >= this.entries.length - 1) this.pause();
      this.render();
      this.notifySelection();
    }, this.intervalMs);
  }

  pause() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.renderControls();
  }

  clear() {
    this.pause();
    this.entries = [];
    this.index = 0;
    this.render();
  }

  dispose() {
    this.clear();
    for (const [name, handler] of Object.entries(this.handlers)) {
      this.elements[name]?.removeEventListener(
        name === "slider" ? "input" : "click",
        handler,
      );
    }
    this.document.removeEventListener?.("visibilitychange", this.onVisibility);
    this.onSelect = null;
    this.disposed = true;
  }

  notifySelection() {
    if (this.entries.length)
      this.onSelect?.(this.entries[this.index], this.index);
  }

  renderControls() {
    const { prev, next, play, slider } = this.elements;
    const count = this.entries.length;
    if (prev) prev.disabled = !count || this.index === 0;
    if (next) next.disabled = !count || this.index >= count - 1;
    if (play) {
      play.disabled = count < 2;
      play.textContent = this.playing ? "Pause keyframes" : "Play keyframes";
      play.setAttribute("aria-pressed", String(this.playing));
    }
    if (slider) {
      slider.disabled = count < 2;
      slider.min = "0";
      slider.max = String(Math.max(0, count - 1));
      slider.step = "1";
      slider.value = String(this.index);
      slider.setAttribute(
        "aria-valuetext",
        count
          ? `Keyframe highlight ${this.index + 1} of ${count}`
          : "No keyframes",
      );
    }
  }

  render() {
    const { image, empty, caption, detail, position } = this.elements;
    const entry = this.entries[this.index];
    if (image) {
      image.hidden = !entry?.image;
      if (entry?.image) {
        image.src = entry.image;
        image.alt = `${entry.exerciseName}, set ${entry.setNumber}, rep ${entry.rep.rep_number}, worst-rep ${entry.exerciseId === "bicep_curl" ? "curl inflection" : "bottom"} keyframe`;
      } else {
        image.removeAttribute("src");
        image.alt = "";
      }
    }
    if (empty) {
      empty.hidden = Boolean(entry?.image);
      empty.textContent = entry
        ? "No keyframe retained for this completed rep."
        : "No completed reps to replay yet.";
    }
    if (position)
      position.textContent = entry
        ? `${this.index + 1} of ${this.entries.length} highlights`
        : "0 highlights";
    if (caption)
      caption.textContent = entry
        ? `${entry.exerciseName} · Set ${entry.setNumber} · Rep ${entry.rep.rep_number} · Worst-rep ${entry.exerciseId === "bicep_curl" ? "curl inflection" : "bottom"} keyframe`
        : "Worst-rep keyframe replay";
    if (detail)
      detail.textContent = entry
        ? this.describe(entry.rep, entry.exerciseId)
        : "";
    this.renderControls();
  }

  describe(rep, exerciseId) {
    const parts = [];
    if (
      Number.isFinite(rep.bottom_at_ms) &&
      Number.isFinite(rep.started_at_ms) &&
      rep.bottom_at_ms >= rep.started_at_ms
    ) {
      parts.push(
        `${exerciseId === "bicep_curl" ? "Inflection" : "Bottom"} ${displayNumber((rep.bottom_at_ms - rep.started_at_ms) / 1000)}s after rep start`,
      );
    }
    const angle = displayNumber(rep.peak_angle_deg);
    const cadence = displayNumber(rep.cadence_seconds);
    if (angle !== null) parts.push(`Peak angle ${angle}°`);
    if (cadence !== null) parts.push(`Cadence ${cadence}s`);
    parts.push(
      rep.faults.length
        ? `Form flags: ${rep.faults.map((fault) => FAULT_LABELS[fault] || String(fault).replaceAll("_", " ")).join(", ")}`
        : "No measured form flags",
    );
    return parts.join(" · ");
  }
}
