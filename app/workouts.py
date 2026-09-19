"""Deterministic Phase 1 workout drafting from a deliberately small catalog."""
from copy import deepcopy
import math
import re
import uuid

from app.auth import APIError, short_string


CATALOG = {
    "squat": {
        "id": "squat", "name": "Bodyweight squat", "equipment": "bodyweight",
        "cue": "Stand with your feet comfortably apart and move within a comfortable range.",
    },
    "bicep_curl": {
        "id": "bicep_curl", "name": "Dumbbell bicep curl", "equipment": "dumbbells",
        "cue": "Keep your upper arms by your sides and use a comfortable weight.",
    },
}

GOALS = {"strength", "fitness", "confidence"}
EXPERIENCE = {"beginner", "intermediate", "experienced"}
EQUIPMENT = {"bodyweight", "dumbbells"}


def string_choice(value, choices, label):
    if not isinstance(value, str) or value not in choices:
        raise APIError(f"Choose a supported {label}.")
    return value


def choices_list(value, choices, label):
    if not isinstance(value, list) or len(value) > len(choices):
        raise APIError(f"Choose supported {label} values.")
    if any(not isinstance(item, str) or item not in choices for item in value):
        raise APIError(f"Choose supported {label} values.")
    if len(set(value)) != len(value):
        raise APIError(f"Do not repeat {label} values.")
    return set(value)


def restriction_exclusions(text):
    """Handle only simple movement/body-area exclusions; never infer a diagnosis.

    Unrecognized terms stop drafting even alongside a recognized body area. This
    prevents a phrase such as 'knee pain and dizziness' from silently being handled
    as only a squat restriction. Explicit avoidance controls remain authoritative.
    """
    text = text.lower().strip()
    if not text or re.fullmatch(r"(?:i have )?(?:no restrictions|none|no movements to avoid|n/a)[.! ]*", text):
        return set(), False
    tokens = set(re.findall(r"[a-z]+", text))
    squat_words = {"squat", "squats", "knee", "knees", "hip", "hips", "back", "leg", "legs"}
    curl_words = {"curl", "curls", "bicep", "biceps", "arm", "arms", "shoulder", "shoulders", "elbow", "elbows", "wrist", "wrists"}
    directional_words = {"lower", "upper", "body"}
    filler = {"i", "my", "a", "an", "the", "and", "or", "have", "has", "with", "for", "to", "of", "in", "on", "at", "am", "is", "are", "avoid", "avoiding", "do", "not", "no", "please", "because", "due", "pain", "painful", "sore", "soreness", "discomfort", "issue", "issues", "injury", "injuries", "injured", "sensitive", "sensitivity", "limited", "mobility", "movement", "movements", "restriction", "restrictions", "right", "left", "both", "old", "recovery", "recovering", "from", "dumbbell", "dumbbells"}
    exclusions = set()
    if tokens & squat_words:
        exclusions.add("squat")
    if tokens & curl_words:
        exclusions.add("bicep_curl")
    # Interpret shared nouns conservatively: "upper and lower body" and
    # "lower and upper body" exclude both movements. A directional word must
    # never disappear into filler and accidentally leave a movement available.
    unmatched_direction = False
    if "body" in tokens:
        if "lower" in tokens:
            exclusions.add("squat")
        if "upper" in tokens:
            exclusions.add("bicep_curl")
        unmatched_direction = not bool(tokens & {"lower", "upper"})
    else:
        # Common back-location qualifiers remain covered by the back exclusion.
        remaining = re.sub(r"\b(?:upper|lower)\s+back\b", "back", text)
        unmatched_direction = bool(re.search(r"\b(?:upper|lower)\b", remaining))
    unknown = unmatched_direction or bool(tokens - squat_words - curl_words - directional_words - filler)
    # Unsupported symbols/numbers may express clinically relevant detail. Ask for
    # a plain movement choice instead of pretending to interpret that detail.
    unknown = unknown or bool(re.search(r"[0-9]|[^a-z\s,.;:'’/()-]", text))
    return exclusions, unknown or not exclusions


def estimate_minutes(exercises):
    # Four seconds per controlled rep, rests between sets, and two minutes to set up.
    seconds = 120 + sum(item["sets"] * item["reps"] * 4 + (item["sets"] - 1) * item["rest_seconds"] for item in exercises)
    return math.ceil(seconds / 60)


def draft_workout(body):
    goal = string_choice(body["goal"], GOALS, "goal")
    experience = string_choice(body["experience"], EXPERIENCE, "experience level")
    minutes = body["minutes"]
    if type(minutes) is not int or minutes not in {10, 20, 30}:
        raise APIError("Choose 10, 20, or 30 available minutes.")
    equipment = choices_list(body["equipment"], EQUIPMENT, "equipment")
    avoid = choices_list(body["avoid"], set(CATALOG), "movements to avoid")
    restrictions = short_string(body["restrictions"], "Restrictions", 500, allow_empty=True)
    restricted, unclear = restriction_exclusions(restrictions)
    if unclear:
        return None, ["This small catalog cannot interpret that restriction. Select movements to avoid and edit the restriction text before drafting; choose a routine only if it fits your needs."]
    excluded = avoid | restricted
    warnings = []
    for exercise_id in sorted(excluded):
        warnings.append(f"{CATALOG[exercise_id]['name']} excluded based on your movement preferences or restrictions.")
    supported = [value for key, value in CATALOG.items() if key not in excluded and value["equipment"] in equipment]
    if "dumbbells" not in equipment and "bicep_curl" not in excluded:
        warnings.append("Bicep curls require dumbbells and were left out.")
    if not supported:
        warnings.append("No supported movements match these choices. Edit equipment or movement preferences only if appropriate for you.")
        return None, warnings
    reps = {"strength": 8, "fitness": 10, "confidence": 6}[goal]
    sets = 2 if experience == "beginner" or minutes == 10 else (4 if minutes == 30 and experience == "experienced" else 3)
    rest = 75 if goal == "strength" else 60
    exercises = [{"id": item["id"], "name": item["name"], "sets": sets, "reps": reps, "rest_seconds": rest, "cue": item["cue"]} for item in supported]
    while estimate_minutes(exercises) > minutes and any(item["sets"] > 1 for item in exercises):
        max(exercises, key=lambda item: item["sets"])["sets"] -= 1
    return {
        "id": uuid.uuid4().hex,
        "goal": goal,
        "experience": experience,
        "available_minutes": minutes,
        "estimated_minutes": estimate_minutes(exercises),
        "exercises": exercises,
    }, warnings


def confirm_workout(value, draft):
    if not draft:
        raise APIError("Draft a workout before confirming it.", 409, "draft_required")
    if not isinstance(value, dict) or set(value) - set(draft):
        raise APIError("Submit the workout returned by the draft step.")
    if value.get("id") != draft["id"]:
        raise APIError("This draft is no longer current. Draft your workout again.", 409, "stale_draft")
    exercises = value.get("exercises")
    if not isinstance(exercises, list) or not 1 <= len(exercises) <= len(draft["exercises"]):
        raise APIError("Keep at least one movement from your draft.")
    allowed = {item["id"]: item for item in draft["exercises"]}
    result = deepcopy(draft)
    result["exercises"] = []
    seen = set()
    for item in exercises:
        if not isinstance(item, dict) or set(item) - {"id", "name", "sets", "reps", "rest_seconds", "cue"}:
            raise APIError("A workout movement contains unsupported fields.")
        exercise_id = item.get("id")
        if not isinstance(exercise_id, str) or exercise_id not in allowed or exercise_id in seen:
            raise APIError("Only distinct movements included in your current draft can be confirmed.")
        seen.add(exercise_id)
        clean = deepcopy(allowed[exercise_id])
        for key, minimum, maximum in (("sets", 1, 4), ("reps", 4, 15), ("rest_seconds", 30, 120)):
            setting = item.get(key)
            if type(setting) is not int or not minimum <= setting <= maximum:
                raise APIError(f"{key.replace('_', ' ').capitalize()} must be a whole number from {minimum} to {maximum}.")
            clean[key] = setting
        result["exercises"].append(clean)
    result["estimated_minutes"] = estimate_minutes(result["exercises"])
    if result["estimated_minutes"] > draft["available_minutes"]:
        raise APIError("This workout exceeds your selected time. Reduce sets or reps, or choose more time.")
    return result
