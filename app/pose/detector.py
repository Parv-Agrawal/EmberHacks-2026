"""
Pose detection.

Wraps MediaPipe so the rest of the app never has to import mediapipe
directly. If you swap pose libraries later (MoveNet, OpenPose, a
client-side JS library), this is the only file that changes.
"""
import mediapipe as mp


class PoseDetector:
    """Extracts body landmarks from video frames using MediaPipe Pose."""

    def __init__(self, min_detection_confidence=0.5, min_tracking_confidence=0.5):
        self._mp_pose = mp.solutions.pose
        self._pose = self._mp_pose.Pose(
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
            # MediaPipe's own temporal smoothing. Try this before reaching
            # for optical flow -- it solves most jitter on its own.
            smooth_landmarks=True,
        )
        self.drawing_utils = mp.solutions.drawing_utils
        self.pose_connections = self._mp_pose.POSE_CONNECTIONS

    def find_landmarks(self, frame_bgr):
        """Run pose detection on one BGR frame (as returned by cv2.VideoCapture).

        Returns MediaPipe's pose_landmarks object, or None if no person
        was detected in the frame.
        """
        frame_rgb = frame_bgr[:, :, ::-1]  # BGR -> RGB, MediaPipe expects RGB
        results = self._pose.process(frame_rgb)
        return results.pose_landmarks
