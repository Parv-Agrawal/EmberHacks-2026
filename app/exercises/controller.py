# app/exercises/controller.py

class ExerciseController:
    """
    The Brain of the app. It holds the active exercise plugin
    and delegates the work to it.
    """
    def __init__(self):
        self.active_exercise = None

    def set_exercise(self, checker):
        """Swaps the current exercise plugin."""
        self.active_exercise = checker

    def get_feedback(self, landmarks):
        """Delegates processing to the current plugin."""
        if not self.active_exercise:
            return {
                "rep_count": 0,
                "is_correct_form": False,
                "message": "No exercise selected"
            }
        return self.active_exercise.evaluate(landmarks)