"""
Squat form checking.

This is where the actual "is this a good squat" logic lives. It's
intentionally left with placeholder thresholds -- tune these against
your own recorded squats before trusting the feedback.
"""
import math

from app.exercises.base import ExerciseChecker


def _angle(a, b, c):
    """Return the angle at point b, formed by points a-b-c, in degrees.

    Each point is an object with .x and .y (normalized 0-1 coordinates,
    which is what MediaPipe landmarks give you).
    """
    ang = math.degrees(
        math.atan2(c.y - b.y, c.x - b.x) - math.atan2(a.y - b.y, a.x - b.x)
    )
    return abs(ang) if abs(ang) <= 180 else 360 - abs(ang)


class SquatChecker(ExerciseChecker):
    """Tracks squat depth and rep count from a stream of landmarks."""

    # TODO: these are placeholder values. Record yourself doing a few
    # good and bad squats, print the actual knee angles, and adjust.
    STANDING_KNEE_ANGLE = 165
    BOTTOM_KNEE_ANGLE = 100

    def __init__(self):
        self._state = "standing"  # standing -> descending -> bottom -> ascending
        self.rep_count = 0

    def evaluate(self, landmarks):
        """Judge squat form for the current frame and update rep count."""
        mp_pose_landmarks = landmarks.landmark
        # NOTE: indices below follow MediaPipe's 33-point pose model.
        # Using the right leg here -- swap to LEFT_* if that suits your
        # setup better, or check both and use whichever is more visible.
        hip = mp_pose_landmarks[24]     # RIGHT_HIP
        knee = mp_pose_landmarks[26]    # RIGHT_KNEE
        ankle = mp_pose_landmarks[28]   # RIGHT_ANKLE

        knee_angle = _angle(hip, knee, ankle)

        # TODO: replace this with your real state machine (standing ->
        # descending -> bottom -> ascending) plus a back-angle check.
        # This placeholder only tracks depth via knee angle.
        is_correct_form = knee_angle <= self.BOTTOM_KNEE_ANGLE
        message = "Good depth" if is_correct_form else "Go lower"

        return {
            "rep_count": self.rep_count,
            "is_correct_form": is_correct_form,
            "knee_angle": round(knee_angle, 1),
            "message": message,
        }
