# Phase 1 — Check-in, workout setup, and camera calibration

## Scope and completion boundary

The implemented path is **Sign in → Preferences → Review workout → Camera calibration → Setup complete**. Both supported exercises are available for planning and use the same conservative full-body calibration gate. The final screen confirms setup and offers plan editing or another camera check. It does not start a set.

No exercise tracking, rep counting, keyframe capture, Gemini endpoint, spoken coaching, voice commands, session replay, or emergency behavior is implemented here. Existing Python exercise/pose prototypes are retained but are not imported by the web application's startup path.

## Check-in behavior and trust boundary

- The camera is explicitly enabled by the user. A viewfinder and framing guide assist live Code 128/Code 39 scanning. Native barcode detection is used when both formats are supported; the locally bundled ZXing decoder supplies the fallback.
- Recognized demo values are `2176123456789100` and `leeterry`. The browser normalizes barcode text to lowercase, so a Code 39 fixture containing `LEETERRY` works. The server accepts only the exact seeded identifiers after trimming whitespace.
- A recognized barcode receives a green outline for 600 ms, followed by account resolution and a subtle confirmation tone. Unknown barcodes display a visible failure and cannot sign in. Leaving or hiding the scanner during confirmation cancels the pending action.
- The visible manual demo control accepts the same identifiers. Email is available without camera permission.
- The only account is Terry Lee (`leeterry`, student ID `1234567890`). Its email defaults to `terry.lee@example.com` and is configurable.

**The public barcode is a demo selector, not an authentication factor that proves identity.** Anyone knowing the seeded value can access this shared demonstration account. Neither this flow nor verified mailbox access establishes University affiliation or academic standing. No University integration or passkey enrollment is present.

## Preferences and workout rules

Supported preferences are:

| Field | Accepted values |
| --- | --- |
| `goal` | `strength`, `fitness`, `confidence` |
| `experience` | `beginner`, `intermediate`, `experienced` |
| `minutes` | `10`, `20`, `30` |
| `equipment` | Any nonduplicated subset of `bodyweight`, `dumbbells` |
| `avoid` | Any nonduplicated subset of `squat`, `bicep_curl` |
| `restrictions` | Text, maximum 500 characters |

Bodyweight squats require selected bodyweight equipment; bicep curls require selected dumbbells. Explicit avoidance always removes a movement. The small restriction parser conservatively recognizes simple body-area or movement exclusions: knees, hips, back, legs, and lower body remove squats; arms, shoulders, elbows, wrists, biceps, and upper body remove curls. Combined upper/lower-body wording excludes both. Unrecognized or ambiguous restrictions stop drafting with an explanatory message, including when mixed with a recognizable body area. Negated body-area lists are treated conservatively, not as permission to exercise.

These rules are limited movement filters, not medical assessment or a guarantee that a routine is suitable. A user must review the proposed routine. If no supported movement remains, the API returns `workout: null` with warnings rather than inventing an alternative.

Drafts are deterministic apart from their random identifiers. Goal determines the initial rep count, while experience and available time determine sets. Estimated duration includes two minutes of setup, four seconds per rep, and rests between sets; the server reduces sets if needed to fit the selected time. This is a planning estimate, not a measured workout duration.

Users can remove movements and edit **1–4 sets, 4–15 reps, and 30–120 seconds of rest**. At least one movement must remain. Confirmation accepts only a unique subset of the most recent server-generated draft, rejects added/filtered movements and stale draft identifiers, restores canonical exercise names/cues, and rejects plans exceeding available time. A new draft clears any earlier confirmation. Successfully validated intake, including restrictions and blocked drafts, is retained in volatile session memory and returned on reload so editing preferences preserves earlier exclusions. Invalid submissions do not overwrite the last validated preferences.

## Camera calibration contract

MediaPipe Pose Landmarker runs on the device in video mode, with a single pose and no segmentation masks. The app samples new frames at most every 100 ms and draws an in-memory joint overlay. This phase evaluates framing only.

The gate checks all **12 landmarks**: left/right shoulders, elbows, wrists, hips, knees, and ankles (indices 11–16 and 23–28). Every required landmark must have:

- Finite normalized `x` and `y` coordinates between **0.025 and 0.975**, keeping a 2.5% margin inside each image edge.
- Visibility of at least **0.7**; presence must also be at least **0.7** when the model supplies it.
- A fresh observation no more than **350 ms** old, with no future timestamp.

Readiness requires **1.2 seconds** of uninterrupted valid observations. A missing or low-confidence required joint, an invalid frame, or a gap over 350 ms resets readiness. The UI shows placement guidance or **“Assessment Unavailable”** and disables confirmation. The final confirmation handler checks frame freshness again; a cached Ready result cannot complete setup.

Stopping the camera, changing screens, signing out, hiding the tab, leaving the page, camera interruption, or disconnect releases camera tracks and clears overlays. Restarting requires a new framing check. A delayed permission result arriving after cancellation has its tracks immediately released. Missing permissions, hardware, or local assets produce visible recovery instructions without bypassing calibration.

The threshold choices above are application rules, not guarantees from the model. MediaPipe's official guide documents video-mode inference and landmark outputs; its synchronous browser inference can take longer on slower hardware, which this gate treats conservatively. See the [official Pose Landmarker Web guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

## API contracts

All responses are JSON. First call `GET /api/session` and retain the cookie and `csrf_token`. Every `POST` must use `Content-Type: application/json` and `X-CSRF-Token`, including logout with `{}`. Sign-in rotates the token; use the returned replacement. Cross-site requests and mismatched supplied origins are rejected.

Bodies must be JSON objects, contain only allowed fields, and fit the **16 KiB** request limit. Errors have `{ "error": "Readable explanation", "code": "stable_code" }`. Expected statuses include 400 for invalid input, 401 for missing/failed sign-in, 403 for CSRF/origin rejection, 409 for missing/stale drafts, 413 for oversize input, 415 for non-JSON requests, 429 for rate limits, and 503 for email delivery failure. API responses use `Cache-Control: no-store`.

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `GET /api/session` | None | `{user, csrf_token, workout, preferences, demo_email}`; unauthenticated `user`, unconfirmed `workout`, and absent `preferences` are `null`; preferences use the validated draft-request shape |
| `POST /api/auth/barcode` | `{code}` | `{user, csrf_token}` |
| `POST /api/auth/email/request` | `{email}` | `{message, delivery: "console" or "email"}`; generic message does not expose whether the address matches |
| `POST /api/auth/email/verify` | `{email, code}` | `{user, csrf_token}` |
| `POST /api/logout` | `{}` | `{ok: true, csrf_token}`; starts a new anonymous session |
| `GET /api/catalog` | Requires sign-in | `{exercises: [{id, name, equipment, cue}]}` |
| `POST /api/workout/draft` | Requires sign-in; preferences below | `{workout, warnings: []}`; blocked draft has `workout: null` |
| `POST /api/workout/confirm` | Requires sign-in; `{workout}` with current draft and edits | `{workout}` containing the validated plan |

User object:

```json
{
  "name": "Terry Lee",
  "utorid": "leeterry",
  "student_id": "1234567890",
  "email": "terry.lee@example.com"
}
```

Draft request:

```json
{
  "goal": "fitness",
  "experience": "beginner",
  "minutes": 20,
  "equipment": ["bodyweight", "dumbbells"],
  "avoid": [],
  "restrictions": ""
}
```

Workout object shape; `exercises` can contain one or both allowed movements:

```json
{
  "id": "server-generated-draft-id",
  "goal": "fitness",
  "experience": "beginner",
  "available_minutes": 20,
  "estimated_minutes": 5,
  "exercises": [
    {
      "id": "squat",
      "name": "Bodyweight squat",
      "sets": 2,
      "reps": 10,
      "rest_seconds": 60,
      "cue": "Stand with your feet comfortably apart and move within a comfortable range."
    }
  ]
}
```

No endpoint accepts photos, frames, or landmark uploads. Additional image fields are rejected. The decoded demo identifier is sent once for account resolution and is not logged by the application.

## Email and session configuration

Set environment variables before starting the server; no `.env` loader is required or configured.

| Variable | Default / behavior |
| --- | --- |
| `SPOTTER_DEMO_EMAIL` | `terry.lee@example.com`; the sole allowed email, also shown in the UI |
| `SPOTTER_SECRET_KEY` | Generated at process startup when omitted |
| `SPOTTER_COOKIE_SECURE` | `false` for local HTTP; set `true` when serving HTTPS |
| `SMTP_HOST` | Empty; no SMTP host means explicit console-demo delivery |
| `SMTP_PORT` | `587` |
| `SMTP_FROM` | Required when `SMTP_HOST` is set |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Credentials used if a username is configured |
| `SMTP_SSL` | `false` uses STARTTLS; `true` uses implicit TLS, typically with port 465 |

To test genuine email delivery, set `SPOTTER_DEMO_EMAIL` to a mailbox you control and configure the SMTP host, sender, credentials, and matching port/TLS settings. The default `example.com` address is a placeholder. SMTP failure returns a visible error and does not leave a usable challenge. Successfully redeeming a code delivered through SMTP demonstrates access to that configured mailbox; the barcode demo path remains publicly accessible.

Codes are cryptographically random six-digit values, expire after **five minutes**, permit at most **five incorrect attempts**, and are single-use and bound to the requesting session. A newly requested code replaces the previous challenge. Only a keyed digest is retained in server memory. Without SMTP, the code is printed solely as `[SPOTTER DEMO EMAIL — LOCAL CONSOLE ONLY] Verification code: …`; the UI explains that this is **not email ownership verification**.

Application rate limits are per observed client IP: 20 barcode attempts per minute, five email requests per 15 minutes, 15 verification submissions per 15 minutes, and 30 draft/confirmation requests each per minute. User-provided forwarding headers are not trusted.

The signed cookie contains only an opaque session ID, a CSRF token, and Flask's permanence flag. It uses HttpOnly and SameSite=Lax, with an eight-hour lifetime; the Secure flag is configurable. Server records have an eight-hour inactivity limit and a capacity of 2,048 sessions. Rate records are also bounded. Account state, email challenges, preferences (including restriction text), drafts, and confirmations are **process-local and nonpersistent**: restart or eviction loses them, and multiple workers do not share them. This setup is intended for one local demo process.

## Privacy and local assets

Card frames are decoded in browser memory and cleared after each fallback scan attempt. Calibration uses the live browser stream; no screenshots, video recording, data URLs, disk files, or frame uploads are created. Card images are never sent to Gemini or another analysis service. Camera access does not request microphone audio.

Raw restrictions are retained only with validated preferences in volatile server session memory so a reload cannot silently drop a movement exclusion. They are not written to disk or placed in cookies. Sign-out, session expiry/eviction, or server restart discards the stored preferences. Drafts contain only the resulting workout fields. API bodies, barcode strings, and card images are not logged by the application; the explicitly marked console email code is the local-demo exception for one-time-code delivery.

`npm ci` uses the lockfile. `npm run setup:vision` prepares:

| Asset | Pinned version |
| --- | --- |
| `@mediapipe/tasks-vision` | `0.10.21` |
| `@zxing/browser` | `0.1.5` |
| `@zxing/library` | `0.21.3` |
| `esbuild` | `0.25.12` |
| Pose Landmarker Lite | `float16/1`, SHA-256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |

Runtime/model files are served from `app/static/vendor/`, which is generated and ignored by Git. Setup records asset provenance in `ASSETS.json` and copies library notices. A checksum mismatch stops setup. Installation downloads packages and the official model; the stylesheet separately requests Google Fonts. These are asset requests, not camera-data uploads. The barcode integration follows the [official ZXing browser README](https://github.com/zxing-js/browser#readme) and uses the formats supported by the [official ZXing library](https://github.com/zxing-js/library#readme).

## Setup and automated verification

From the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm run setup:vision
python -m pytest -q
npm test
python -m flask --app run run --port 5055
```

Use `.venv\Scripts\activate` on Windows. Python 3.11+ and Node.js 20+ are required. Open [the local preview](http://127.0.0.1:5055). `python run.py` is an alternative development entry point on port 5000. Camera access works on localhost or HTTPS, not arbitrary plain-HTTP network addresses.

The Phase 1 Python requirements pin Flask `3.1.3` and pytest `9.1.1`. Optional original camera dependencies are separate in `requirements-legacy.txt`; use a separate Python 3.11 environment if working on that prototype. The legacy MediaPipe construction test skips when MediaPipe is absent. No Phase 1 behavior depends on it.

Verified results: **65 Python tests passed, one optional legacy test skipped; 11 JavaScript tests passed**. Tests cover authentication/CSRF/session isolation, one-time-code expiry/reuse/attempt limits, constrained drafting and tamper-resistant confirmation, actual Code 128/Code 39 decoding through the built bundle, landmark thresholds, continuous readiness, stale frames, and cancellation cleanup.

Real browser checks passed for manual demo sign-in, console-code sign-in, customized two-exercise confirmation, the bodyweight-only equipment filter, combined upper/lower-body restriction blocking, and disabled camera confirmation while awaiting permission. A confirmed curl-only plan was reloaded and Edit preferences correctly restored the selected time, dumbbells, and “avoid squats” restriction. The layout also passed a 390-pixel mobile viewport check without horizontal overflow.

The separate browser dependency smoke test passed with the actual vendored JavaScript module, WebAssembly files, and pinned model: CPU VIDEO mode initialized, inference on a blank canvas returned zero poses, `CalibrationGate` remained unavailable, and `model.close()` completed. To repeat it after preparing assets:

```sh
python scripts/browser-smoke.py
```

Open [the developer-only fixture](http://127.0.0.1:5056/test-camera) and expect the green PASS result. It requests no webcam permission and cannot mark a workout ready. The `/test-camera` route is registered only by this separate loopback test runner, never by the normal application.

Physical-card scanning, live full-body readiness and visibility loss, browser permission denial, and real SMTP delivery remain manual acceptance items rather than claimed completed tests.

## Manual acceptance checks

1. **Fresh session:** open localhost, verify no camera starts automatically, and confirm the page clearly labels demo access. Opening protected API endpoints before sign-in should return 401.
2. **Live barcode:** enable the camera and present a printed or separately displayed Code 128 fixture containing `2176123456789100`; repeat with Code 39 containing the same number or `LEETERRY`. Expect the green outline, subtle tone, camera release, and Terry Lee's onboarding. An unrelated barcode must not sign in. These are seeded demo fixtures, not a claim that every real TCard is linked.
3. **Email fallback:** switch to email while scanning and check that the camera stops. Request a code for the shown address, copy it from the local server terminal, and redeem it. Verify incorrect, expired, reused, and superseded codes fail. A different email must not receive a usable challenge. With SMTP configured, repeat using the actual inbox and confirm the UI describes email delivery rather than console delivery.
4. **Permission failure:** deny camera access, verify a clear error and working email/manual fallback, then restore permission and retry. If permission is granted only after leaving the camera screen, verify the camera does not stay active.
5. **Onboarding constraints:** draft with both equipment options, then with bodyweight only; curls must disappear in the latter. Explicitly avoid squats; they must disappear. Try `knee pain`, `elbow discomfort`, and `avoid upper and lower body`. The first two exclude the corresponding movement; the last produces no routine. Unknown restrictions such as `dizziness` or mixed `knee pain and heart condition` must stop drafting with an explanation.
6. **Editable review:** modify sets/reps/rest within bounds, remove a movement, and confirm. Try empty plans, values outside the limits, and edits that exceed selected time; confirmation must fail. Reload the confirmed plan, choose Edit preferences, and confirm that equipment, movement exclusions, and restriction text are still populated. Editing preferences and drafting again invalidates the old draft.
7. **No false readiness:** reach calibration without granting access, while loading assets, with no person visible, and with ankles or wrists outside the frame. Confirmation must stay disabled and the page must show guidance or Assessment Unavailable.
8. **Stable readiness:** in good light, face the camera far enough back for all 12 required joints to fit inside the framing margin. Keep hands visible and still. Confirm that Ready appears only after uninterrupted visibility and the confirmation button then works. Setup completion should release the camera and display the final setup screen.
9. **Lost/stale visibility:** after reaching Ready, leave the frame or obscure a required joint. Readiness must clear immediately on the next assessment. Pause/disconnect the webcam feed or test a virtual camera that stops providing fresh frames; after the freshness limit, confirmation must be unavailable. Synthetic timing checks are also covered by `npm test`.
10. **Cleanup and repeatability:** hide the tab during scanning and calibration, return, and verify camera use stopped and readiness reset. Repeat with Stop camera, screen navigation, sign-out, and page navigation. Reopening calibration must require a fresh 1.2-second check.
11. **Privacy and restart:** inspect browser network requests during both camera modes; only static assets, decoded demo sign-in values, and ordinary setup JSON should be transmitted. There should be no image/frame uploads. Restart the server, reload, and verify that previous authentication and workout state no longer persist.

Record manual hardware-check outcomes alongside the automated results. The implementation stops at Phase 1; further implementation requires explicit user approval after review.
