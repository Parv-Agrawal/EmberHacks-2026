# app/routes.py

import cv2
from flask import Blueprint, Response, render_template

from app.pose.detector import PoseDetector
from app.exercises.controller import ExerciseController
from app.exercises.squat import SquatChecker
from app.feedback.overlay import draw_overlay
from app.feedback.tips import get_tips

main_bp = Blueprint("main", __name__)

# Initialize dependencies
detector = PoseDetector()
controller = ExerciseController()

# Set the active exercise
controller.set_exercise(SquatChecker())

def generate_frames():
    """Capture webcam frames, run the pipeline, and yield JPEG bytes."""
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        raise RuntimeError("Could not open webcam.")

    try:
        while True:
            success, frame = cap.read()
            if not success:
                break

            landmarks = detector.find_landmarks(frame)
            
            # Use the controller here
            result = controller.get_feedback(landmarks) if landmarks else None

            # draw_overlay now receives the dictionary result
            frame = draw_overlay(frame, landmarks, result)

            ok, buffer = cv2.imencode(".jpg", frame)
            if not ok:
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n"
            )
    finally:
        cap.release()

@main_bp.route("/")
def index():
    return render_template("index.html", tips=get_tips("squat"))

@main_bp.route("/video_feed")
def video_feed():
    return Response(
        generate_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )