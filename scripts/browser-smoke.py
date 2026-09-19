"""Serve the developer-only camera dependency fixture on loopback port 5056.

Run after npm ci && npm run setup:vision:
    python scripts/browser-smoke.py
Then open http://127.0.0.1:5056/test-camera in a browser.
This route is registered only by this test runner, never by the production app.
"""
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from flask import render_template, send_file
from app import create_app


def create_smoke_app():
    app = create_app({
        "TESTING": True,
        "SECRET_KEY": "local-browser-smoke-test-only",
        "SMTP_HOST": "",
        "SMTP_FROM": "",
    })

    @app.get("/test-camera")
    def camera_smoke():
        response = send_file(PROJECT_ROOT / "tests/browser/camera-smoke.html", max_age=0)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/test-workout")
    def workout_smoke():
        # Isolated synthetic controller fixture. Never registered by create_app.
        html = render_template("index.html").replace(
            '/static/js/main.js', '/test-workout.js'
        )
        return html, {"Cache-Control": "no-store"}

    @app.get("/test-workout.js")
    def workout_fixture_script():
        return send_file(PROJECT_ROOT / "tests/browser/workout-smoke.js", max_age=0)

    @app.get("/test-coach")
    def coach_smoke():
        html = render_template("index.html").replace('/static/js/main.js', '/test-coach.js')
        return html, {"Cache-Control": "no-store"}

    @app.get("/test-coach.js")
    def coach_fixture_script():
        return send_file(PROJECT_ROOT / "tests/browser/coach-smoke.js", max_age=0)

    @app.get("/test-session")
    def session_smoke():
        html = render_template("index.html").replace('/static/js/main.js', '/test-session.js')
        return html, {"Cache-Control": "no-store"}

    @app.get("/test-session.js")
    def session_fixture_script():
        return send_file(PROJECT_ROOT / "tests/browser/session-smoke.js", max_age=0)

    return app


if __name__ == "__main__":
    create_smoke_app().run(host="127.0.0.1", port=5056, debug=False, use_reloader=False)
