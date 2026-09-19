# Squat form checker (v1)

A webcam-based Flask app that uses MediaPipe to detect body landmarks,
judges squat depth from joint angles, and streams a live overlay +
tips back to the browser as an MJPEG feed.

## Structure

- `app/pose/` — wraps MediaPipe (the *only* place mediapipe is imported)
- `app/exercises/` — form-correctness logic (squat.py has placeholder
  thresholds you need to tune)
- `app/feedback/` — drawing the overlay + generating tips text
- `app/routes.py` — the only file that knows about Flask/HTTP; wires
  the above together

This separation means you can swap any one piece (a different pose
library, a different exercise, a React frontend) without touching the
others. See the routes.py -> React migration note below.

## Setup

```
python -m venv venv
source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python run.py
```

Then open http://127.0.0.1:5000 — you should see your webcam feed with
a MediaPipe skeleton drawn over it and a "Go lower" / "Good depth"
message in the corner.

## What's actually working vs. placeholder

Working out of the box:
- Webcam capture, MediaPipe pose detection, skeleton drawing, MJPEG
  streaming to the browser.

Left as TODOs (search the codebase for `TODO`):
- `exercises/squat.py` — knee angle thresholds are guesses. Record
  yourself doing real squats, print `knee_angle`, and tune
  `STANDING_KNEE_ANGLE` / `BOTTOM_KNEE_ANGLE`.
- `exercises/squat.py` — no rep-counting state machine yet, no back-
  angle check.
- `feedback/tips.py` — reference video is just a YouTube search link;
  swap in one you trust.

## Later: swapping in a React frontend

`routes.py` is the only file that knows this is server-rendered HTML.
When you're ready for React:
1. Add JSON endpoints (e.g. `/api/landmarks`, `/api/tips`) alongside
   or instead of the template route.
2. Keep `/video_feed` as-is — a React component can point an `<img>`
   tag at it exactly like the current template does.
3. Nothing in `pose/`, `exercises/`, or `feedback/` needs to change.

## Running tests

```
pytest
```
