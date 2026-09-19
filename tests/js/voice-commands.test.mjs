import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVoiceCommand,
  VoiceCommands,
} from "../../app/static/js/voice-commands.js";

test("natural English workout commands map to the supported actions", () => {
  const cases = {
    Pause: "pause",
    "Hey Spotter, please pause my workout.": "pause",
    "Could you pause the set please?": "pause",
    "Resume workout": "resume",
    "Continue the set": "resume",
    "More rest": "more_rest",
    "I need a little more rest": "more_rest",
    "That felt too easy": "easy",
    "Felt easy": "easy",
    "I'm tired": "fatigue",
    "That felt hard": "fatigue",
    "I lost my balance": "balance",
    "I feel off-balance": "balance",
    "Repeat that": "repeat",
    "Say that again please": "repeat",
    "Call for help": "help",
    "Please get me help now": "help",
    "My knee hurts": "pain",
  };
  for (const [text, type] of Object.entries(cases))
    assert.deepEqual(parseVoiceCommand(text), { type, text }, text);
});

test("help and pain take priority over ordinary commands", () => {
  assert.equal(parseVoiceCommand("Pause. Call for help.").type, "help");
  assert.equal(parseVoiceCommand("My knee hurts, call for help.").type, "help");
  assert.equal(parseVoiceCommand("Resume, but I feel pain.").type, "pain");
  assert.equal(
    parseVoiceCommand("That felt easy, but I am not sure if this is pain.")
      .type,
    "pain",
  );
});

test("negated feedback and command mentions do not execute", () => {
  for (const text of [
    "Don't pause",
    "Do not resume",
    "I don't need more rest",
    "Not easy",
    "That did not feel easy",
    "I'm not tired",
    "I haven't lost my balance",
    "Don't call for help",
    "I do not need help",
    "I said the word pause",
    "Can you explain what pause means?",
    "Call for help is an example command",
    "That was an easygoing conversation",
    "I am pain-free",
    "No pain or aches",
    "",
    "   ",
    "More restaurant choices",
    "Don't pause and resume",
  ])
    assert.equal(parseVoiceCommand(text), null, text);
  assert.equal(parseVoiceCommand("No pain. Pause.").type, "pause");
  assert.equal(parseVoiceCommand(null), null);
  assert.equal(parseVoiceCommand({ text: "pause" }), null);
  assert.equal(parseVoiceCommand("pause".repeat(101)), null);
});

function fixture(options = {}) {
  const instances = [];
  const commands = [];
  const statuses = [];
  const pending = new Map();
  let timerId = 0;
  let allowed = true;
  class Recognition {
    constructor() {
      this.starts = 0;
      this.aborts = 0;
      instances.push(this);
    }
    start() {
      this.starts += 1;
    }
    abort() {
      this.aborts += 1;
      this.onend?.();
    }
  }
  const controller = new VoiceCommands({
    Recognition,
    onCommand: (command) => commands.push(command),
    onStatus: (status) => statuses.push(status),
    canListen: () => allowed,
    timers: {
      setTimeout(callback, delay) {
        const id = ++timerId;
        pending.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    ...options,
  });
  return {
    controller,
    instances,
    commands,
    statuses,
    pending,
    get current() {
      return instances.at(-1);
    },
    allow(value) {
      allowed = value;
    },
    flush() {
      const item = pending.entries().next().value;
      if (!item) return;
      pending.delete(item[0]);
      item[1].callback();
    },
    result(text, { final = true, index = 0, resultIndex = index } = {}) {
      const results = [];
      results[index] = Object.assign([{ transcript: text }], {
        isFinal: final,
      });
      this.current.onresult?.({ results, resultIndex });
    },
    started() {
      this.current.onstart?.();
    },
    ended() {
      this.current.onend?.();
    },
  };
}

test("constructing the controller never captures audio; start is explicit opt-in", () => {
  const f = fixture();
  assert.equal(f.instances.length, 0);
  assert.equal(f.controller.supported, true);
  assert.equal(f.controller.enabled, false);
  assert.equal(f.controller.listening, false);
  assert.equal(f.controller.resume(), false);
  assert.equal(f.controller.start(), true);
  assert.equal(f.current.continuous, true);
  assert.equal(f.current.interimResults, false);
  assert.equal(f.current.maxAlternatives, 1);
  assert.equal(f.current.lang, "en-CA");
  assert.equal(f.controller.enabled, true);
  assert.equal(f.controller.listening, false);
  f.started();
  assert.equal(f.controller.listening, true);
  assert.equal(f.statuses.at(-1).state, "listening");
  assert.equal(f.controller.start(), true);
  assert.equal(f.instances.length, 1);
});

test("only final, previously unseen results trigger a command", () => {
  const f = fixture();
  f.controller.start();
  f.started();
  f.result("pause", { final: false });
  assert.equal(f.commands.length, 0);
  f.result("pause");
  f.result("pause");
  f.result("resume", { index: 1 });
  f.result("ordinary conversation", { index: 2 });
  f.result("repeat that", { index: 3 });
  assert.deepEqual(
    f.commands.map((c) => c.type),
    ["pause", "resume", "repeat"],
  );
  assert.equal(
    f.statuses.some((s) => s.message.includes("ordinary conversation")),
    false,
  );
});

test("malformed result events are ignored without crashing", () => {
  const f = fixture();
  f.controller.start();
  for (const event of [
    null,
    {},
    { results: {} },
    { results: [{ isFinal: true }] },
    { results: [null] },
  ])
    assert.doesNotThrow(() => f.current.onresult(event));
  assert.equal(f.commands.length, 0);
});

test("stopping aborts capture and rejects callbacks captured before cancellation", () => {
  const f = fixture();
  f.controller.start();
  f.started();
  const old = {
    start: f.current.onstart,
    end: f.current.onend,
    result: f.current.onresult,
    error: f.current.onerror,
  };
  f.controller.stop();
  assert.equal(f.current.aborts, 1);
  assert.equal(f.controller.enabled, false);
  assert.equal(f.controller.listening, false);
  old.result({
    results: [
      Object.assign([{ transcript: "call for help" }], { isFinal: true }),
    ],
    resultIndex: 0,
  });
  old.start();
  old.end();
  old.error({ error: "network" });
  assert.equal(f.commands.length, 0);
  assert.equal(f.pending.size, 0);
  assert.equal(f.statuses.at(-1).state, "off");
  assert.equal(f.controller.resume(), false);
});

test("suspending preserves opt-in and aborts stale coach audio before resuming", () => {
  const f = fixture();
  f.controller.start();
  const oldResult = f.current.onresult;
  f.controller.suspend();
  assert.equal(f.controller.enabled, true);
  assert.equal(f.controller.listening, false);
  assert.equal(f.current.aborts, 1);
  oldResult({
    results: [Object.assign([{ transcript: "pause" }], { isFinal: true })],
    resultIndex: 0,
  });
  assert.equal(f.commands.length, 0);
  assert.equal(f.controller.resume(), true);
  assert.equal(f.instances.length, 2);
  f.result("resume");
  assert.equal(f.commands.at(-1).type, "resume");
});

test("eligibility gates permission requests and incoming results", () => {
  const f = fixture();
  f.allow(false);
  assert.equal(f.controller.start(), false);
  assert.equal(f.instances.length, 0);
  assert.equal(f.controller.enabled, true);
  f.allow(true);
  f.controller.resume();
  f.started();
  f.allow(false);
  f.result("call for help");
  assert.equal(f.commands.length, 0);
  assert.equal(f.current.aborts, 1);
  assert.equal(f.controller.listening, false);
});

test("eligibility is checked when capture starts asynchronously", () => {
  const f = fixture();
  f.controller.start();
  f.allow(false);
  f.started();
  assert.equal(f.controller.listening, false);
  assert.equal(f.current.aborts, 1);
});

test("natural ends retry with a delay and stop after three retries without results", () => {
  const f = fixture();
  f.controller.start();
  for (let index = 0; index < 3; index += 1) {
    f.ended();
    assert.equal(f.pending.size, 1);
    assert.equal(f.controller.listening, false);
    assert.equal(f.statuses.at(-1).state, "retrying");
    f.flush();
  }
  assert.equal(f.instances.length, 4);
  f.ended();
  assert.equal(f.pending.size, 0);
  assert.equal(f.controller.enabled, false);
  assert.equal(f.statuses.at(-1).state, "error");
  assert.match(f.statuses.at(-1).message, /buttons/);
  assert.equal(f.controller.start(), true);
  assert.equal(f.instances.length, 5);
});

test("a final result resets the consecutive-silence retry budget", () => {
  const f = fixture();
  f.controller.start();
  for (let index = 0; index < 3; index += 1) {
    f.ended();
    f.flush();
  }
  f.result("pause");
  f.ended();
  assert.equal(f.controller.enabled, true);
  assert.equal(f.pending.size, 1);
});

test("stopping or suspending cancels a pending reconnect, including stale timers", () => {
  for (const method of ["stop", "suspend", "dispose"]) {
    const f = fixture();
    f.controller.start();
    f.ended();
    const callback = [...f.pending.values()][0].callback;
    f.controller[method]();
    assert.equal(f.pending.size, 0);
    callback();
    assert.equal(f.instances.length, 1, method);
  }
});

test("no-speech followed by end schedules only one reconnect", () => {
  const f = fixture();
  f.controller.start();
  f.current.onerror({ error: "no-speech" });
  assert.equal(f.pending.size, 0);
  const end = f.current.onend;
  end();
  end();
  assert.equal(f.pending.size, 1);
  f.flush();
  assert.equal(f.instances.length, 2);
});

for (const error of [
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "network",
  "language-not-supported",
  "aborted",
]) {
  test(`${error} disables automatic retries and presents a button fallback`, () => {
    const f = fixture();
    f.controller.start();
    const ended = f.current.onend;
    f.current.onerror({ error });
    ended();
    assert.equal(f.controller.enabled, false);
    assert.equal(f.pending.size, 0);
    assert.equal(f.current.aborts, 1);
    assert.equal(f.statuses.at(-1).state, "error");
    assert.match(f.statuses.at(-1).message, /buttons/);
  });
}

test("a command can stop capture synchronously without processing later results", () => {
  let controller;
  const delivered = [];
  const f = fixture({
    onCommand(command) {
      delivered.push(command);
      controller.stop();
    },
  });
  controller = f.controller;
  controller.start();
  f.current.onresult({
    resultIndex: 0,
    results: ["pause", "resume"].map((transcript) =>
      Object.assign([{ transcript }], { isFinal: true }),
    ),
  });
  assert.deepEqual(
    delivered.map((c) => c.type),
    ["pause"],
  );
});

test("unsupported browsers and disposed controllers never request microphone access", () => {
  const unsupported = fixture({ Recognition: null });
  assert.equal(unsupported.controller.supported, false);
  assert.equal(unsupported.controller.start(), false);
  assert.equal(unsupported.statuses.at(-1).state, "unsupported");
  const f = fixture();
  f.controller.start();
  f.controller.dispose();
  assert.equal(f.controller.start(), false);
  assert.equal(f.controller.resume(), false);
  assert.equal(f.current.aborts, 1);
});

test("browser and UI exceptions stay contained", () => {
  const noConstructor = fixture({
    Recognition: class {
      constructor() {
        throw new Error("No implementation");
      }
    },
  });
  assert.equal(noConstructor.controller.start(), false);
  assert.equal(noConstructor.controller.enabled, false);
  const f = fixture({
    onStatus() {
      throw new Error("No UI");
    },
    onCommand() {
      throw new Error("No UI");
    },
  });
  assert.doesNotThrow(() => {
    f.controller.start();
    f.result("pause");
    f.current.abort = () => {
      throw new Error("Ended");
    };
    f.controller.stop();
  });
  const gated = fixture({
    canListen() {
      throw new Error("Unavailable");
    },
  });
  assert.equal(gated.controller.start(), false);
  assert.equal(gated.instances.length, 0);
});

test("a synchronous browser permission failure leaves capture off", () => {
  const f = fixture({
    Recognition: class {
      start() {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      }
      abort() {}
    },
  });
  assert.equal(f.controller.start(), false);
  assert.equal(f.controller.enabled, false);
  assert.equal(f.controller.listening, false);
  assert.match(f.statuses.at(-1).message, /permission was denied/);
});
