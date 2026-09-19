import { reportsPain } from "./adaptation.js";

const clean = (text) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const commandPhrase = (phrase) =>
  phrase
    .trim()
    .replace(/^(?:hey |okay |ok )?spotter[,:]?\s+/, "")
    .replace(/^(?:please |(?:can|could|would|will) you (?:please )?)/, "")
    .replace(/(?: please| now)(?: please| now)?$/, "")
    .trim();

const PHRASES = {
  help: /^(?:call (?:for )?help|get (?:me )?help|help(?: me)?|i need help)$/,
  pause:
    /^(?:(?:pause|stop)(?:(?: my| the)? (?:workout|set))?|pause for a moment)$/,
  resume:
    /^(?:(?:resume|continue)(?:(?: my| the)? (?:workout|set))?|keep going|let's continue)$/,
  more_rest:
    /^(?:more rest|(?:give me|i need|i want|can i have)(?: some| a little)? more rest|(?:extend|increase)(?: my| the)? rest(?: time)?)$/,
  balance:
    /^(?:i (?:lost|am losing|have lost) (?:my )?balance|i(?:'m| am| feel| felt)(?: a little| very| really)? (?:off balance|unbalanced|unstable|wobbly)|(?:that|it|this)(?: felt| feels) (?:off balance|unbalanced|unstable)|off balance|lost (?:my )?balance)$/,
  fatigue:
    /^(?:i(?:'m| am| feel| felt)(?: very| really| so)? (?:tired|fatigued|exhausted|out of breath)|(?:(?:that|this|it|the set|that set) (?:felt|feels|was|is)|felt|feels)(?: too| very| really)? (?:hard|difficult)|too hard|tired|fatigued|exhausted)$/,
  easy: /^(?:(?:(?:that|this|it|the set|that set) (?:felt|feels|was|is)|felt|feels)(?: too| very| really)? easy|(?:too )?easy)$/,
  repeat:
    /^(?:repeat(?: that| the last cue| the last headline)?|say that again|what did you say)$/,
};

/** Only explicit command phrases are actionable; ordinary conversation is not. */
export function parseVoiceCommand(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 500) return null;
  const phrases = clean(text)
    .split(/[.!?,;]|\b(?:but|however)\b/)
    .map(commandPhrase)
    .filter(Boolean);
  // Help and reported pain must beat a simultaneous ordinary workout command.
  if (phrases.some((phrase) => PHRASES.help.test(phrase)))
    return { type: "help", text };
  if (reportsPain(text)) return { type: "pain", text };
  for (const type of [
    "pause",
    "resume",
    "more_rest",
    "balance",
    "fatigue",
    "easy",
    "repeat",
  ]) {
    if (phrases.some((phrase) => PHRASES[type].test(phrase)))
      return { type, text };
  }
  return null;
}

const errorMessage = (error) => {
  if (["not-allowed", "service-not-allowed", "NotAllowedError"].includes(error))
    return "Microphone permission was denied. Allow microphone access and turn voice commands on again, or use the buttons.";
  if (["audio-capture", "NotFoundError", "NotReadableError"].includes(error))
    return "The microphone is unavailable. Check your microphone and turn voice commands on again, or use the buttons.";
  if (error === "network")
    return "Speech recognition lost its connection. Turn voice commands on again when connected, or use the buttons.";
  if (error === "language-not-supported")
    return "English speech recognition is unavailable in this browser. Use the visible buttons.";
  return "Speech recognition stopped. Turn voice commands on again, or use the buttons.";
};

/**
 * Browser speech recognition is opt-in and may use the browser vendor's servers.
 * No audio or transcript is stored here. Only final recognized commands leave
 * this controller. The owner suspends capture while the coach speaks or hides.
 */
export class VoiceCommands {
  constructor({
    Recognition = globalThis.SpeechRecognition ||
      globalThis.webkitSpeechRecognition,
    onCommand = () => {},
    onStatus = () => {},
    canListen = () => true,
    timers = {},
  } = {}) {
    this.Recognition = Recognition;
    this.supported = typeof Recognition === "function";
    this.enabled = false;
    this.listening = false;
    this.disposed = false;
    this.onCommand = onCommand;
    this.onStatus = onStatus;
    this.canListen = canListen;
    this.setTimer = timers.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer =
      timers.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.recognition = null;
    this.suspended = false;
    this.generation = 0;
    this.restartCount = 0;
    this.restartTimer = null;
  }

  start() {
    if (this.disposed) return false;
    if (!this.supported) {
      this.#status(
        "unsupported",
        "Voice commands are unavailable in this browser. Use the visible buttons.",
      );
      return false;
    }
    this.enabled = true;
    this.suspended = false;
    this.restartCount = 0;
    return this.#begin();
  }

  stop() {
    this.enabled = false;
    this.suspended = false;
    this.#abort();
    this.#status("off", "Voice commands are off.");
  }

  suspend() {
    this.suspended = true;
    this.#abort();
    if (this.enabled)
      this.#status(
        "suspended",
        "Voice commands are waiting while audio plays or the workout is unavailable.",
      );
  }

  resume() {
    if (!this.enabled || this.disposed) return false;
    this.suspended = false;
    return this.#begin();
  }

  dispose() {
    this.stop();
    this.disposed = true;
  }

  #allowed() {
    try {
      return Boolean(this.canListen());
    } catch {
      return false;
    }
  }

  #status(state, message) {
    try {
      this.onStatus({ state, message });
    } catch {
      // A UI error must not strand a live microphone or trigger a restart.
    }
  }

  #abort() {
    this.generation += 1;
    if (this.restartTimer !== null) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
    const recognition = this.recognition;
    this.recognition = null;
    this.listening = false;
    if (!recognition) return;
    recognition.onstart =
      recognition.onend =
      recognition.onerror =
      recognition.onresult =
        null;
    try {
      recognition.abort();
    } catch {
      // An already-ended recognition session needs no further cleanup.
    }
  }

  #fail(message) {
    this.enabled = false;
    this.suspended = false;
    this.#abort();
    this.#status("error", message);
  }

  #begin() {
    if (!this.enabled || this.disposed || this.suspended) return false;
    if (!this.#allowed()) {
      this.#abort();
      this.#status(
        "suspended",
        "Voice commands are waiting while audio plays or the workout is unavailable.",
      );
      return false;
    }
    if (this.recognition) return true;
    if (this.restartTimer !== null) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
    const generation = ++this.generation;
    let recognition;
    try {
      recognition = new this.Recognition();
      this.recognition = recognition;
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.lang = "en-CA";
      const seen = new Set();
      const current = () =>
        this.generation === generation &&
        this.recognition === recognition &&
        this.enabled &&
        !this.disposed;
      recognition.onstart = () => {
        if (!current()) return;
        if (this.suspended || !this.#allowed()) return this.suspend();
        this.listening = true;
        this.#status("listening", "Listening for workout commands.");
      };
      recognition.onresult = (event) => {
        if (!current()) return;
        if (this.suspended || !this.#allowed()) return this.suspend();
        const results = event?.results;
        if (!results || !Number.isInteger(results.length)) return;
        const first = Number.isInteger(event.resultIndex)
          ? Math.max(0, event.resultIndex)
          : 0;
        for (let index = first; index < results.length; index += 1) {
          const result = results[index];
          if (result?.isFinal !== true || seen.has(index)) continue;
          seen.add(index);
          this.restartCount = 0;
          const command = parseVoiceCommand(result[0]?.transcript);
          if (!command) continue;
          try {
            this.onCommand(command);
          } catch {
            // Commands cannot destabilize the browser's capture lifecycle.
          }
          if (!current() || this.suspended) break;
        }
      };
      recognition.onerror = (event) => {
        if (!current()) return;
        // Silence commonly produces no-speech followed by end. Only end may
        // schedule a bounded retry, so these two events cannot double-start.
        if (event?.error === "no-speech") return;
        this.#fail(errorMessage(event?.error));
      };
      recognition.onend = () => {
        if (!current()) return;
        this.recognition = null;
        this.listening = false;
        this.generation += 1;
        if (this.suspended || !this.#allowed()) {
          this.#status(
            "suspended",
            "Voice commands are waiting while audio plays or the workout is unavailable.",
          );
          return;
        }
        this.restartCount += 1;
        if (this.restartCount > 3) {
          this.#fail(
            "The microphone stopped repeatedly. Turn voice commands on again, or use the buttons.",
          );
          return;
        }
        this.#status("retrying", "Reconnecting voice commands…");
        const retryGeneration = this.generation;
        this.restartTimer = this.setTimer(
          () => {
            if (this.generation !== retryGeneration) return;
            this.restartTimer = null;
            this.#begin();
          },
          Math.min(300 * this.restartCount, 900),
        );
      };
      this.#status("starting", "Starting voice commands…");
      recognition.start();
      return current();
    } catch (error) {
      this.#fail(errorMessage(error?.name));
      return false;
    }
  }
}
