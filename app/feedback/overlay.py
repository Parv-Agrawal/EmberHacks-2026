"""
Drawing the visual feedback on each frame.
"""
import cv2
import mediapipe as mp

# Force import from the python.solutions sub-module which is reliable
from mediapipe.python.solutions import drawing_utils as _mp_drawing
from mediapipe.python.solutions import pose as _mp_pose

def draw_overlay(frame, landmarks, result):
    """Draw the pose skeleton and a feedback message onto the frame."""
    if landmarks:
        # Drawing the skeleton
        _mp_drawing.draw_landmarks(
            frame, 
            landmarks, 
            _mp_pose.POSE_CONNECTIONS
        )

    # Use a safe get for the dictionary result
    message = result.get("message", "No person detected") if result else "No person detected"
    is_correct = result.get("is_correct_form", False) if result else False
    color = (0, 200, 0) if is_correct else (0, 0, 220)

    cv2.putText(
        frame, message, (20, 40),
        cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2, cv2.LINE_AA,
    )
    return frame