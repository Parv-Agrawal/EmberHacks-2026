"""Phase 1 contract, account boundary, and constrained-workout verification."""
from copy import deepcopy
import re
import smtplib
import time

import pytest

from app import create_app
from app.workouts import draft_workout


@pytest.fixture
def app():
    return create_app({"TESTING": True, "SECRET_KEY": "test-secret-only", "SMTP_HOST": "", "SPOTTER_DEMO_EMAIL": "terry.lee@example.com"})


@pytest.fixture
def client(app):
    return app.test_client()


def token(client):
    return client.get("/api/session").get_json()["csrf_token"]


def post(client, path, body, csrf=None):
    return client.post(path, json=body, headers={"X-CSRF-Token": csrf or token(client)})


def sign_in(client):
    result = post(client, "/api/auth/barcode", {"code": "2176123456789100"})
    assert result.status_code == 200
    return result.get_json()


def preferences(**overrides):
    result = {"goal": "fitness", "experience": "beginner", "minutes": 20,
              "equipment": ["bodyweight", "dumbbells"], "avoid": [], "restrictions": ""}
    result.update(overrides)
    return result


def draft(client, **overrides):
    result = post(client, "/api/workout/draft", preferences(**overrides))
    assert result.status_code == 200
    return result.get_json()


def request_code(client, capsys):
    response = post(client, "/api/auth/email/request", {"email": "terry.lee@example.com"})
    assert response.status_code == 200
    assert response.get_json()["delivery"] == "console"
    captured = capsys.readouterr().out
    assert "SPOTTER DEMO EMAIL" in captured
    return re.search(r"Verification code: (\d{6})", captured).group(1)


def test_initial_session_is_anonymous_and_cookie_has_secure_attributes(client):
    response = client.get("/api/session")
    assert response.get_json()["user"] is None
    assert response.get_json()["workout"] is None
    assert response.get_json()["preferences"] is None
    assert response.get_json()["demo_email"] == "terry.lee@example.com"
    assert len(response.get_json()["csrf_token"]) >= 32
    cookie = response.headers["Set-Cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=Lax" in cookie
    assert response.headers["Cache-Control"] == "no-store"


def test_authenticated_endpoints_require_sign_in(client):
    assert client.get("/api/catalog").status_code == 401
    assert post(client, "/api/workout/draft", preferences()).status_code == 401


def test_barcode_resolves_only_seeded_demo_user_and_rotates_csrf(client, capsys):
    previous = token(client)
    response = post(client, "/api/auth/barcode", {"code": "2176123456789100"}, previous)
    data = response.get_json()
    assert data["user"] == {"name": "Terry Lee", "utorid": "leeterry", "student_id": "1234567890", "email": "terry.lee@example.com"}
    assert data["csrf_token"] != previous
    assert "2176123456789100" not in capsys.readouterr().out
    assert client.get("/api/session").get_json()["user"]["name"] == "Terry Lee"
    assert len(client.get("/api/catalog").get_json()["exercises"]) == 2


def test_utorid_is_seeded_demo_selector(client):
    assert post(client, "/api/auth/barcode", {"code": "leeterry"}).status_code == 200


def test_unknown_card_is_rejected_without_echo(client):
    response = post(client, "/api/auth/barcode", {"code": "unrecognized-card"})
    assert response.status_code == 401
    assert "unrecognized-card" not in response.get_data(as_text=True)
    assert client.get("/api/session").get_json()["user"] is None


def test_missing_csrf_wrong_origin_and_cross_site_are_rejected(client):
    csrf = token(client)
    assert client.post("/api/auth/barcode", json={"code": "leeterry"}).status_code == 403
    for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
        response = client.post("/api/auth/barcode", json={"code": "leeterry"}, headers={"X-CSRF-Token": csrf, **headers})
        assert response.status_code == 403
    assert client.post("/api/auth/barcode", json={"code": "leeterry"}, headers={"X-CSRF-Token": csrf, "Origin": "http://localhost"}).status_code == 200


def test_unknown_fields_images_and_oversized_bodies_are_rejected(client):
    assert post(client, "/api/auth/barcode", {"code": "leeterry", "image": "base64-card-photo"}).status_code == 400
    assert post(client, "/api/auth/barcode", {"code": "x" * 65}).status_code == 400
    assert post(client, "/api/auth/barcode", {"code": "x" * 20000}).status_code == 413
    assert client.get("/api/session").get_json()["user"] is None


def test_malformed_origin_and_non_ascii_csrf_do_not_crash(client):
    csrf = token(client)
    for headers in ({"X-CSRF-Token": "é"}, {"X-CSRF-Token": csrf, "Origin": "http://["}):
        assert client.post("/api/auth/barcode", json={"code": "leeterry"}, headers=headers).status_code == 403


def test_only_json_objects_are_accepted(client):
    csrf = token(client)
    assert client.post("/api/auth/barcode", data="code=leeterry", headers={"X-CSRF-Token": csrf}).status_code == 415
    assert client.post("/api/auth/barcode", data="{", content_type="application/json", headers={"X-CSRF-Token": csrf}).status_code == 400
    assert post(client, "/api/auth/barcode", ["leeterry"]).status_code == 400


def test_barcode_rate_limit(client):
    for _ in range(20):
        assert post(client, "/api/auth/barcode", {"code": "unknown"}).status_code == 401
    assert post(client, "/api/auth/barcode", {"code": "leeterry"}).status_code == 429


def test_email_requires_one_time_code_and_code_is_not_in_response(client, capsys):
    code = request_code(client, capsys)
    assert client.get("/api/session").get_json()["user"] is None
    response = post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code})
    assert response.status_code == 200
    assert response.get_json()["user"]["utorid"] == "leeterry"
    assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code}).status_code == 401


def test_email_challenge_expires(app, client, capsys):
    code = request_code(client, capsys)
    with client.session_transaction() as cookie:
        sid = cookie["sid"]
    app.extensions["spotter_store"].sessions[sid].email_challenge["expires"] = time.time() - 1
    response = post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code})
    assert response.status_code == 401
    assert response.get_json()["code"] == "code_unavailable"


def test_email_challenge_stops_after_five_incorrect_attempts(client, capsys):
    code = request_code(client, capsys)
    wrong = "111111" if code != "111111" else "222222"
    for _ in range(5):
        assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": wrong}).status_code == 401
    assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code}).get_json()["code"] == "code_unavailable"


def test_requesting_new_email_code_invalidates_previous(client, capsys):
    previous = request_code(client, capsys)
    newer = request_code(client, capsys)
    if previous != newer:
        assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": previous}).status_code == 401
    assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": newer}).status_code == 200


def test_unknown_email_does_not_emit_code_or_authenticate(client, capsys):
    response = post(client, "/api/auth/email/request", {"email": "somebody@example.com"})
    assert response.status_code == 200
    assert "code" not in response.get_json()
    assert capsys.readouterr().out == ""
    assert post(client, "/api/auth/email/verify", {"email": "somebody@example.com", "code": "123456"}).status_code == 401


def test_smtp_delivery_failure_does_not_create_a_valid_challenge(app, client, monkeypatch):
    def unavailable(*_args):
        raise smtplib.SMTPException("delivery unavailable")
    monkeypatch.setattr("app.routes.deliver_code", unavailable)
    result = post(client, "/api/auth/email/request", {"email": "terry.lee@example.com"})
    assert result.status_code == 503
    with client.session_transaction() as cookie:
        assert app.extensions["spotter_store"].sessions[cookie["sid"]].email_challenge is None


def test_email_codes_are_session_bound_and_stored_as_digests(app, client, capsys):
    code = request_code(client, capsys)
    with client.session_transaction() as cookie:
        challenge = app.extensions["spotter_store"].sessions[cookie["sid"]].email_challenge
        assert "code" not in challenge
        assert len(challenge["digest"]) == 64
    other = app.test_client()
    assert post(other, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code}).status_code == 401
    assert post(client, "/api/auth/email/verify", {"email": "terry.lee@example.com", "code": code}).status_code == 200


def test_logout_invalidates_session_and_clears_workout(client):
    sign_in(client)
    workout = draft(client)["workout"]
    assert post(client, "/api/workout/confirm", {"workout": workout}).status_code == 200
    assert post(client, "/api/logout", {}).get_json()["ok"] is True
    data = client.get("/api/session").get_json()
    assert data["user"] is None and data["workout"] is None
    assert client.get("/api/catalog").status_code == 401


def test_workout_filters_equipment_and_explicit_avoid(client):
    sign_in(client)
    result = draft(client, equipment=["bodyweight"])
    assert [item["id"] for item in result["workout"]["exercises"]] == ["squat"]
    result = draft(client, avoid=["squat"])
    assert [item["id"] for item in result["workout"]["exercises"]] == ["bicep_curl"]
    assert draft(client, avoid=["squat", "bicep_curl"])["workout"] is None


@pytest.mark.parametrize("restriction,expected", [("knee pain", "bicep_curl"), ("avoid squats because my back is sore", "bicep_curl"), ("lower body", "bicep_curl"), ("lower back pain", "bicep_curl"), ("upper back pain", "bicep_curl"), ("left elbow injury", "squat"), ("shoulder discomfort", "squat"), ("upper body", "squat")])
def test_simple_restrictions_filter_movements(client, restriction, expected):
    sign_in(client)
    result = draft(client, restrictions=restriction)
    assert [item["id"] for item in result["workout"]["exercises"]] == [expected]


@pytest.mark.parametrize("restriction", ["dizziness", "knee pain and heart condition", "pregnant", "C6 issue", "pain", "lower", "all movements", "avoid upper and squats", "avoid lower and curls", "body and knee pain", "lower back and upper", "none; knee pain"])
def test_unclear_or_unsupported_restrictions_do_not_generate_routine(client, restriction):
    sign_in(client)
    result = draft(client, restrictions=restriction)
    assert result["workout"] is None
    assert result["warnings"]


@pytest.mark.parametrize("restriction", ["avoid upper and lower body", "avoid lower and upper body", "upper or lower body", "lower body and upper", "no knee or shoulder restrictions"])
def test_combined_body_areas_and_negated_lists_never_clear_a_movement(client, restriction):
    sign_in(client)
    result = draft(client, restrictions=restriction)
    assert result["workout"] is None
    assert any("Bodyweight squat excluded" in warning for warning in result["warnings"])
    assert any("Dumbbell bicep curl excluded" in warning for warning in result["warnings"])


def test_all_drafts_fit_available_time():
    for goal in ("strength", "fitness", "confidence"):
        for experience in ("beginner", "intermediate", "experienced"):
            for minutes in (10, 20, 30):
                workout, _ = draft_workout(preferences(goal=goal, experience=experience, minutes=minutes))
                assert workout["estimated_minutes"] <= minutes
                assert all(1 <= item["sets"] <= 4 for item in workout["exercises"])


@pytest.mark.parametrize("change", [{"minutes": True}, {"goal": []}, {"experience": "professional"}, {"equipment": ["machines"]}, {"avoid": [["squat"]]}, {"restrictions": "x" * 501}, {"equipment": ["bodyweight", "bodyweight"]}])
def test_invalid_preferences_are_rejected(client, change):
    sign_in(client)
    assert post(client, "/api/workout/draft", preferences(**change)).status_code == 400


def test_customized_workout_is_validated_canonicalized_and_saved(client):
    sign_in(client)
    workout = draft(client)["workout"]
    workout["exercises"] = workout["exercises"][:1]
    workout["exercises"][0].update(sets=3, reps=12, rest_seconds=90, name="Changed browser label", cue="Injected instruction")
    result = post(client, "/api/workout/confirm", {"workout": workout})
    assert result.status_code == 200
    confirmed = result.get_json()["workout"]
    exercise = confirmed["exercises"][0]
    assert exercise["sets"] == 3 and exercise["reps"] == 12 and exercise["rest_seconds"] == 90
    assert exercise["name"] == "Bodyweight squat"
    assert exercise["cue"] != "Injected instruction"
    assert client.get("/api/session").get_json()["workout"] == confirmed


def test_confirmation_rejects_contraindicated_additions_stale_drafts_and_unsafe_edits(client):
    sign_in(client)
    original = draft(client)["workout"]
    restricted = draft(client, avoid=["squat"])["workout"]
    assert post(client, "/api/workout/confirm", {"workout": original}).status_code == 409
    for key, value in (("sets", 0), ("sets", 5), ("reps", 16), ("reps", True), ("rest_seconds", 0)):
        changed = deepcopy(restricted)
        changed["exercises"][0][key] = value
        assert post(client, "/api/workout/confirm", {"workout": changed}).status_code == 400
    changed = deepcopy(restricted)
    changed["exercises"] = [original["exercises"][0]]
    assert post(client, "/api/workout/confirm", {"workout": changed}).status_code == 400


def test_empty_duplicate_over_time_and_image_confirmation_are_rejected(client):
    sign_in(client)
    workout = draft(client, minutes=10)["workout"]
    changed = deepcopy(workout)
    changed["exercises"] = []
    assert post(client, "/api/workout/confirm", {"workout": changed}).status_code == 400
    changed["exercises"] = [workout["exercises"][0], workout["exercises"][0]]
    assert post(client, "/api/workout/confirm", {"workout": changed}).status_code == 400
    changed = deepcopy(workout)
    for item in changed["exercises"]:
        item.update(sets=4, reps=15, rest_seconds=120)
    assert post(client, "/api/workout/confirm", {"workout": changed}).status_code == 400
    assert post(client, "/api/workout/confirm", {"workout": workout, "keyframe_image": "photo"}).status_code == 400


def test_sensitive_preferences_are_kept_out_of_cookie(client):
    sign_in(client)
    draft(client, restrictions="knee pain")
    with client.session_transaction() as cookie:
        assert set(cookie) == {"sid", "csrf", "_permanent"}


def test_validated_preferences_survive_reload_without_losing_restrictions(client):
    sign_in(client)
    supplied = preferences(goal="confidence", experience="experienced", minutes=30,
                           equipment=["bodyweight", "dumbbells"], avoid=["squat"],
                           restrictions="  knee pain  ")
    result = post(client, "/api/workout/draft", supplied).get_json()
    assert post(client, "/api/workout/confirm", {"workout": result["workout"]}).status_code == 200
    expected = {**supplied, "restrictions": "knee pain"}
    assert client.get("/api/session").get_json()["preferences"] == expected
    assert post(client, "/api/workout/draft", {**supplied, "minutes": 4}).status_code == 400
    assert client.get("/api/session").get_json()["preferences"] == expected
    with client.session_transaction() as cookie:
        assert set(cookie) == {"sid", "csrf", "_permanent"}
    assert post(client, "/api/logout", {}).status_code == 200
    assert client.get("/api/session").get_json()["preferences"] is None


def test_blocked_draft_keeps_validated_preferences_for_correction(client):
    sign_in(client)
    supplied = preferences(equipment=["bodyweight"], avoid=["squat"], restrictions="dizziness")
    response = post(client, "/api/workout/draft", supplied)
    assert response.status_code == 200 and response.get_json()["workout"] is None
    assert client.get("/api/session").get_json()["preferences"] == supplied


def test_new_blocked_draft_clears_previously_confirmed_workout(client):
    sign_in(client)
    workout = draft(client)["workout"]
    post(client, "/api/workout/confirm", {"workout": workout})
    draft(client, restrictions="unsupported restriction")
    assert client.get("/api/session").get_json()["workout"] is None
    assert post(client, "/api/workout/confirm", {"workout": workout}).status_code == 409


def test_no_server_camera_endpoint(client):
    assert client.get("/video_feed").status_code == 404


def test_drafts_and_confirmations_are_isolated_per_session(app, client):
    sign_in(client)
    workout = draft(client)["workout"]
    other = app.test_client()
    sign_in(other)
    assert post(other, "/api/workout/confirm", {"workout": workout}).status_code == 409
    assert post(client, "/api/workout/confirm", {"workout": workout}).status_code == 200
    assert other.get("/api/session").get_json()["workout"] is None


def test_expired_server_session_cannot_keep_using_authenticated_cookie(app, client):
    sign_in(client)
    with client.session_transaction() as cookie:
        app.extensions["spotter_store"].sessions[cookie["sid"]].touched = 0
    assert client.get("/api/catalog").status_code == 401


def test_https_cookie_configuration():
    application = create_app({"TESTING": True, "SMTP_HOST": "", "SESSION_COOKIE_SECURE": True})
    response = application.test_client().get("/api/session", base_url="https://localhost")
    assert "Secure;" in response.headers["Set-Cookie"]


def test_session_advertises_configured_demo_email():
    application = create_app({"TESTING": True, "SMTP_HOST": "", "SPOTTER_DEMO_EMAIL": "demo@example.org"})
    assert application.test_client().get("/api/session").get_json()["demo_email"] == "demo@example.org"
