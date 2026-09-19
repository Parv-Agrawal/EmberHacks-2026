# Spotter — Phase 3

Spotter is a local hackathon demo for TCard-style check-in, personalized workout setup, live squat/curl tracking, and **multimodal Gemini set reviews**. Phase 3 combines the worst-rep image, measured movement, user feedback, and session preferences; speaks a structured coaching headline; and proposes changes to the next set. Reported pain stops the exercise immediately. Voice commands, session replay, and SOS remain outside this phase.

See the [Phase 3 specification and verification procedure](docs/phase-3.md) for the API, privacy behavior, adaptation rules, and acceptance checks.

## Run locally

Use Python 3.11 or newer, Node.js 20 or newer, and a modern browser with webcam access. Camera access requires localhost or HTTPS.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm run setup:vision
# For Gemini review, set GEMINI_API_KEY in this server environment.
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
6. Review the worst completed rep’s image and measurements. Choose how the set felt and **Review set with Gemini** to send the displayed workout frame for analysis. Without a configured API key, local guidance is clearly labelled.
7. Accept the proposed next-set reps/rest or keep your current settings. Report pain with the visible stop button or feedback control to end that exercise immediately. Leaving the workout clears images, reviews, and temporary changes.

The seeded account is **Terry Lee**, UTORid `leeterry`, student ID `1234567890`, demo email `terry.lee@example.com`. The barcode is a public demo account selector: it does **not** verify a person's identity, academic standing, or University affiliation. This is not University SSO.

The email fallback issues a single-use six-digit code valid for **five minutes**, with at most five verification attempts. By default, the server terminal displays the code with a clear demo prefix; this console flow does **not** verify email ownership. To deliver actual email, configure `SPOTTER_DEMO_EMAIL` with a mailbox you control and supply `SMTP_HOST`, `SMTP_FROM`, and any required SMTP credentials. The full [Phase 1 specification](docs/phase-1.md#email-and-session-configuration) covers configuration and verification.

Card pixels and barcode decoding stay in browser memory; card images are never uploaded or sent to Gemini. Live movement processing stays on-device until the user explicitly requests a review. That action sends one workout JPEG, set measurements, user feedback, and selected preferences to Gemini through the local server. The application does not write images to disk or retain review payloads; Google processes submitted data according to the configured service. Account identifiers and raw restriction text are excluded from the model prompt.

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) only in the server environment and restart Flask after changing it. No key is required to run the rest of the app or exercise the fallback path. See [Gemini setup](docs/phase-3.md#run-with-gemini).

## Verify

```sh
python -m pytest -q
npm test
```

Verified: **168 Python tests passed, one optional legacy test skipped; 118 JavaScript tests passed**. Dependency checks passed. Verification includes authentication/CSRF and request limits, real JPEG validation, strict structured coaching, provider failures, actual SDK request serialization through a mocked HTTP transport, pain aborts, cancellation races, native headline speech, and accepted/declined next-set adjustments. See the [Phase 3 verification procedure](docs/phase-3.md#verification-procedure-and-results) for commands and manual checks.

Browser checks cover synthetic tracking → authenticated coach request → labelled missing-key fallback → adaptation acceptance, plus pain overriding the proposal and a 390-pixel layout. No API key was configured during development; successful live Gemini output and physical webcam/audio behavior remain manual checks.

Run `.venv/bin/python scripts/browser-smoke.py` for [the Phase 3 synthetic fixture](http://127.0.0.1:5056/test-coach), [the camera dependency fixture](http://127.0.0.1:5056/test-camera), or [the movement fixture](http://127.0.0.1:5056/test-workout). These routes exist only in the separate loopback test server, never in the normal application.

The old Python camera prototype remains in `app/pose`, `app/exercises`, and `app/feedback`; the browser app does not invoke it. Its optional dependencies are in `requirements-legacy.txt` for a separate Python 3.11 environment. The current `/video_feed` endpoint is removed.

See the [Phase 1 baseline](docs/phase-1.md), [Phase 2 tracking specification](docs/phase-2.md), and [current Phase 3 specification](docs/phase-3.md). Earlier phase documents describe their implementation snapshots; Phase 3 introduces the explicit workout-frame review upload.
