# Phase 3 — Multimodal set review and adaptive next sets

## Delivered behavior

After a set, the existing inflection-image preview now includes a check-in: **Felt easy**, **Felt tired**, **Off-balance**, **I felt pain · stop**, or typed feedback. Selecting **Review set with Gemini** explicitly sends the displayed exercise frame, timestamped measurements, feedback, and selected session preferences to the server for Gemini analysis. Card images and account identifiers are excluded.

A successful review displays one headline, exactly two actionable tips, and one encouragement sentence. The browser immediately speaks the headline through native `speechSynthesis` when spoken cues are enabled and the tab is visible. The existing 3.5-second in-set cue throttle remains in place; a returned post-set headline replaces stale speech immediately, then anchors the cooldown for later in-set cues.

The next-set proposal is visible and requires **Accept for next set** or **Keep current plan**. It uses deterministic movement/feedback rules; generated prose never directly changes the plan. An accepted change updates the next set's reps and the rest countdown. Subsequent sets of the same exercise keep those current settings unless another change is accepted. A new exercise starts from its own confirmed plan. Reloading returns to the server-confirmed workout; in-session adjustments are not persisted.

Reporting pain stops the exercise immediately, releases the camera, discards incomplete motion, cancels speech and any outstanding review, and skips the remaining sets of that movement. It does not await Gemini or issue a diagnosis. Other originally planned exercises can be selected explicitly after rest; no automatic transition occurs.

This phase implements typed/selected feedback. Voice-command recognition, session replay, whole-session summaries, and SOS remain outside this phase.

## Request and response contract

`POST /api/coach` requires a signed-in session, the existing `X-CSRF-Token`, and `Content-Type: application/json`. Its request has exactly these properties:

| Property | Meaning |
| --- | --- |
| `set_summary` | The Phase 2 tracker's `{exercise_id, target_reps, completed_reps, reps, detected_faults}` object |
| `user_feedback` | String, at most 500 characters |
| `keyframe_image` | Base64 JPEG, optionally prefixed with `data:image/jpeg;base64,` |

Every rep has `rep_number`, `started_at_ms`, `bottom_at_ms`, `completed_at_ms`, `peak_angle_deg`, `cadence_seconds`, `faults`, and `score`. The API validates supported movement IDs, membership in the confirmed workout, finite numeric bounds, consecutive rep numbers, timing/cadence consistency, fault enums, and agreement between aggregate faults and per-rep faults. Targets are 4–15 reps, and completed counts cannot exceed the target. Adjusted targets within those bounds are accepted.

The JSON body limit is **800 KiB for this endpoint only**; existing endpoints retain their **16 KiB** limit. JPEG bytes must be at most **512 KiB**, each dimension must be 16–1920 pixels, and total pixels cannot exceed 2,073,600. The server verifies and decodes the JPEG in memory, then re-encodes it without EXIF/other metadata. Non-JPEG, truncated, oversized, malformed, and unexpected-field inputs are rejected. No image file is written.

Successful JSON has exactly the requested shape:

```json
{
  "headline": "Camera estimates flagged rep 4; you reported feeling off-balance.",
  "tips": [
    "Take extra rest before deciding whether to continue.",
    "Reset your stance and use a comfortable range."
  ],
  "encouragement": "Your feedback helps make the next set more manageable."
}
```

The Pydantic `CoachFeedback` model rejects missing/extra fields, wrong types, empty text, more/fewer than two tips, headlines of 25 or more words, encouragement of 15 or more words, and a total of 60 or more words. Text fields are also bounded in characters. Malformed, blocked, absent, oversized, or schema-invalid model output yields a clean local fallback rather than a crash.

Response metadata is carried in headers so the JSON contract stays unchanged:

- `X-Spotter-Coach-Source`: `gemini`, `fallback`, or `safety`.
- `X-Spotter-Coach-Reason` when relevant: `missing_api_key`, `provider_unavailable`, `invalid_response`, `assessment_unavailable`, or `pain_reported`.

Fallback JSON obeys the same schema and refers to the submitted measurements and feedback. The UI visibly labels it **LOCAL GUIDANCE · GEMINI UNAVAILABLE**, never as a successful AI analysis. No-image sets are reviewed locally and labelled **LOCAL GUIDANCE · NO KEYFRAME**, with no upload. Invalid requests receive the app's usual JSON error response (400/401/403/409/413/415); normal review requests are limited to 10 per observed IP per minute (429). Authenticated pain feedback bypasses image/summary validation and this provider rate limit, because it needs no AI call. All API responses remain `Cache-Control: no-store`.

## Gemini implementation

`app/coach.py` uses the official pinned packages:

- `google-genai==2.24.0`
- `pydantic==2.13.5`
- `Pillow==12.3.0` for bounded in-memory JPEG validation

The client is initialized with `client = genai.Client()` and closed after the request. The model is exactly **`gemini-3.8-flash`**. A JPEG `types.Part.from_bytes(..., mime_type="image/jpeg")` and serialized prompt data are passed together to `client.models.generate_content`.

`GenerateContentConfig` uses the requested system instruction, `response_mime_type="application/json"`, `response_schema=CoachFeedback`, and temperature 0.3. A 15-second provider timeout, one total attempt, low thinking, and a 4,096-token output budget bound the request while leaving room for reasoning and the short structured answer. The browser has a 20-second total request timeout.

The prompt combines:

1. The exact per-rep timestamps, angles, cadence, and fault estimates.
2. The retained worst completed rep's image, with its rep index and inflection context.
3. The user's selected/typed experience.
4. Server-side goal, experience, available minutes, equipment, and explicit movement exclusions.

Raw restriction text, names, email addresses, student identifiers, barcode values, and auth/session tokens are not included. Prompt instructions distinguish measured estimates from self-reports, treat user/image text as data rather than instructions, prohibit invented observations and medical claims, and acknowledge that one keyframe cannot establish an entire motion or diagnose an injury. These are generation instructions, not a guarantee of model factual accuracy; users can review the measurements and reject proposed changes.

The application does not persist or log coaching images, prompts, responses, or provider exception text. Google receives data only after the explicit review action; provider-side handling is governed by the configured Gemini service. Cancelling aborts the browser request and ignores late results, but cannot recall data already sent to the provider. No microphone, external TTS SDK, or File API upload is used.

## Adaptation and pain rules

`app/static/js/adaptation.js` is independent of model output and image availability. For an otherwise clean, completed 8-rep set with 60-second rest:

| User report / evidence | Proposed next set |
| --- | --- |
| Felt easy, no form flags | 9 reps, 60 seconds rest |
| Fatigued / needs more rest | 8 reps, 90 seconds rest |
| Off-balance | 6 reps, 90 seconds rest |
| Frequent form flags or deterioration in later reps | 6 reps, 90 seconds rest, even if reported easy |
| Incomplete/uncertain evidence | No increase |
| Possible pain | Stop the exercise; no next set of that movement |

Reps stay within 4–15 and rest within 30–120 seconds. Frequent flags mean at least 40% of measured reps have faults/significant penalties. With at least four reps, an increased late-half flag rate or score penalty indicates deterioration. A single flag blocks an easy-based increase even if it does not meet the reduction threshold. Pain has highest priority; balance and fatigue concerns override an easy report.

Acceptance is explicit and local. Rest is measured from the set's finish time, so reviewing or accepting the same proposal repeatedly does not restart the full countdown. Keeping the current plan restores the current set's reps/rest if a proposal was tentatively accepted. Editing feedback invalidates old findings and any accepted proposal, requiring a new decision. Advancing, leaving, signing out, cancelling, and reporting pain invalidate pending review ownership so a stale response cannot affect another set or speak later.

Pain detection is a conservative English text rule, not medical interpretation. It recognizes pain/hurting/aching and uncertain reports, while clear negations such as “no pain” and “pain-free” do not trigger a stop. Mixed reports such as “no pain before, but it hurts now” do. A pain preset or dedicated live pain button acts immediately. Typed reports are committed on blur, submission, acceptance, or next-set navigation; partial typing of “pain-free” is not treated as a completed pain report. Detection is not comprehensive natural-language understanding. Visible pain controls remain available during active, paused, and completed sets.

## Run with Gemini

From the repository root, install the updated requirements and restart the local server:

```sh
.venv/bin/python -m pip install -r requirements.txt
export GEMINI_API_KEY="your-key-from-Google-AI-Studio"
.venv/bin/python -m flask --app run run --port 5055
```

Keep the key in the server environment, never in frontend files, commits, logs, or screenshots. `GOOGLE_API_KEY` is also recognized by the SDK; configure only one to avoid precedence surprises. There is no required `.env` loader. Without either key, startup still works and requests return the visibly labelled local fallback.

## Verification procedure and results

```sh
.venv/bin/python -m pytest -q
npm test
.venv/bin/python -m pip check
```

Verified results: **168 Python tests passed, one optional legacy test skipped; 118 JavaScript tests passed**. Dependency consistency checks passed. The SDK emits a Python 3.14 deprecation warning; it does not fail these checks.

Backend tests cover the exact authenticated contract, CSRF and per-route limits, strict measurements, actual JPEG decoding/metadata removal, safe pain handling, feedback-dependent prompt/fallback behavior, timeout/schema settings, client cleanup, and all fallback paths. A real SDK call using an in-process `httpx.MockTransport` verifies the outgoing `gemini-3.8-flash` request, inline JPEG, combined prompt, and JSON-schema serialization without a network upload.

Browser/controller tests cover immediate headline speech, muted/unsupported/error cases, cancellation races, new-set ownership, feedback edits, no-image reviews, pain abort during active motion or an outstanding request, accepted/declined adaptations, rest timing, and keeping adapted settings across remaining sets.

For a camera-free browser check:

```sh
.venv/bin/python scripts/browser-smoke.py
```

Open [the Phase 3 fixture](http://127.0.0.1:5056/test-coach), run a synthetic set, select feedback, and submit a review. This fixture uses ordinary demo sign-in/workout APIs and the real `/api/coach` route. With no key, expect a clean local fallback and working adaptation controls. Its synthetic frames are labelled and do not establish physical exercise or model accuracy. The normal app does not expose this fixture route.

Manual acceptance on [Spotter](http://127.0.0.1:5055):

1. Sign in as demo `leeterry`, plan at least two sets, calibrate, and complete a set. Select **Felt easy** and request a review. With credentials, expect **GEMINI · MULTIMODAL REVIEW**, one headline, two tips, one encouragement, and audible headline delivery when unmuted.
2. On the same set, change feedback to tired or off-balance and review again. Confirm the prompt uses the same frame/measurements with the changed report, and the guidance distinguishes that report from camera estimates. Clean-set proposals should differ; form problems can conservatively override an easy report.
3. Accept a proposal. Check changed rest timing and the next set's target. Repeat with **Keep current plan** and verify current settings persist. Reload and confirm transient adjustments/images are gone.
4. Mute before review; results should still render without speech. Test an unavailable key/provider, malformed mocked output, and a no-image set: guidance must remain usable and labelled accurately.
5. Request a review, then edit feedback, cancel, leave, or begin another set. No late response should overwrite findings or speak. Submit a pain report during a pending review and verify immediate stop.
6. During a live or paused set, select **Stop · I feel pain**. Verify the camera is released, the incomplete rep is discarded, resume is unavailable, and remaining sets of that movement are skipped. “No pain” alone should not stop; a positive/uncertain pain report should.
7. Inspect Network/storage: only an explicit review sends the exercise image. Card scanning/calibration do not call `/api/coach`; no image is persisted by the application. Review the 390-pixel layout and keyboard controls.

No Gemini API key was present during implementation verification. Successful live-provider generation and physical webcam/audio validation therefore remain manual acceptance checks; fallback behavior, SDK serialization, structured parsing, and browser integration were verified without representing mocked output as live AI output.

## Primary references

The [Google model catalog](https://ai.google.dev/gemini-api/docs/models) lists the requested model. The [official Python SDK reference](https://googleapis.github.io/python-genai/) documents `Client()`, configuration, inline parts, and resource cleanup. Google's [image-understanding guide](https://ai.google.dev/gemini-api/docs/image-understanding), [structured-output guide](https://ai.google.dev/gemini-api/docs/structured-output), and [thinking guide](https://ai.google.dev/gemini-api/docs/thinking) cover the corresponding provider features.
