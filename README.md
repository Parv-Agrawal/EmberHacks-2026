# Spotter — Phase 1

Spotter is a local hackathon demo for TCard-style check-in, personalized workout setup, and browser-based camera calibration. The implemented flow ends at **“Your workout setup is complete.”** Exercise tracking, Gemini coaching, voice commands, and emergency flows are not implemented in this phase.

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

The seeded account is **Terry Lee**, UTORid `leeterry`, student ID `1234567890`, demo email `terry.lee@example.com`. The barcode is a public demo account selector: it does **not** verify a person's identity, academic standing, or University affiliation. This is not University SSO.

The email fallback issues a single-use six-digit code valid for **five minutes**, with at most five verification attempts. By default, the server terminal displays the code with a clear demo prefix; this console flow does **not** verify email ownership. To deliver actual email, configure `SPOTTER_DEMO_EMAIL` with a mailbox you control and supply `SMTP_HOST`, `SMTP_FROM`, and any required SMTP credentials. The full [Phase 1 specification](docs/phase-1.md#email-and-session-configuration) covers configuration and verification.

Camera pixels and barcode decoding stay in browser memory. No card photos, workout images, or video are saved or uploaded. Only a decoded demo identifier reaches the sign-in endpoint. Preferences, including restriction text, are retained only in bounded, process-local session memory so reloading and editing a routine preserves movement exclusions. They are never stored in the cookie or written to disk, and disappear with the session or a server restart.

## Verify

```sh
python -m pytest -q
npm test
```

Latest verification: **65 Python tests passed, one optional legacy test skipped; 11 JavaScript tests passed**. The JavaScript suite includes real decoding of generated Code 128/Code 39 fixtures, framing thresholds, stale-frame rejection, and camera cleanup behavior.

Browser checks passed for manual and console-code sign-in, editing/confirming two exercises, equipment and restriction filters, disabled confirmation while camera permission was pending, and a 390-pixel mobile layout without overflow. A real browser smoke test also loaded the local MediaPipe module/model/WASM, ran CPU video-mode inference on a blank canvas, kept calibration unavailable, and closed model resources. Physical-card/webcam scanning, live full-body calibration, actual permission denial, and SMTP mailbox delivery remain hardware/account checks. Follow the [manual acceptance checks](docs/phase-1.md#manual-acceptance-checks).

To repeat the camera dependency test without webcam permission, run `python scripts/browser-smoke.py` and open [the isolated browser fixture](http://127.0.0.1:5056/test-camera). Expect a green PASS result. This test route exists only in that separate loopback test server.

The old Python camera prototype remains in `app/pose`, `app/exercises`, and `app/feedback`; Phase 1 does not invoke it. Its optional dependencies are in `requirements-legacy.txt` for a separate Python 3.11 environment. The current `/video_feed` endpoint is removed.

See [Phase 1 specifications, API contracts, and verification](docs/phase-1.md) for implementation details and review criteria.
