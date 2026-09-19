// Developer-only, visible synthetic input. No webcam, auth bypass, or production route.
import { LiveWorkout } from "/static/js/live-workout.js";
const $ = (id) => document.getElementById(id);
document.querySelectorAll(".view").forEach((view) => {
  view.hidden = view.id !== "view-workout";
});
const banner = document.createElement("div");
banner.className = "notice";
banner.style.margin = "20px";
const status = document.createElement("p");
status.id = "fixture-status";
status.textContent =
  "DEVELOPER FIXTURE · Synthetic poses, not webcam evidence. Choose a movement test.";
banner.append(status);
document.body.prepend(banner);
const workout = new LiveWorkout({
  onExit: () => {
    workout.dispose();
    status.textContent = "Fixture cleared. Choose a movement test.";
  },
});
workout.voice.setEnabled(false);
workout.renderVoice();
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 480;
const context = canvas.getContext("2d");
let timer;
const stop = workout.camera.stop.bind(workout.camera);
workout.camera.stop = () => {
  clearInterval(timer);
  stop();
};
workout.camera.start = async () => {
  workout.camera.stop();
  const stream = canvas.captureStream(15);
  workout.camera.camera.stream = stream;
  $("workout-video").srcObject = stream;
  await $("workout-video").play();
  workout.camera.lastFrameAt = performance.now();
  workout.onCamera({
    ready: true,
    status: "ready",
    message: "SYNTHETIC TEST · Ready",
  });
};
const landmarks = Array.from({ length: 33 }, () => ({
  x: 0.5,
  y: 0.5,
  visibility: 0.95,
  presence: 0.95,
}));
function pose(id, angle) {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const triples =
    id === "squat"
      ? [
          [23, 25, 27],
          [24, 26, 28],
        ]
      : [
          [11, 13, 15],
          [12, 14, 16],
        ];
  const radians = (angle * Math.PI) / 180;
  triples.forEach(([a, b, c], side) => {
    points[a] = { x: side, y: 1, z: 0 };
    points[b] = { x: side, y: 0, z: 0 };
    points[c] = { x: side, y: Math.cos(radians), z: Math.sin(radians) };
  });
  return points;
}
function draw(angle, id) {
  context.fillStyle = "#20261e";
  context.fillRect(0, 0, 640, 480);
  context.fillStyle = "#d9f45c";
  context.font = "22px sans-serif";
  context.fillText("SYNTHETIC TEST FRAME", 30, 45);
  context.fillText(
    `${id} · ${angle}° · rep ${workout.tracker?.reps.length + 1 || 1}`,
    30,
    85,
  );
  context.strokeStyle = "#d9f45c";
  context.lineWidth = 9;
  context.lineCap = "round";
  context.beginPath();
  context.arc(320, 145, 25, 0, Math.PI * 2);
  context.stroke();
  const dy = (175 - angle) * 0.35;
  context.beginPath();
  context.moveTo(320, 175);
  context.lineTo(320, 275 + dy);
  context.moveTo(270, 210);
  context.lineTo(370, 210);
  context.moveTo(320, 275 + dy);
  context.lineTo(255, 325);
  context.lineTo(240, 420);
  context.moveTo(320, 275 + dy);
  context.lineTo(385, 325);
  context.lineTo(400, 420);
  context.stroke();
}
for (const id of ["squat", "bicep_curl"]) {
  const button = document.createElement("button");
  button.textContent = `Run synthetic ${id === "squat" ? "squat" : "curl"} set`;
  button.className = "button secondary";
  banner.append(button);
  button.addEventListener("click", async () => {
    workout.open({
      exercises: [
        {
          id,
          name: id === "squat" ? "Bodyweight squat" : "Dumbbell bicep curl",
          sets: 1,
          reps: 4,
          rest_seconds: 30,
        },
      ],
    });
    draw(175, id);
    await workout.enableCamera();
    workout.begin();
    const angles = [175, 175, 175, 175, 175];
    for (let rep = 1; rep <= 4; rep++) {
      const bottom =
        id === "squat" ? (rep === 3 ? 128 : 90) : rep === 3 ? 95 : 50;
      angles.push(
        165,
        150,
        138,
        135,
        132,
        bottom,
        bottom,
        bottom,
        bottom,
        bottom + 4,
        bottom + 12,
        bottom + 22,
        145,
        165,
        175,
        175,
        175,
        175,
      );
    }
    let index = 0;
    status.textContent = `RUNNING · ${id} synthetic controller/keyframe check`;
    timer = setInterval(() => {
      if (workout.stage !== "active") {
        clearInterval(timer);
        return;
      }
      const angle = angles[index++];
      if (angle === undefined) {
        clearInterval(timer);
        status.textContent = "FAIL · Sequence ended before target reached.";
        return;
      }
      draw(angle, id);
      const now = performance.now();
      workout.camera.lastFrameAt = now;
      workout.onFrame({
        landmarks,
        worldLandmarks: pose(id, angle),
        now,
        capturedAt: now,
        imageSource: canvas,
      });
      if (workout.stage === "finished") {
        const summary = workout.tracker.summary();
        const worst = workout.frames.worst;
        const passed =
          summary.completed_reps === 4 &&
          worst?.rep.rep_number === 3 &&
          worst.image?.startsWith("data:image/jpeg;base64,") &&
          !$("workout-video").srcObject;
        status.textContent = `${passed ? "PASS" : "FAIL"} · ${id}: ${summary.completed_reps}/4 reps; worst rep ${worst?.rep.rep_number}; JPEG ${worst?.image ? "captured" : "missing"}; camera released.`;
      }
    }, 100);
  });
}
workout.open({
  exercises: [
    {
      id: "squat",
      name: "Bodyweight squat",
      sets: 1,
      reps: 4,
      rest_seconds: 30,
    },
  ],
});
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  workout.dispose();
});
