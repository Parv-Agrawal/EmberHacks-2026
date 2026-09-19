"""Small, process-local demo session and email verification services.

Only opaque session identifiers and CSRF tokens enter the signed browser cookie.
TCard scans are demo account selectors, not University authentication.
"""
from collections import OrderedDict, deque
from dataclasses import dataclass
from email.message import EmailMessage
from functools import wraps
import hashlib
import hmac
import secrets
import smtplib
import ssl
import threading
import time

from flask import current_app, g, request, session


class APIError(Exception):
    def __init__(self, message, status=400, code="invalid_request"):
        self.message = message
        self.status = status
        self.code = code
        super().__init__(message)


@dataclass
class SessionState:
    touched: float
    authenticated: bool = False
    email_challenge: dict | None = None
    preferences: dict | None = None
    draft: dict | None = None
    confirmed: dict | None = None


class DemoStore:
    """Bounded in-memory records; a restart intentionally signs demo users out."""

    def __init__(self, max_sessions=2048, ttl=8 * 60 * 60):
        self.sessions = OrderedDict()
        self.rates = OrderedDict()
        self.max_sessions = max_sessions
        self.ttl = ttl
        self.lock = threading.RLock()

    def get(self, sid):
        now = time.time()
        with self.lock:
            state = self.sessions.get(sid)
            if state and now - state.touched <= self.ttl:
                state.touched = now
                self.sessions.move_to_end(sid)
                return state
            if state:
                del self.sessions[sid]
            return None

    def create(self):
        with self.lock:
            while len(self.sessions) >= self.max_sessions:
                self.sessions.popitem(last=False)
            sid = secrets.token_urlsafe(32)
            state = SessionState(touched=time.time())
            self.sessions[sid] = state
            return sid, state

    def remove(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)

    def limit(self, name, identity, maximum, seconds):
        now = time.time()
        key = (name, identity)
        with self.lock:
            bucket = self.rates.setdefault(key, deque())
            self.rates.move_to_end(key)
            while bucket and bucket[0] <= now - seconds:
                bucket.popleft()
            if len(bucket) >= maximum:
                raise APIError("Too many attempts. Please wait and try again.", 429, "rate_limited")
            bucket.append(now)
            while len(self.rates) > 4096:
                self.rates.popitem(last=False)


def store():
    return current_app.extensions["spotter_store"]


def ensure_session():
    state = store().get(session.get("sid"))
    if state is None:
        session.clear()
        sid, state = store().create()
        session["sid"] = sid
        session["csrf"] = secrets.token_urlsafe(32)
        session.permanent = True
    g.spotter_state = state
    return state


def current_user():
    return {
        "name": "Terry Lee",
        "utorid": "leeterry",
        "student_id": "1234567890",
        "email": current_app.config["SPOTTER_DEMO_EMAIL"],
    }


def sign_in():
    """Rotate both identifiers when an anonymous session authenticates."""
    previous_sid = session.get("sid")
    store().remove(previous_sid)
    session.clear()
    state = ensure_session()
    state.authenticated = True
    return {"user": current_user(), "csrf_token": session["csrf"]}


def require_user(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        state = ensure_session()
        if not state.authenticated:
            raise APIError("Sign in before continuing.", 401, "sign_in_required")
        return fn(*args, **kwargs)
    return wrapped


def rate_limit(name, maximum, seconds):
    # Do not trust user-provided forwarding headers in this local demo server.
    store().limit(name, request.remote_addr or "unknown", maximum, seconds)


def json_body(required, optional=()):
    if not request.is_json:
        raise APIError("Send a JSON object using application/json.", 415, "json_required")
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise APIError("The request must contain a valid JSON object.")
    if set(body) - set(required) - set(optional):
        raise APIError("The request contains unsupported fields.")
    if set(required) - set(body):
        raise APIError("The request is missing required fields.")
    return body


def short_string(value, field_name, maximum, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise APIError(f"{field_name} must be text no longer than {maximum} characters.")
    value = value.strip()
    if not value and not allow_empty:
        raise APIError(f"{field_name} is required.")
    return value


def normalize_email(value):
    value = short_string(value, "Email", 254).lower()
    if not value.isascii() or value.count("@") != 1 or any(character.isspace() for character in value):
        raise APIError("Enter a valid email address.")
    return value


def challenge_digest(email, code):
    secret = current_app.secret_key
    if isinstance(secret, str):
        secret = secret.encode()
    return hmac.new(secret, f"{email}\0{code}".encode(), hashlib.sha256).hexdigest()


def deliver_code(email, code):
    config = current_app.config
    if not config["SMTP_HOST"]:
        # Deliberately the sole place where a one-time code is exposed for local demos.
        print(f"[SPOTTER DEMO EMAIL — LOCAL CONSOLE ONLY] Verification code: {code}", flush=True)
        return "console"
    message = EmailMessage()
    message["From"] = config["SMTP_FROM"]
    message["To"] = email
    message["Subject"] = "Your Spotter sign-in code"
    message.set_content(f"Your Spotter sign-in code is {code}. It expires in 5 minutes and can be used once.")
    smtp_class = smtplib.SMTP_SSL if config["SMTP_SSL"] else smtplib.SMTP
    kwargs = {"timeout": 10}
    if config["SMTP_SSL"]:
        kwargs["context"] = ssl.create_default_context()
    with smtp_class(config["SMTP_HOST"], config["SMTP_PORT"], **kwargs) as connection:
        if not config["SMTP_SSL"]:
            connection.starttls(context=ssl.create_default_context())
        if config["SMTP_USERNAME"]:
            connection.login(config["SMTP_USERNAME"], config["SMTP_PASSWORD"])
        connection.send_message(message)
    return "email"
