"""
Shared interface for exercise checkers.

Every exercise (squat.py, and later deadlift.py, pushup.py, ...)
should implement this interface so routes.py can treat them
interchangeably.
"""
from abc import ABC, abstractmethod


class ExerciseChecker(ABC):
    """Base class for exercise-specific form checkers."""

    @abstractmethod
    def evaluate(self, landmarks):
        """Judge form from one frame's landmarks.

        Args:
            landmarks: MediaPipe pose_landmarks for a single frame.

        Returns:
            A dict describing the result, e.g.:
            {
                "rep_count": int,
                "is_correct_form": bool,
                "message": str,   # short feedback, e.g. "Go lower"
            }
        """
        raise NotImplementedError
