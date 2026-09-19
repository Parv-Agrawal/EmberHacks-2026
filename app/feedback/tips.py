"""
Text tips and reference links shown alongside the video.

Kept as plain data for now -- easy to expand into a per-exercise
dict, or move into a JSON/YAML file, once there's more than one exercise.
"""

_TIPS = {
    "squat": {
        "cues": [
            "Keep your chest up and back flat.",
            "Push your knees out in line with your toes.",
            "Drive through your heels, not your toes.",
        ],
        # TODO: swap in a video you actually trust.
        "reference_video": "https://www.youtube.com/results?search_query=how+to+squat+with+correct+form",
    }
}


def get_tips(exercise_name):
    """Return the cue list and reference link for a given exercise."""
    return _TIPS.get(exercise_name, {"cues": [], "reference_video": None})
