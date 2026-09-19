# Spotter — Phase 2

Spotter is a local hackathon demo for TCard-style check-in, personalized workout setup, camera calibration, and live **squat and bicep-curl tracking**. Phase 2 adds multi-state rep counting, estimated angles and cadence, worst-rep keyframe capture, and throttled browser speech cues. Gemini coaching, voice commands, replay, and emergency flows remain outside this phase.

See the [Phase 2 specification and acceptance procedure](docs/phase-2.md) for the movement rules, privacy boundaries, and test steps.

## Run locally

Use Python 3.11 or newer, Node.js 20 or newer, and a modern browser with webcam access. Camera access requires localhost or HTTPS.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm run setup:vision
python -m flask --app run run --port 5055
```

On Windows, activate the environment with `.venv\Scripts\activate`. Open [Spotter on localhost](http://127.0.0.1:5055). Alternatively, `python run.py` starts the development server on port 5000.

`setup:vision` builds the pinned barcode decoder and copies the pinned MediaPipe runtime into `app/static/vendor/`. It downloads a fixed Pose Landmarker Lite model and verifies its SHA-256 checksum. Internet access is needed for initial installation; camera processing uses the resulting local assets. Run setup again after removing generated assets. The stylesheet separately uses Google Fonts.

## Try the flow

1. Enable the TCard camera and scan a Code 128 or Code 39 barcode containing `2176123456789100`. A green outline and confirmation tone precede sign-in. For a camera-free walkthrough, expand the demo-access control and enter `leeterry`.
2. Choose a goal, experience level, available time, equipment, and movements to avoid. Draft a routine using bodyweight squats and/or dumbbell bicep curls.
3. Edit sets, reps, or rest; remove a movement if needed. Confirm the routine.
4. Start camera calibration. Keep shoulders, elbows, wrists, hips, knees, and ankles visible. After 1.2 seconds of confident, uninterrupted full-body visibility, confirm camera setup. Missing or stale frames keep confirmation disabled.
5. Choose **Start workout**, enable the live-set camera, and select **Start set** after a fresh framing check. Complete squats or bilateral curls while following the rep/angle/timer HUD and brief spoken cues. Pause, resume, mute, or end the set with visible controls.
6. Review the worst completed rep’s in-memory inflection image and measurements, then continue through the original plan after its scheduled rest. Leaving the workout clears these images and measurements.

The seeded account is **Terry Lee**, UTORid `leeterry`, student ID `1234567890`, demo email `terry.lee@example.com`. The barcode is a public demo account selector: it does **not** verify a person's identity, academic standing, or University affiliation. This is not University SSO.

The email fallback issues a single-use six-digit code valid for **five minutes**, with at most five verification attempts. By default, the server terminal displays the code with a clear demo prefix; this console flow does **not** verify email ownership. To deliver actual email, configure `SPOTTER_DEMO_EMAIL` with a mailbox you control and supply `SMTP_HOST`, `SMTP_FROM`, and any required SMTP credentials. The full [Phase 1 specification](docs/phase-1.md#email-and-session-configuration) covers configuration and verification.

Camera pixels and barcode decoding stay in browser memory. No card photos, workout images, or video are written to disk or uploaded. Live tracking temporarily retains only the current inflection candidate and the worst completed rep’s JPEG in page memory; the next set or leaving the workout clears them. Only a decoded demo identifier reaches the sign-in endpoint. Preferences, including restriction text, are retained only in bounded, process-local session memory so reloading and editing a routine preserves movement exclusions. They are never stored in the cookie or written to disk, and disappear with the session or a server restart.

## Verify

```sh
python -m pytest -q
npm test
```

The Python suite passes **65 tests, with one optional legacy test skipped**. All **69 JavaScript tests pass**, covering both movement state machines, lost/stale frames, candidate/worst-image selection, exact inference-frame capture, speech throttling, and live-controller lifecycle alongside the Phase 1 tests.

Browser verification covers sign-in → two-exercise planning → calibration, plus synthetic live squat/curl sets through the production controller, worst-rep JPEG capture, camera release, and responsive layout. Synthetic tests do not establish physical-camera tracking accuracy. Real exercise tracking, audible output, actual camera permission/disconnection behavior, and SMTP delivery remain manual checks. Follow the [Phase 2 acceptance procedure](docs/phase-2.md#verification).

Run `.venv/bin/python scripts/browser-smoke.py` and visit [the camera dependency fixture](http://127.0.0.1:5056/test-camera) or [the synthetic workout fixture](http://127.0.0.1:5056/test-workout). The workout fixture clearly labels synthetic input and expects 4/4 reps with rep 3 selected as worst. Both routes exist only in the separate loopback test server.

The old Python camera prototype remains in `app/pose`, `app/exercises`, and `app/feedback`; the browser app does not invoke it. Its optional dependencies are in `requirements-legacy.txt` for a separate Python 3.11 environment. The current `/video_feed` endpoint is removed.

See the [Phase 1 baseline API and onboarding specification](docs/phase-1.md) and [Phase 2 live-tracking specification](docs/phase-2.md).
