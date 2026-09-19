# Phase 2 — Live movement tracking, keyframes, and spoken cues

## Delivered scope

The existing sign-in, preferences, constrained workout review, and calibration flow now continues into live sets. Both **bodyweight squats** and **bilateral dumbbell bicep curls** use the confirmed plan's sets, reps, and rest. Completing camera setup opens the workout directly and transfers the active stream and pose model. No second Enable camera action or device request is needed. A fresh framing check and an explicit **Start set** precede counting.

The live view shows exercise/set position, completed/target reps, elapsed set time, estimated joint angle, movement phase, assessment status, and a visible coaching cue. Users can pause, recheck and resume, mute spoken cues, end a set early, or leave for the workout plan. Reaching the rep target ends the set automatically. A completed-set panel shows the worst rep's inflection image and inspectable measurements. The next planned set becomes available after the originally confirmed rest duration. Every new set clears the previous set's image and measurements.

This phase adds no server API, image upload, Gemini call, adaptive prescription, speech recognition, session replay, whole-session summary, or emergency dispatch. Those remain outside this implementation's approval boundary.

## Tracking and angle rules

MediaPipe continues to run locally from the pinned Phase 1 assets in VIDEO mode, at most once per 100 ms. Setup checks all 12 body landmarks. Live squats require shoulders, hips, knees, and ankles; live curls require shoulders, elbows, wrists, and hips. Unrelated joints do not interrupt counting when they are obscured. Required joints must remain in frame with visibility/presence of at least 0.7; frames older than 350 ms are rejected. A 1.2-second stable framing gate precedes tracking and recovery after required-joint visibility loss.

Angles are calculated from MediaPipe's three-dimensional world landmarks, using hip–knee–ankle for squats and shoulder–elbow–wrist for curls. Both sides must meet movement thresholds. The HUD shows the larger joint angle, representing the less-flexed side; extension requires the smaller angle to clear the start threshold. Missing, non-finite, or degenerate geometry produces **Assessment Unavailable**. There is no fallback to potentially misleading frontal two-dimensional angles.

| Rule | Squat | Bicep curl |
| --- | --- | --- |
| Initial extension | Stable upright pose, both knees ≥145°; calibrate each knee | Stable lowered-arm pose, both elbows ≥135°; calibrate each elbow |
| Returned extension | Each knee ≥ min(155°, its standing angle −5°) | Each elbow ≥ min(150°, its starting angle −5°) |
| Leave start pose | Each knee ≤ min(148°, its standing angle −15°) | Each elbow ≤ min(140°, its starting angle −15°) |
| Minimum meaningful flexion | Each knee ≤ min(140°, its standing angle −25°) | Each elbow ≤ min(115°, its starting angle −25°) |
| Full-range demo threshold | Both ≤105° | Both ≤65° |
| Movement phases | Start → eccentric → bottom → concentric → completion | Start → concentric → inflection → eccentric → completion |
| Range fault | `shallow_depth` | `limited_curl_range` |

Curls begin with lifting (concentric), so their physical phase order differs from squats. Initial extension must remain stable for 300 ms. Calibration limits each knee's or elbow's variation to 6° during that window, then uses each joint's mean as its starting baseline. This allows camera estimates such as 158° for standing knees or 146° for lowered elbows to arm counting. Camera loss or pause clears that baseline and requires recalibration. Departure requires 120 ms, reversal requires at least a 9° change sustained for 120 ms, and completed extension requires 180 ms. A separate return threshold allows continuous repetitions to finish without pausing at full extension. At the 100 ms sampling cadence these dwell times round up to the next observation. The movement must last at least 700 ms; an unfinished movement exceeding 30 seconds is abandoned. The next rep can start directly after a completed rep, but an interruption requires a new start-pose hold.

A shallow but meaningful full cycle counts and carries a range fault. A tiny excursion, incomplete return, or one-sided curl does not count. Sustained left/right angle differences over 20° for at least 150 ms flag `uneven_range`; cycles below 1.4 seconds flag `fast_cadence`. Range advice appears only after the turn, not prematurely during descent/lifting. No knee-collapse, injury, or clinical claim is inferred from these angles.

Thresholds are **hackathon heuristics**, not validated biomechanics or a medical assessment. Model estimates vary with camera angle, lighting, occlusion, clothing, and equipment. Physical-camera validation is still required before claiming tracking accuracy.

## Visibility and lifecycle behavior

- Missing/low-confidence joints, stale frames, non-increasing timestamps, gaps over 350 ms, or unusable world geometry immediately invalidate the incomplete rep. Completed reps remain unchanged. The candidate keyframe is discarded.
- Reframing requires uninterrupted visibility and a new start pose; returning from an unseen bottom cannot complete the abandoned rep.
- Pause freezes elapsed time, discards the partial rep, cancels speech, and releases camera/model resources. Resume requires a new camera check and explicit **Resume set**. Camera failure/disconnection or hiding the tab automatically pauses.
- Time measures active set wall time, including time spent adjusting framing. Explicit pauses and camera rechecks after a pause are excluded. Per-rep cadence measures departure through confirmed completion; timestamps use the page's monotonic performance clock, not a recording's wall-clock time.
- End-set releases camera/model resources, discards incomplete motion, and freezes measurements. Leaving the workout, successful logout, reload, or page exit clears its in-memory data. Clicking sign-out stops live capture immediately, even if the network logout request is slow or fails.

## Worst-rep capture and measurements

For live tracking, inference receives a temporary frozen canvas frame. The exact same pixels are available synchronously to the keyframe encoder, so video advancement during inference cannot pair another pose with the measurement. The temporary canvas is cleared after the callback and released on camera stop. Phase 1 card scanning uses its separate pipeline and never enters this buffer.

The current rep's candidate JPEG is replaced whenever its deepest observed flexion improves by more than 1°. Capture happens at the observed pose rather than at the later reversal detection. Squat candidates therefore represent the bottom; curl candidates represent the most-flexed inflection. The encoder preserves aspect ratio, bounds the longest edge to 640 pixels, and uses JPEG quality 0.75.

Only a completed rep may replace the retained worst rep. Higher scores are worse:

`score = max(0, peakAngle - fullRangeThreshold) + max(0, sustainedAsymmetry - 20) / 2 + (cadence < 1.4 seconds ? 20 : 0)`

The earliest completed rep wins equal scores, including a set with no faults. A higher-scored rep whose capture fails retains its own metrics and displays **Image unavailable**; an unrelated older image is never substituted. The active buffer keeps the partial candidate and worst completed rep for coaching, plus up to 40 completed-rep replay entries within an 8 MiB JPEG budget. No recording, local storage, file write, image upload, or third-party analysis is performed.

Set measurements contain `exercise_id`, `target_reps`, `completed_reps`, `reps`, and deduplicated `detected_faults`. Every completed rep includes `rep_number`, `started_at_ms`, `bottom_at_ms`, `completed_at_ms`, `peak_angle_deg`, `cadence_seconds`, `faults`, and `score`. The visible panel allows inspecting these existing measurements; it is not a session replay or AI coaching response.

## Spoken and visible cues

Native `speechSynthesis` provides brief movement guidance and first-rep, halfway, final-reps, and completion encouragement. The scheduler permits one utterance at a time, enforces at least **3,500 ms between speech starts**, and suppresses repeat form-cue keys for **10 seconds**. It never builds a queue of stale advice. Current faults take priority over encouragement; a suppressed milestone is retried only while it remains current. Completion speech is best effort when the cooldown permits.

Pause, visibility loss, exit, and mute cancel active speech. Cooldowns survive cancellation and set changes. Text status remains available without speech support or after a speech error. There is no microphone request, external TTS SDK, or voice-command listener. Available speech voices and their synthesis implementation depend on the browser/operating system.

## Code map

- `app/static/js/movement.js`: pure angle calculations, state machines, faults, bounded measurements.
- `app/static/js/keyframes.js`: candidate/worst JPEG ownership and cleanup.
- `app/static/js/voice-cues.js`: throttled native speech scheduler.
- `app/static/js/live-workout.js`: camera/controller lifecycle, HUD, planned-set navigation, completed-set preview.
- `app/static/js/calibration.js`: existing camera loop, now with optional frame callbacks and frozen inference frames.
- `app/static/js/main.js`, template, stylesheet: Phase 1 continuation and responsive live-set UI.

## Verification

```sh
npm ci
npm run setup:vision
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pytest -q
npm test
.venv/bin/python -m flask --app run run --port 5055
```

Verified: **69 JavaScript tests passed; 65 Python tests passed and one optional legacy test skipped**. Automated tests cover both exercises' state sequences, real angle geometry, range/cadence/asymmetry faults, jitter, target caps, partial reps, timestamp/visibility loss, frame selection and capture failure, voice cooldown/deduplication/cancellation, and the controller's pause/resume/rest/cleanup behavior. The existing sign-in, session, planning, barcode, and calibration suites remain part of verification.

Developer browser fixtures run separately:

```sh
.venv/bin/python scripts/browser-smoke.py
```

- Open `http://127.0.0.1:5056/test-camera`: the actual local model/WASM performs blank-canvas inference and must leave calibration unavailable.
- Open `http://127.0.0.1:5056/test-workout`: choose each synthetic movement. Expect **PASS**, 4/4 reps, worst rep 3, a captured JPEG, and a released stream. This fixture uses the production controller and an explicit synthetic input source; it does not test pose-estimation accuracy. These fixture routes are absent from the normal application.

Manual acceptance on [the local application](http://127.0.0.1:5055):

1. Check in as demo `leeterry`, choose bodyweight and dumbbells, draft both movements, and set each to 1 set of 4 reps. Confirm and complete real camera calibration.
2. On the live workout page, keep the automatically connected camera in a clear view until **Start set** enables, then start. Use a slight three-quarter view, enough distance, and clear lighting. Stand tall before squats; lower both arms before curls.
3. Complete controlled repetitions. Confirm the physical phase sequence, increasing count, elapsed time, changing joint angle, and brief spoken/text cues. Stand still or make tiny excursions: counts should not increase.
4. Step partly out of frame or cover a required joint mid-rep. Expect **Assessment Unavailable**, no count increment, and no retained partial image. Reframe, return to start, then perform a complete rep.
5. Pause mid-rep; confirm camera turns off and time freezes. Recheck/resume: completed counts remain and the abandoned rep is not recovered. Switch tabs during a set and check the same pause behavior.
6. Try a comfortably smaller range on one rep; verify a range flag and the corresponding inflection image after the target ends the set. Open measurements and match the image's rep number and peak angle. Stop if a movement is uncomfortable.
7. Wait for planned rest, prepare the next exercise, and repeat with both arms curling together. Confirm previous image/measurements clear. End a partial first rep and check the empty result.
8. Mute/unmute and check no overlapping speech or rapid repeated cues. Verify browser permission denial/recovery and camera disconnection. Sign out during a set and verify capture stops immediately.
9. Inspect Network and browser storage: tracking introduces no frame/telemetry requests and no persistent workout image storage. Reloading restores the confirmed plan, not live-set data. Check phone-width layout and keyboard-accessible buttons.

## References

The [official MediaPipe web guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) documents world-coordinate landmarks and synchronous VIDEO inference. [MDN SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) documents the browser speech controller. Numerical exercise rules above are application heuristics, not recommendations supplied by these APIs.
