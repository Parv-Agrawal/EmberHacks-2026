# Spotter — Phase 5

Spotter is a local hackathon demo for TCard-style check-in, personalized workouts, live squat/curl tracking, multimodal Gemini reviews, voice commands, session replay, and **simulated emergency assistance**. Phase 5 adds an optional emergency profile, persistent SOS controls, a consent-filtered briefing, and a local dispatcher simulation. Every emergency screen states **SIMULATION / DEMO MODE**. No real call, message, or dispatcher contact occurs.

See the [Phase 5 specification and verification procedure](docs/phase-5.md) for the emergency flow and privacy rules, [Phase 4](docs/phase-4.md) for voice and replay, and [Phase 3](docs/phase-3.md) for Gemini integration. This completes the five-phase roadmap.

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
7. Accept the proposed next-set reps/rest or keep your current settings. Report pain with the visible stop button or feedback control to end that exercise immediately. Enable voice commands if desired; speak feedback without automatically requesting a review. Rate each set’s effort from 1–10.
8. End the workout to view measured volume, form trends, self-reported effort, and one worst-rep inflection still per set. Clear the summary to release all session data. The microphone is opt-in, may use the browser vendor’s speech service, and turns off when the page is hidden or the session ends.
9. Open **Emergency profile** from the persistent bottom rail. Enter the details you choose to include, confirm your location and any medication names/doses, and separately approve medical details for the local demo briefing.
10. Trigger **SOS · Demo** or say **Call for help** while voice commands are enabled. Movement and pending coaching stop immediately; the local handoff displays its fixed test recipient, briefing, check-in controls, and simulated progress. You can cancel or close it at any time. Missing profiles never block SOS.

Emergency profiles and incidents exist only in page memory and clear on sign-out/reload. No emergency data goes to Gemini. An entered emergency contact is briefing information only; the simulator accepts only its two fixed fictitious recipients and has no outbound transport.

The seeded account is **Terry Lee**, UTORid `leeterry`, student ID `1234567890`, demo email `terry.lee@example.com`. The barcode is a public demo account selector: it does **not** verify a person's identity, academic standing, or University affiliation. This is not University SSO.

The email fallback issues a single-use six-digit code valid for **five minutes**, with at most five verification attempts. By default, the server terminal displays the code with a clear demo prefix; this console flow does **not** verify email ownership. To deliver actual email, configure `SPOTTER_DEMO_EMAIL` with a mailbox you control and supply `SMTP_HOST`, `SMTP_FROM`, and any required SMTP credentials. The full [Phase 1 specification](docs/phase-1.md#email-and-session-configuration) covers configuration and verification.

Card pixels and barcode decoding stay in browser memory; card images are never uploaded or sent to Gemini. Live movement processing stays on-device until the user explicitly requests a review. That action sends one workout JPEG, set measurements, user feedback, and selected preferences to Gemini through the local server. The application does not write images to disk or retain review payloads; Google processes submitted data according to the configured service. Account identifiers and raw restriction text are excluded from the model prompt.

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) only in the server environment and restart Flask after changing it. No key is required to run the rest of the app or exercise the fallback path. See [Gemini setup](docs/phase-3.md#run-with-gemini).

## Verify

```sh
python -m pytest -q
npm test
```

**Verified:** 243 JavaScript tests passed; 168 Python tests passed, with one optional legacy test skipped.

Verification covers authenticated requests, Gemini serialization/fallback, pain aborts, movement tracking, command parsing and microphone lifecycle, spoken-cue echo protection, camera-gated resume, bounded rest, summary calculations, replay memory limits, profile consent, allowlisted local SOS handoff, immediate cancellation, and cleanup. See the [Phase 5 verification procedure](docs/phase-5.md#verification-procedure).

Browser checks cover synthetic tracking/voice, summaries/replay, SOS with and without a profile, withheld and approved medical details, location/check-in updates, simulated connection states, cancellation, cleanup, and a 390-pixel layout. Real microphone recognition and physical webcam behavior remain manual checks. A Gemini API key is still required to verify successful live provider output.

Run `.venv/bin/python scripts/browser-smoke.py` for [the Phase 5 fixture](http://127.0.0.1:5056/test-emergency), [the Phase 4 fixture](http://127.0.0.1:5056/test-session), [the coach fixture](http://127.0.0.1:5056/test-coach), [the camera dependency fixture](http://127.0.0.1:5056/test-camera), or [the movement fixture](http://127.0.0.1:5056/test-workout). These routes exist only in the separate loopback test server, never in the normal application.

The old Python camera prototype remains in `app/pose`, `app/exercises`, and `app/feedback`; the browser app does not invoke it. Its optional dependencies are in `requirements-legacy.txt` for a separate Python 3.11 environment. The current `/video_feed` endpoint is removed.

See the [Phase 1 baseline](docs/phase-1.md), [Phase 2 tracking specification](docs/phase-2.md), and [Phase 3 coaching specification](docs/phase-3.md). Earlier phase documents describe implementation snapshots. The [Phase 4 specification](docs/phase-4.md) adds optional browser speech recognition and bounded session replay. The [current Phase 5 specification](docs/phase-5.md) adds the fully local emergency-assistance demo.
