"""Flask application factory for the Phase 1 browser-camera demo."""
from datetime import timedelta
import hmac
import os
import secrets
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, session
from werkzeug.exceptions import HTTPException

from app.auth import APIError, DemoStore, ensure_session


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SPOTTER_SECRET_KEY") or secrets.token_hex(32),
        MAX_CONTENT_LENGTH=16 * 1024,
        SESSION_COOKIE_NAME="spotter_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("SPOTTER_COOKIE_SECURE", "false").lower() == "true",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        SPOTTER_DEMO_EMAIL=os.environ.get("SPOTTER_DEMO_EMAIL", "terry.lee@example.com").lower(),
        SMTP_HOST=os.environ.get("SMTP_HOST", ""),
        SMTP_PORT=int(os.environ.get("SMTP_PORT", "587")),
        SMTP_FROM=os.environ.get("SMTP_FROM", ""),
        SMTP_USERNAME=os.environ.get("SMTP_USERNAME", ""),
        SMTP_PASSWORD=os.environ.get("SMTP_PASSWORD", ""),
        SMTP_SSL=os.environ.get("SMTP_SSL", "false").lower() == "true",
    )
    if test_config:
        app.config.update(test_config)
    if app.config["SMTP_HOST"] and not app.config["SMTP_FROM"]:
        raise ValueError("SMTP_FROM is required when SMTP_HOST is configured.")
    app.extensions["spotter_store"] = DemoStore()

    @app.before_request
    def protect_api():
        if not request.path.startswith("/api/") or request.method in {"GET", "HEAD", "OPTIONS"}:
            return None
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError("Cross-site requests are not allowed.", 403, "origin_rejected")
        origin = request.headers.get("Origin")
        if origin:
            try:
                supplied = urlsplit(origin)
            except ValueError:
                raise APIError("This request has an invalid origin.", 403, "origin_rejected") from None
            expected = urlsplit(request.host_url)
            if (supplied.scheme, supplied.netloc) != (expected.scheme, expected.netloc):
                raise APIError("This request must come from the Spotter page.", 403, "origin_rejected")
        ensure_session()
        supplied_token = request.headers.get("X-CSRF-Token", "")
        if len(supplied_token) > 128 or not supplied_token.isascii() or not hmac.compare_digest(supplied_token, session["csrf"]):
            raise APIError("Refresh the page and retry this action.", 403, "csrf_rejected")
        return None

    @app.after_request
    def secure_responses(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(self)"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.errorhandler(APIError)
    def api_error(error):
        return jsonify(error=error.message, code=error.code), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        if request.path.startswith("/api/"):
            return jsonify(error=error.description, code="http_error"), error.code
        return error

    from app.routes import main_bp
    app.register_blueprint(main_bp)
    return app
