"""Session/workout endpoints and explicit Phase 3 exercise-image coaching."""
from copy import deepcopy
import hmac
import secrets
import smtplib
import time

from flask import Blueprint, current_app, g, jsonify, render_template, session

from app.auth import (
    APIError, challenge_digest, current_user, deliver_code, ensure_session,
    json_body, normalize_email, rate_limit, require_user, short_string, sign_in, store,
)
from app.workouts import CATALOG, confirm_workout, draft_workout
from app.coach import decode_keyframe, decode_keyframes, generate_coaching, reports_pain, safety_feedback, validate_feedback, validate_summary

main_bp = Blueprint("main", __name__)


@main_bp.get("/")
def index():
    return render_template("index.html")


@main_bp.get("/api/session")
def get_session():
    state = ensure_session()
    return jsonify(user=current_user() if state.authenticated else None,
                   csrf_token=session["csrf"], workout=state.confirmed,
                   preferences=state.preferences,
                   demo_email=current_app.config["SPOTTER_DEMO_EMAIL"])


@main_bp.post("/api/auth/barcode")
def barcode_sign_in():
    rate_limit("barcode", 20, 60)
    body = json_body({"code"})
    code = short_string(body["code"], "Barcode", 64)
    if code not in {"2176123456789100", "leeterry"}:
        raise APIError("This card is not linked to the seeded demo account.", 401, "unknown_demo_card")
    return jsonify(sign_in())


@main_bp.post("/api/auth/email/request")
def request_email_code():
    rate_limit("email_request", 5, 15 * 60)
    body = json_body({"email"})
    email = normalize_email(body["email"])
    state = ensure_session()
    delivery = "email" if current_app.config["SMTP_HOST"] else "console"
    state.email_challenge = None
    if email == current_app.config["SPOTTER_DEMO_EMAIL"]:
        code = f"{secrets.randbelow(1_000_000):06d}"
        challenge = {"email": email, "digest": challenge_digest(email, code),
                     "expires": time.time() + 300, "attempts": 0}
        try:
            delivery = deliver_code(email, code)
        except (smtplib.SMTPException, OSError):
            raise APIError("Email delivery is unavailable. Try the demo card sign-in or retry later.", 503, "delivery_unavailable") from None
        state.email_challenge = challenge
    return jsonify(message="If this email matches the demo account, a one-time code has been sent.", delivery=delivery)


@main_bp.post("/api/auth/email/verify")
def verify_email_code():
    rate_limit("email_verify", 15, 15 * 60)
    body = json_body({"email", "code"})
    email = normalize_email(body["email"])
    code = short_string(body["code"], "Verification code", 6)
    if len(code) != 6 or not code.isascii() or not code.isdigit():
        raise APIError("Enter the six-digit verification code.")
    state = ensure_session()
    with store().lock:
        challenge = state.email_challenge
        if not challenge or challenge["expires"] <= time.time() or challenge["attempts"] >= 5:
            state.email_challenge = None
            raise APIError("This code has expired or is unavailable. Request a new code.", 401, "code_unavailable")
        challenge["attempts"] += 1
        valid = hmac.compare_digest(challenge["email"], email) and hmac.compare_digest(challenge["digest"], challenge_digest(email, code))
        if not valid:
            if challenge["attempts"] >= 5:
                state.email_challenge = None
            raise APIError("That verification code is incorrect.", 401, "incorrect_code")
        state.email_challenge = None
        return jsonify(sign_in())


@main_bp.post("/api/logout")
def logout():
    json_body(set())
    store().remove(session.get("sid"))
    session.clear()
    ensure_session()
    return jsonify(ok=True, csrf_token=session["csrf"])


@main_bp.get("/api/catalog")
@require_user
def catalog():
    return jsonify(exercises=list(CATALOG.values()))


@main_bp.post("/api/workout/draft")
@require_user
def create_workout_draft():
    rate_limit("draft", 30, 60)
    body = json_body({"goal", "experience", "minutes", "equipment", "avoid", "restrictions"})
    workout, warnings = draft_workout(body)
    # Retain the validated intake only in volatile server memory so reloading
    # and editing a plan cannot silently discard earlier movement restrictions.
    preferences = deepcopy(body)
    preferences["restrictions"] = preferences["restrictions"].strip()
    g.spotter_state.preferences = preferences
    g.spotter_state.draft = deepcopy(workout)
    g.spotter_state.confirmed = None
    return jsonify(workout=workout, warnings=warnings)


@main_bp.post("/api/workout/confirm")
@require_user
def confirm_workout_draft():
    rate_limit("confirm", 30, 60)
    body = json_body({"workout"})
    workout = confirm_workout(body["workout"], g.spotter_state.draft)
    g.spotter_state.confirmed = deepcopy(workout)
    return jsonify(workout=workout)


@main_bp.post("/api/coach")
@require_user
def coach_set():
    body = json_body({"set_summary", "user_feedback"}, {"keyframe_image", "keyframes"})
    if ("keyframe_image" in body) == ("keyframes" in body):
        raise APIError("Submit keyframes or a single keyframe image.", 400, "invalid_keyframes")
    feedback = validate_feedback(body["user_feedback"])
    # Pain feedback is handled immediately, even if a failed frame/summary would
    # otherwise block analysis. Never invoke the provider or delay safety for a limit.
    if reports_pain(feedback):
        result, source, reason = safety_feedback(), "safety", "pain_reported"
    else:
        rate_limit("coach", 10, 60)
        summary = validate_summary(body["set_summary"], g.spotter_state.confirmed)
        image_bytes = (decode_keyframes(body["keyframes"], summary) if "keyframes" in body
                       else decode_keyframe(body["keyframe_image"]))
        result, source, reason = generate_coaching(summary, feedback, image_bytes, g.spotter_state.preferences)
    response = jsonify(result.model_dump())
    response.headers["X-Spotter-Coach-Source"] = source
    if reason:
        response.headers["X-Spotter-Coach-Reason"] = reason
    return response
