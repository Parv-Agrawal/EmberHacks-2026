"""Phase 3 coaching contract, real SDK serialization, and privacy boundaries."""
import base64
from io import BytesIO
import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
from PIL import Image
import pytest
from pydantic import ValidationError

from app import create_app
from app import coach


FEEDBACK = {
    "headline": "Camera estimates recorded 2 reps; you reported feeling tired.",
    "tips": ["Take extra rest before the next set.", "Keep both sides moving smoothly within a comfortable range."],
    "encouragement": "Good work sharing how the set felt.",
}


def jpeg(format="JPEG", size=(64, 48)):
    output = BytesIO()
    Image.new("RGB", size, (60, 90, 120)).save(output, format=format)
    return output.getvalue()


def summary():
    return {
        "exercise_id": "squat", "target_reps": 8, "completed_reps": 2,
        "reps": [
            {"rep_number": 1, "started_at_ms": 1000, "bottom_at_ms": 2000, "completed_at_ms": 3000,
             "peak_angle_deg": 90, "cadence_seconds": 2, "faults": [], "score": 0},
            {"rep_number": 2, "started_at_ms": 4000, "bottom_at_ms": 5000, "completed_at_ms": 6000,
             "peak_angle_deg": 115, "cadence_seconds": 2, "faults": ["shallow_depth"], "score": 10},
        ],
        "detected_faults": ["shallow_depth"],
    }


def body():
    return {"set_summary": summary(), "user_feedback": "I felt tired", "keyframe_image": base64.b64encode(jpeg()).decode()}


@pytest.fixture
def app(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setattr(coach, "dotenv_values", lambda *args: {})
    return create_app({"TESTING": True, "SECRET_KEY": "test-coach-secret", "SMTP_HOST": ""})


def post(client, path, payload):
    token = client.get("/api/session").get_json()["csrf_token"]
    return client.post(path, json=payload, headers={"X-CSRF-Token": token})


@pytest.fixture
def client(app):
    client = app.test_client()
    post(client, "/api/auth/barcode", {"code": "leeterry"})
    response = post(client, "/api/workout/draft", {
        "goal": "fitness", "experience": "beginner", "minutes": 20,
        "equipment": ["bodyweight", "dumbbells"], "avoid": [], "restrictions": "",
    })
    post(client, "/api/workout/confirm", {"workout": response.get_json()["workout"]})
    return client


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-placeholder-not-a-real-key")
    instance = Mock()
    instance.models.generate_content.return_value = SimpleNamespace(text=json.dumps(FEEDBACK))
    constructor = Mock(return_value=instance)
    monkeypatch.setattr(coach.genai, "Client", constructor)
    return constructor, instance


def assert_contract(response, source):
    assert response.status_code == 200
    assert response.headers["X-Spotter-Coach-Source"] == source
    assert response.headers["Cache-Control"] == "no-store"
    payload = response.get_json()
    assert set(payload) == {"headline", "tips", "encouragement"}
    assert len(payload["tips"]) == 2
    coach.CoachFeedback.model_validate(payload)
    return payload


def test_no_key_fallback_is_explicit_concrete_and_feedback_sensitive(client):
    payload = body()
    response = post(client, "/api/coach", payload)
    tired = assert_contract(response, "fallback")
    assert response.headers["X-Spotter-Coach-Reason"] == "missing_api_key"
    assert "rep 2" in tired["headline"] and "115°" in tired["headline"]
    payload["user_feedback"] = "Felt easy"
    easy = assert_contract(post(client, "/api/coach", payload), "fallback")
    assert easy["tips"] != tired["tips"]
    payload["user_feedback"] = "Felt off-balance on rep 2"
    balance = assert_contract(post(client, "/api/coach", payload), "fallback")
    assert "You reported balance" in balance["tips"][0]


@pytest.mark.parametrize("text", ["Not tired", "No balance issues", "Not easy", "I wasn't feeling tired", "Not off balance"])
def test_fallback_does_not_recast_negated_feedback_as_a_positive_report(client, text):
    payload = body()
    payload["user_feedback"] = text
    result = assert_contract(post(client, "/api/coach", payload), "fallback")
    assert result["tips"][0] == "Rest before another set and choose a comfortable effort."


def test_multimodal_call_fuses_image_metrics_feedback_and_only_whitelisted_preferences(client, provider, app):
    constructor, instance = provider
    with client.session_transaction() as cookie:
        state = app.extensions["spotter_store"].sessions[cookie["sid"]]
    state.preferences["restrictions"] = "private restriction detail"
    state.preferences["name"] = "private-name"
    response = post(client, "/api/coach", body())
    assert assert_contract(response, "gemini") == FEEDBACK
    constructor.assert_called_once_with(api_key="test-placeholder-not-a-real-key")
    request = instance.models.generate_content.call_args.kwargs
    assert request["model"] == "gemini-3.8-flash"
    image_part, prompt = request["contents"]
    assert image_part.inline_data.mime_type == "image/jpeg"
    assert image_part.inline_data.data.startswith(b"\xff\xd8")
    context = json.loads(prompt)
    assert context["set_summary"] == summary()
    assert context["user_feedback"] == "I felt tired"
    assert context["keyframe_context"]["rep_number"] == 2
    assert set(context["session_preferences"]) == {"goal", "experience", "minutes", "equipment", "avoid"}
    assert context["session_preferences"]["goal"] == "fitness"
    for private in ("Terry", "leeterry", "1234567890", "2176123456789100", "terry.lee", "private restriction", "private-name"):
        assert private not in prompt
    config = request["config"]
    assert config.response_schema is coach.CoachFeedback
    assert config.response_mime_type == "application/json"
    assert config.temperature == 0.3
    assert config.http_options.timeout == 15_000
    assert config.http_options.retry_options.attempts == 1
    assert config.thinking_config.thinking_level.value == "LOW"
    assert config.max_output_tokens == 4096
    assert "untrusted data" in config.system_instruction
    instance.close.assert_called_once()
    assert state.__dict__.keys() == {"touched", "authenticated", "email_challenge", "preferences", "draft", "confirmed"}


def test_real_sdk_serializes_schema_and_inline_image_without_external_network(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-placeholder-not-a-real-key")
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(FEEDBACK)}]}, "finishReason": "STOP"}]})

    real_client = coach.genai.Client(http_options={"client_args": {"transport": httpx.MockTransport(handle)}})
    monkeypatch.setattr(coach.genai, "Client", lambda **kwargs: real_client)
    assert_contract(post(client, "/api/coach", body()), "gemini")
    assert len(seen) == 1
    assert "gemini-3.8-flash:generateContent" in str(seen[0].url)
    request = json.loads(seen[0].content)
    assert request["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/jpeg"
    schema = request["generationConfig"].get("responseJsonSchema") or request["generationConfig"]["responseSchema"]
    assert (schema["properties"]["tips"].get("minItems") or schema["properties"]["tips"]["min_items"]) == 2
    assert (schema["properties"]["tips"].get("maxItems") or schema["properties"]["tips"]["max_items"]) == 2
    assert set(schema["required"]) == {"headline", "tips", "encouragement"}
    assert all(value == 15 for value in seen[0].extensions["timeout"].values())


@pytest.mark.parametrize("response_text", [
    "not json", "{}", "null", "[]", "", None, "x" * 4001,
    json.dumps({**FEEDBACK, "tips": ["Only one tip"]}),
    json.dumps({**FEEDBACK, "tips": ["A", "B", "C"]}),
    json.dumps({**FEEDBACK, "headline": 123}),
    json.dumps({**FEEDBACK, "encouragement": " "}),
    json.dumps({**FEEDBACK, "tips": [" ", "A"]}),
    json.dumps({**FEEDBACK, "unexpected": "extra"}),
    json.dumps({**FEEDBACK, "headline": "word " * 25}),
    json.dumps({**FEEDBACK, "encouragement": "word " * 15}),
    json.dumps({**FEEDBACK, "tips": ["word " * 30, "word " * 30]}),
])
def test_bad_provider_output_has_clean_fallback(client, provider, response_text):
    _, instance = provider
    instance.models.generate_content.return_value = SimpleNamespace(text=response_text)
    response = post(client, "/api/coach", body())
    assert_contract(response, "fallback")
    assert response.headers["X-Spotter-Coach-Reason"] == "invalid_response"
    instance.close.assert_called_once()


@pytest.mark.parametrize("error", [TimeoutError("private timeout"), RuntimeError("secret provider payload"), httpx.ReadTimeout("private data")])
def test_provider_failures_do_not_expose_error_or_log_images(client, provider, error, caplog, capsys):
    _, instance = provider
    instance.models.generate_content.side_effect = error
    response = post(client, "/api/coach", body())
    assert_contract(response, "fallback")
    assert response.headers["X-Spotter-Coach-Reason"] == "provider_unavailable"
    assert str(error) not in response.get_data(as_text=True)
    assert not caplog.text and not capsys.readouterr().out
    instance.close.assert_called_once()


@pytest.mark.parametrize("text", [
    "My knee hurts", "Sharp pain on rep 4", "My elbow is aching", "Felt easy but my back hurt",
    "I am not sure whether this is pain", "Maybe pain?", "not much pain", "not pain-free",
    "No pain before, now my knee hurts", "No pain, but my shoulder aches", "a headache",
    "no pain-free reps", "I didn't have pain until rep 4",
])
def test_pain_bypasses_provider_and_unusable_image_or_metrics(client, provider, text):
    constructor, _ = provider
    response = post(client, "/api/coach", {"user_feedback": text, "set_summary": None, "keyframe_image": None})
    result = assert_contract(response, "safety")
    assert "stopped" in result["headline"]
    assert response.headers["X-Spotter-Coach-Reason"] == "pain_reported"
    constructor.assert_not_called()


@pytest.mark.parametrize("text", [
    "No pain", "Not painful", "Pain-free", "I am pain free", "My knee doesn't hurt",
    "I don't have any pain", "I'm not in pain", "Without sharp pain", "No pain, no aches",
    "My knee no longer hurts", "The pain is gone", "No pain; felt easy", "Tired but no pain",
    "No pain or aches", "no aches or sharp pain", "I do not have pain", "My knee does not hurt",
])
def test_clear_negation_allows_regular_coaching(client, provider, text):
    payload = body()
    payload["user_feedback"] = text
    assert_contract(post(client, "/api/coach", payload), "gemini")


def test_endpoint_requires_authentication_csrf_same_origin_and_confirmed_plan(app, provider):
    client = app.test_client()
    assert post(client, "/api/coach", body()).status_code == 401
    post(client, "/api/auth/barcode", {"code": "leeterry"})
    assert client.post("/api/coach", json=body()).status_code == 403
    token = client.get("/api/session").get_json()["csrf_token"]
    assert client.post("/api/coach", json=body(), headers={"X-CSRF-Token": token, "Origin": "https://elsewhere.example"}).status_code == 403
    assert post(client, "/api/coach", body()).status_code == 409
    provider[0].assert_not_called()


def test_coach_body_limit_does_not_expand_other_endpoints(client, provider):
    payload = body()
    # Whitespace pads valid JSON past the normal endpoint limit without changing data.
    data = json.dumps(payload) + " " * 20_000
    token = client.get("/api/session").get_json()["csrf_token"]
    headers = {"X-CSRF-Token": token}
    assert_contract(client.post("/api/coach", data=data, content_type="application/json", headers=headers), "gemini")
    assert client.post("/api/coach", data=" " * (coach.MAX_COACH_BODY_BYTES + 1), content_type="application/json", headers=headers).status_code == 413
    assert post(client, "/api/workout/draft", {"data": "x" * 20_000}).status_code == 413
    assert post(client, "/api/auth/barcode", {"code": "x" * 20_000}).status_code == 413


@pytest.mark.parametrize("image", [
    "not base64", "data:image/png;base64,AAAA", "", None, {},
    base64.b64encode(b"\xff\xd8not-a-jpeg\xff\xd9").decode(),
    base64.b64encode(jpeg(format="PNG")).decode(),
    base64.b64encode(jpeg()[:100]).decode(),
    base64.b64encode(jpeg(size=(1930, 16))).decode(),
    base64.b64encode(jpeg(size=(1, 1))).decode(),
    base64.b64encode(b"x" * (coach.MAX_IMAGE_BYTES + 1)).decode(),
])
def test_invalid_images_rejected_before_provider(client, provider, image):
    payload = body()
    payload["keyframe_image"] = image
    response = post(client, "/api/coach", payload)
    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_keyframe"
    provider[0].assert_not_called()


def test_data_uri_jpeg_is_accepted_and_metadata_removed(client, provider):
    output = BytesIO()
    original = Image.new("RGB", (64, 48), "blue")
    exif = original.getexif()
    exif[270] = "private-image-description"
    original.save(output, format="JPEG", exif=exif)
    payload = body()
    payload["keyframe_image"] = "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()
    assert_contract(post(client, "/api/coach", payload), "gemini")
    sent = provider[1].models.generate_content.call_args.kwargs["contents"][0].inline_data.data
    assert b"private-image-description" not in sent
    with Image.open(BytesIO(sent)) as image:
        assert not image.getexif()


@pytest.mark.parametrize("path,value", [
    (("exercise_id",), "push_up"), (("exercise_id",), {}), (("target_reps",), 16),
    (("target_reps",), True), (("target_reps",), 3), (("completed_reps",), 3),
    (("completed_reps",), -1), (("completed_reps",), "2"), (("reps",), []),
    (("detected_faults",), []), (("detected_faults",), ["valgus_knee_collapse"]),
    (("reps", 0, "rep_number"), 2), (("reps", 0, "score"), float("nan")),
    (("reps", 0, "score"), float("inf")), (("reps", 0, "score"), 10 ** 400),
    (("reps", 0, "peak_angle_deg"), 181), (("reps", 0, "peak_angle_deg"), True),
    (("reps", 0, "cadence_seconds"), 3), (("reps", 0, "bottom_at_ms"), 4000),
    (("reps", 1, "started_at_ms"), 2000), (("reps", 0, "faults"), ["limited_curl_range"]),
    (("reps", 0, "faults"), ["uneven_range", "uneven_range"]),
])
def test_invalid_or_inconsistent_summary_rejected(client, provider, path, value):
    payload = body()
    item = payload["set_summary"]
    for key in path[:-1]:
        item = item[key]
    item[path[-1]] = value
    response = post(client, "/api/coach", payload)
    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_set_summary"
    provider[0].assert_not_called()


def test_summary_and_body_allow_no_extra_fields_or_missing_fields(client, provider):
    payloads = []
    for path in ([], ["set_summary"], ["set_summary", "reps", 0]):
        payload = body()
        item = payload
        for key in path:
            item = item[key]
        item["unexpected"] = "private detail"
        payloads.append(payload)
    for field in body():
        payload = body()
        del payload[field]
        payloads.append(payload)
    for payload in payloads:
        assert post(client, "/api/coach", payload).status_code == 400
    provider[0].assert_not_called()


def test_zero_reps_never_send_an_unattributed_keyframe(client, provider):
    payload = body()
    payload["set_summary"].update(completed_reps=0, reps=[], detected_faults=[])
    response = post(client, "/api/coach", payload)
    assert_contract(response, "fallback")
    assert response.headers["X-Spotter-Coach-Reason"] == "assessment_unavailable"
    provider[0].assert_not_called()


def test_supported_curl_and_adapted_target_are_accepted(client, provider):
    payload = body()
    payload["set_summary"].update(exercise_id="bicep_curl", target_reps=9, detected_faults=["limited_curl_range"])
    payload["set_summary"]["reps"][1]["faults"] = ["limited_curl_range"]
    assert_contract(post(client, "/api/coach", payload), "gemini")


def test_unplanned_supported_exercise_is_rejected(client, provider, app):
    with client.session_transaction() as cookie:
        app.extensions["spotter_store"].sessions[cookie["sid"]].confirmed["exercises"] = [{"id": "bicep_curl"}]
    assert post(client, "/api/coach", body()).status_code == 409
    provider[0].assert_not_called()


@pytest.mark.parametrize("value", ["x" * 501, {}, None, 15])
def test_feedback_is_bounded_text(client, provider, value):
    payload = body()
    payload["user_feedback"] = value
    assert post(client, "/api/coach", payload).status_code == 400
    provider[0].assert_not_called()


def test_rate_limit_and_safety_bypass(client, provider):
    for _ in range(10):
        assert post(client, "/api/coach", body()).status_code == 200
    assert post(client, "/api/coach", body()).status_code == 429
    payload = body()
    payload["user_feedback"] = "My knee hurts"
    assert_contract(post(client, "/api/coach", payload), "safety")
    assert provider[1].models.generate_content.call_count == 10


def test_missing_empty_and_whitespace_output_fields_rejected_by_schema():
    for payload in ({}, {**FEEDBACK, "headline": " "}, {**FEEDBACK, "tips": ["", "Keep control"]}):
        with pytest.raises(ValidationError):
            coach.CoachFeedback.model_validate(payload)


def multiframe_body():
    payload = body()
    image = payload.pop("keyframe_image")
    payload["keyframes"] = [{"rep_number": n, "image": image} for n in (1, 2)]
    return payload


def test_all_keyframes_reach_one_provider_call_with_explicit_rep_mapping(client, provider):
    payload = multiframe_body()
    payload["keyframes"].reverse()
    assert_contract(post(client, "/api/coach", payload), "gemini")
    provider[1].models.generate_content.assert_called_once()
    contents = provider[1].models.generate_content.call_args.kwargs["contents"]
    assert len(contents) == 3
    assert all(part.inline_data.mime_type == "image/jpeg" for part in contents[:-1])
    context = json.loads(contents[-1])
    assert [frame["rep_number"] for frame in context["keyframes"]] == [1, 2]
    assert [frame["image_number"] for frame in context["keyframes"]] == [1, 2]
    assert context["set_summary"] == summary()
    assert "Inspect all images" in context["keyframe_context"]["position"]


@pytest.mark.parametrize("case", ["empty", "duplicate", "uncompleted", "bool", "extra", "bad_image", "too_many", "both_formats"])
def test_invalid_keyframe_batches_never_reach_provider(client, provider, case):
    payload = multiframe_body()
    frames = payload["keyframes"]
    if case == "empty": payload["keyframes"] = []
    elif case == "duplicate": frames[1]["rep_number"] = 1
    elif case == "uncompleted": frames[1]["rep_number"] = 3
    elif case == "bool": frames[0]["rep_number"] = True
    elif case == "extra": frames[0]["private"] = "not allowed"
    elif case == "bad_image": frames[1]["image"] = "not a jpeg"
    elif case == "too_many": payload["keyframes"] = frames * 8
    elif case == "both_formats": payload["keyframe_image"] = frames[0]["image"]
    assert post(client, "/api/coach", payload).status_code == 400
    provider[0].assert_not_called()


def test_dotenv_key_is_read_at_review_time_and_never_returned(client, provider, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    settings = {}
    monkeypatch.setattr(coach, "dotenv_values", lambda *args: settings.copy())
    response = post(client, "/api/coach", multiframe_body())
    assert_contract(response, "fallback")
    assert response.headers["X-Spotter-Coach-Reason"] == "missing_api_key"
    provider[0].assert_not_called()
    settings["GEMINI_API_KEY"] = "test-local-file-key"
    response = post(client, "/api/coach", multiframe_body())
    assert_contract(response, "gemini")
    provider[0].assert_called_once_with(api_key="test-local-file-key")
    assert "test-local-file-key" not in response.get_data(as_text=True)


def test_real_sdk_serializes_every_keyframe_in_one_request(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-placeholder-not-a-real-key")
    seen = []
    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(FEEDBACK)}]}, "finishReason": "STOP"}]})
    real_client = coach.genai.Client(http_options={"client_args": {"transport": httpx.MockTransport(handle)}})
    monkeypatch.setattr(coach.genai, "Client", lambda **kwargs: real_client)
    assert_contract(post(client, "/api/coach", multiframe_body()), "gemini")
    assert len(seen) == 1
    parts = seen[0]["contents"][0]["parts"]
    assert len([part for part in parts if "inlineData" in part]) == 2
    assert [frame["rep_number"] for frame in json.loads(parts[-1]["text"])["keyframes"]] == [1, 2]
