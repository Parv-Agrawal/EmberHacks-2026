# Spotter

# About the project

## Inspiration

Starting a workout can bring a lot of uncertainty: What should I do? Am I completing the movement correctly? Should I adjust the next set?

We wanted to make that experience more approachable, especially for students and beginners exercising independently. That idea became **Spotter**: a browser-based workout companion that combines webcam movement tracking, spoken guidance, and optional AI feedback.

Our goal is simple: **a little support, every rep.**

## What it does

Spotter guides users from check-in to a complete workout review.

Users begin with a TCard-style demo check-in, then choose their goals, experience level, available time, equipment, and movements to avoid. Spotter creates an editable routine from its current exercise catalog: **bodyweight squats and dumbbell bicep curls**.

After checking camera framing, Spotter carries the connected camera directly into the workout. It calibrates repetition detection to the user's starting position and checks the joints needed for each exercise. Spotter tracks repetitions and estimates joint angles locally in the browser, displaying movement phases, rep counts, timers, and feedback about range of motion, uneven movement, and cadence. Short spoken cues help users follow along without constantly watching the screen.

After each set, users can report how it felt and request a **Gemini review**. The review combines captured images from completed repetitions, up to 15 per set, with movement measurements and the user's feedback. This gives Gemini visual context from multiple repetitions to produce a concise summary, two actionable tips, and encouragement.

Local rules also propose adjustments to the next set's repetitions and rest time. Users choose whether to accept these changes. Reporting pain immediately stops the current exercise without waiting for an AI response.

Optional voice commands let users pause, resume, request more rest, and report discomfort. At the end of a workout, a session summary shows completed reps, active workout time, form trends, and self-reported effort. Users can also explore a slideshow with a captured still from each completed repetition, subject to image availability and the session's memory limit.

Spotter includes an **SOS simulation** that demonstrates an immediate workout stop and a structured briefing using an optional emergency profile. This feature is clearly marked as a demo and does not contact emergency services or send messages.

## How we built it

We built Spotter with a **Python and Flask** backend and an **HTML, CSS, and JavaScript** frontend.

**MediaPipe Pose Landmarker** estimates body landmarks directly in the browser. Our movement engine calculates joint angles from three-dimensional landmarks and follows each exercise through its movement phases to count completed repetitions.

**ZXing** handles barcode scanning for the demo check-in. Browser speech synthesis delivers spoken cues, while optional speech recognition enables voice commands.

For post-set coaching, Flask sends an explicitly submitted batch of completed-rep images and supporting data to the **Google Gemini API**. Each image is associated with its repetition number so the review can connect visual evidence with movement measurements. **Pydantic** validates the response structure, and **Pillow** validates images and removes metadata before submission. When Gemini is unavailable, Spotter provides clearly labeled local guidance.

Card scanning and live pose processing stay on-device. Workout images are sent for AI review only when the user requests it. Session replay images and emergency profiles remain in browser memory; optional speech recognition may use the browser vendor's speech service.

## Challenges we ran into

One of our biggest challenges was turning changing pose estimates into consistent rep counts. We calibrated each side's starting joint angle separately and refined the movement rules to handle continuous repetitions. Stable-framing checks and timing rules help prevent jitter, incomplete movements, and lost visibility from producing extra repetitions.

Capturing useful visual evidence was another challenge. We paired measurements with the exact frame used for inference, retained a still from each completed repetition within a bounded memory budget, and continued highlighting the rep with the highest form-fault score.

We also had to coordinate cameras, microphones, spoken cues, and asynchronous AI requests. Pausing, leaving the page, or reporting pain must stop the appropriate activity, while delayed coaching responses must never interrupt a newer session.

## Accomplishments we're proud of

We connected workout planning, live tracking, feedback, adaptation, and session review into one working flow.

We're also proud of the attention we gave to reliability and user control. Our implementation passes **448 automated tests** covering movement logic, API validation, voice controls, cancellation, privacy boundaries, and the emergency simulation.

## What we learned

We learned that useful coaching needs both movement evidence and the user's own experience. Camera estimates alone cannot tell us how a set felt.

We also learned how much real-time applications depend on handling interruptions well. Clear fallback states, explicit consent, and predictable pause-and-resume behavior are central to making the experience usable.

## What's next for Spotter

Our next priorities are testing across more devices, camera positions, and lighting conditions; refining movement thresholds through evaluation; and expanding the exercise catalog.

We would also like to explore optional saved progress with clear retention controls and improve voice support across browsers. The current movement feedback remains a prototype, and the SOS feature remains a simulation.

---

# Built with

Python, Flask, JavaScript, HTML5, CSS3, MediaPipe, Google Gemini API, ZXing, Web Speech API, Canvas API, Pydantic, Pillow, Node.js, esbuild, pytest, python-dotenv

# Try it out links

- [GitHub repository](https://github.com/Parv-Agrawal/EmberHacks-2026)
- [Local setup instructions](https://github.com/Parv-Agrawal/EmberHacks-2026#run-locally)

# Video demo link

Add the URL of your uploaded demo video here before submitting.
