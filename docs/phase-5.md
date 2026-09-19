# Phase 5 — Emergency profile and simulated Spotter SOS

Phase 5 completes the specified hackathon roadmap. It adds an optional emergency profile, persistent SOS controls, an immediate handoff from the existing “Call for help” voice command, and a structured briefing with simulated connection progress.

Every emergency screen says **SIMULATION / DEMO MODE**. This implementation has no outbound emergency transport: no phone calls, SMS, email, webhook, Gemini analysis, or real dispatcher connection. All handoff states run inside the page. Existing workout coaching and optional sign-in email delivery are separate features and are never used for SOS.

## Behavioral walkthrough

**Emergency profile** opens from the persistent bottom rail, available before and after sign-in. Opening it pauses an active workout, stops camera/listening/speech/replay, and cancels any pending coaching request. Closing it does not automatically resume movement.

The profile collects:

- Name, callback number, preferred language, and physical location.
- Optional reported conditions, medication names/doses, and allergies.
- Explicit confirmation of medication names/doses when entered.
- Separate approval to include the medical details in the simulated briefing.
- An optional emergency contact’s name and phone, used only as briefing information.
- One of two fixed fictitious test recipients for the local handoff.

Required text is bounded and callback/contact numbers require 7–15 digits with supported phone punctuation. Every profile save requires explicit current-location confirmation, recorded with a timestamp. Editing the location or medications resets its confirmation. Editing any medical field resets approval to include medical details. Unsaved edits never enter the briefing and are discarded when the profile closes or SOS starts.

**SOS · Demo** stays available across the application; the profile dialog also has an immediate SOS button. The workout’s help button and a final recognized **Call for help** phrase reach the same controller. A trigger synchronously stops movement and microphone capture, cancels speech and pending coaching, releases the camera, and ends an active workout before starting the local simulation. No AI response, profile completion, check-in, or confirmation countdown is required.

The simulated flow is:

1. **Connecting** appears immediately with the allowlisted test recipient and a briefing.
2. At approximately 1.2 seconds, **Simulated connection / handoff** appears.
3. Approximately 1.5 seconds later, **Demo acknowledgement** appears, explicitly stating that no real responder was contacted.

This is a timed local demonstration, not a claim of network connection or delivery. Repeated triggers during the same incident do not create another handoff or restart the timeline. Timer failures end the simulation safely with a local error event. Cancelling stops future transitions; closing or pressing Escape cancels and clears the incident.

## Briefing and consent

The deterministic briefing includes caller identity, callback number, language, location and its last user-confirmation timestamp, trigger source, reason for alert, check-in response, emergency-contact reference, and approved medical details. It does not diagnose, interpret medical data, or invent missing information. Without a saved profile it starts immediately with **Unknown / Not provided** values.

Medical details say **Withheld** unless explicitly approved. Medication names/doses also require their separate confirmation. The profile never supplies images or data to the Gemini coaching endpoint. A saved location is labelled as last confirmed at a specific time, not independently verified or presumed current.

During a simulation, the user can:

- Select **I can respond** or **I need assistance**, with **Not answered** as the default. An unanswered check-in does not imply unconsciousness.
- Enter a reason and explicitly update the local briefing.
- Enter a physical location and select **Confirm this location**. Draft location changes do not replace the last confirmed briefing location.
- Cancel the simulation or close the demo. No action calls or messages an actual emergency contact.

Updates create clearly labelled local briefing revisions. There is no geolocation lookup, clipboard export, automatic escalation, clinical advice, or real emergency-service integration.

## Recipient restriction

Only these immutable IDs are accepted by the simulation engine:

| ID | Display name | Fictitious address |
| --- | --- | --- |
| `spotter-test-desk` | Spotter test desk | `spotter-test-desk@example.invalid` |
| `spotter-test-buddy` | Demo training partner | `spotter-test-buddy@example.invalid` |

Arbitrary recipient IDs, addresses, recipient objects, and additional transport options are rejected. Entering an emergency contact in the profile does not add them to this allowlist. There is no transport implementation to enable by changing configuration.

## Data lifetime

The profile, unsaved draft, incident, briefing, and timeline live only in browser page memory. No emergency API, database, localStorage, IndexedDB, cookies, files, or logs were added. Browser autofill is disabled on the profile form. Profile clearing, sign-out, changing users, page exit, and reload remove the profile and incident. Closing a demo clears its briefing/timers while retaining the separately saved profile for the current page visit. Closing the profile removes its unsaved field values. Workout summaries retain only their existing exercise data, never emergency medical details.

The existing optional browser voice recognizer may use its vendor’s speech service, as disclosed in Phase 4. SOS does not introduce a new microphone stream or send typed profile data through recognition. Real microphone recognition accuracy remains a physical-device acceptance check.

## Implementation

- `emergency-profile.js`: bounded validation and immutable, consent-filtered briefings.
- `sos-simulation.js`: fixed recipient allowlist, local state machine, cancellation and stale-timer protection.
- `emergency-assistant.js`: native-dialog controls, profile ownership, trigger coordination, text-only rendering, incident updates and cleanup.
- `emergency.html` and `emergency.css`: persistent controls, profile setup and responsive handoff screens.
- `main.js` / `live-workout.js`: synchronous device/review shutdown and shared button/voice SOS handoff.

No new Python runtime dependency or external service setup is required.

## Verification procedure

```sh
.venv/bin/python -m pytest -q
npm test
git diff --check
```

**Results:** 243 JavaScript tests passed; 168 Python tests passed with one optional legacy test skipped. `git diff --check` passed. Browser checks passed for button/voice SOS, both consent states, missing profiles, location/check-in updates, cancellation, cleanup, and a 390-pixel layout.

Automated checks cover profile validation, medical consent, medication/location confirmations, missing profiles, immutable briefings, allowlist rejection, idempotent triggers, connection transitions, native browser timer binding, timer failures, cancellation races, check-in revisions, plain-text rendering, identity boundaries, data cleanup, and voice/button handoff cancelling pending coaching.

For deterministic browser verification without a real microphone or webcam:

```sh
.venv/bin/python scripts/browser-smoke.py
```

Open [the Phase 5 fixture](http://127.0.0.1:5056/test-emergency), which exists only on the separate test server. Use fictitious profile details such as “Demo Tester”, `+1 416 555 0100`, and “DEMO ONLY — Test Gym, room 2, Toronto”.

1. Trigger **SOS · Demo** without a profile. Confirm immediate local connection and a briefing with unknown identity/location. Check that every screen discloses no real call or message.
2. Update the check-in response and enter/confirm a test location. Confirm the briefing changes and records a user-confirmation timestamp.
3. Close the demo and fill an emergency profile. Enter mock medication text without checking its confirmation: save must display a validation error. Confirm it, but leave medical approval off; save and trigger SOS. Medical fields must say **Withheld**.
4. Edit the profile, confirm location again, approve the medical details, and save. Run a synthetic set, enable the fixture’s simulated voice commands, and send **Call for help**. Verify immediate workout stop, trigger **voice**, approved mock medical details, and the chosen allowlisted recipient.
5. Cancel during connection; later timer events must not revive the incident. Reopen and let the complete local timeline reach demo acknowledgement. Close it and verify the briefing clears.
6. At a 390-pixel viewport, verify the profile and SOS dialogs scroll without horizontal overflow and controls remain usable.
7. Use **Simulate sign-out and check emergency cleanup**. Expect PASS: profile, medical data, briefing, timers, and workout cleared.

Normal-app review: run Flask on port 5055, test the persistent rail before sign-in and throughout setup/workout, use the real browser microphone only after opting in, and verify actual sign-out/reload clears emergency details. Test SOS while a Gemini review is pending; a late response must never appear or speak after the handoff starts.

This phase does not implement experimental automated distress detection/NFC, official university SSO, or real emergency telephony. Further work requires a separately agreed scope.
