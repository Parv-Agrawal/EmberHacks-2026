# Phase 4 — Hands-free commands, session summary, and keyframe replay

Phase 4 extends the existing tracking and coaching flow. It adds opt-in English voice commands, a temporary session journal, an optional effort rating, and a player for each set’s selected worst-rep inflection still. No emergency profile, dispatch service, automated distress detector, or external help call is implemented in this phase.

## Behavior

Enable **Voice commands** during a workout to request microphone access. Only final recognized command phrases act on the workout; interim results and duplicate result events are ignored. Supported phrases include polite variations of:

| Phrase | Result |
| --- | --- |
| Pause / Pause workout | Stop the camera and abandon the unfinished rep; keep completed reps. |
| Resume | Reopen/recheck the camera and resume only after stable, fresh framing. |
| More rest | Add up to 30 seconds to remaining post-set rest, capped at two minutes remaining. During movement, pause for a break. |
| That felt easy / I feel tired | Record a normalized self-report for the current set’s check-in. |
| I lost my balance | Pause an active set and record the balance report. |
| I feel pain / My knee hurts | Immediately end the exercise, cancel pending review/speech, and skip its remaining sets. |
| Repeat that | Repeat the most recent cue or coaching headline, respecting the spoken-cues toggle. |
| Call for help | End the workout immediately and display **SIMULATION / DEMO MODE** with an explicit **No call or message was sent** notice. |

Help and pain have priority over ordinary commands in the same recognition result. Spoken feedback does not upload an image or request Gemini analysis: the existing **Review set with Gemini** button remains the explicit review action. More-rest requests affect the current countdown and survive edits to the next-set proposal. Reps/rest proposals still require acceptance.

Listening is optional. A visible status distinguishes startup, listening, suspension, reconnecting, errors, and off. Recognition aborts before Spotter submits synthesized speech and may resume after a 500 ms tail guard; capture also checks the speech engine’s speaking/pending state. Permission, microphone, network, and repeated-disconnection failures stop recognition with a button fallback. Natural disconnects retry at most three times without a final result. Hiding the page switches voice commands off; returning requires explicit re-enabling. Camera counting also pauses while hidden.

A final result can be misrecognized, and browser support varies. A phrase that is not recognized as an explicit command does nothing. All essential actions retain visible controls. Pain reports use the existing conservative English matcher; this is not a clinical assessment or an emergency service.

## Session summary and replay

End the workout at any time, or choose **View session summary** after its final set. The summary reports:

- Completed, visible reps and active set time, excluding paused time and incomplete reps.
- Targets reached versus sets ended, including a set ended early with zero completed reps.
- Measured volume and flagged-rep rates by exercise. Trends compare the first and last measured sets only when sufficient form evidence exists; otherwise the UI explicitly says there is not enough data.
- Optional self-reported effort from 1 to 10, its average across rated sets only, user feedback, displayed coaching source, and accepted next-set adjustments.
- A future focus drawn from actual measured flags and self-reports. No effort or successful form assessment is invented when evidence is missing.

The replay contains one selected worst-rep highlight per set. Its slider, previous/next buttons, and autoplay show inflection stills rather than continuous video. Each highlight identifies exercise, set, rep, inflection timing relative to rep start, peak angle, cadence, and measured flags. Squats say **bottom**; curls say **curl inflection**. A missing or evicted image has an explicit unavailable state alongside its measurements. Autoplay stops at the final highlight and pauses when the page hides.

## Data lifetime and browser behavior

Session history, feedback, effort, coaching, and replay images exist only in page memory. No new server endpoint, localStorage, IndexedDB, audio recorder, or persistent session store was added. The history has a global limit of 40 images and 8 MiB of estimated string storage, evicting oldest images first while retaining their measurements. The current set still retains the existing working candidate/worst JPEGs, separately from the bounded history. Only supplied completed-rep highlights are archived.

**Clear session & return to plan**, sign-out, new-session initialization, and page exit release session/replay references, remove image sources and summary text, cancel review requests, and stop camera, speech, recognition, and playback timers. Signing out clears local session data immediately even if the logout request fails. Hiding a page stops listening but preserves the session for review. TCard images never enter this path.

The browser’s SpeechRecognition implementation may process microphone audio through its vendor’s servers; Spotter discloses this before the opt-in button. It does not promise offline or local speech processing. See [MDN’s SpeechRecognition documentation](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) for browser availability and server-based recognition behavior. Existing Gemini image-upload consent and server-side key configuration are unchanged from [Phase 3](phase-3.md).

## Verification

Run from the repository root:

```sh
.venv/bin/python -m pytest -q
npm test
git diff --check
```

**Results:** 187 JavaScript tests passed; 168 Python tests passed with one optional legacy test skipped. `git diff --check` passed.

Automated coverage exercises command parsing and priority, final/interim result handling, stale callbacks, permission/network errors, bounded reconnects, TTS suspension order, resume framing/freshness, rest bounds and adaptation interactions, feedback without upload, immediate pain/help cancellation, session totals/ratings/form trends, memory eviction, replay boundaries/missing images, and data cleanup. Python checks cover the unchanged authenticated API and Gemini integration.

For a deterministic browser check without real microphone/camera access:

```sh
.venv/bin/python scripts/browser-smoke.py
```

Open [the Phase 4 developer fixture](http://127.0.0.1:5056/test-session). These routes exist only in this separate loopback test server.

1. Select **Run synthetic squat set**. Wait for PASS: four reps, worst rep 3, JPEG captured, camera released.
2. Enable voice commands in the fixture, then send **That felt easy** through **Send simulated final speech**. Confirm the check-in changes and says no review was sent. Choose effort 6.
3. Add the image-free synthetic set, then view the session summary. Expect six total reps, two targets reached, and average effort 4.5 (ratings 6 and 3).
4. Inspect the squat rep 3 highlight and advance to the curl’s unavailable-image highlight. Test the slider and autoplay. At a 390-pixel viewport, controls should fit with no horizontal overflow.
5. Clear the session and use **Check session cleanup**. Expect PASS with no retained history, replay image, or microphone intent.
6. Start a new synthetic set, enable fixture voice commands, and send **Call for help**. Expect the session to stop immediately with the demo/no-dispatch notice.

Physical-device acceptance remains necessary:

1. Run the normal application on localhost or HTTPS, complete sign-in/setup, and start a workout.
2. Enable voice commands, accept the browser microphone prompt, and test the listed phrases while verifying the visible state. Also deny permission once and verify all button controls remain usable.
3. Test Pause/Resume with stale or missing joints: counting must remain unavailable until the camera regains stable framing. A partial rep must never become a completed rep after resume.
4. Keep spoken cues on and confirm Spotter’s own speech does not trigger commands. Test Repeat that, mute, tab hiding, and re-enabling listening.
5. Finish multiple sets with different feedback and effort ratings, then inspect totals, form trends, replay, and cleanup. Test a pain phrase while a Gemini request is pending: the exercise must stop and a late response must not appear or speak.

No live microphone accuracy, physical movement accuracy, or successful live Gemini call is claimed by the synthetic fixtures. Phase 5 requires a separate explicit approval.
