"""
Tests for app/pose/detector.py.

TODO: add real assertions once you have a sample image/frame with a
known pose to test against (see data/ for where to put fixtures).
"""
from app.pose.detector import PoseDetector


def test_pose_detector_initializes():
    """Sanity check that PoseDetector can be constructed without a webcam."""
    detector = PoseDetector()
    assert detector is not None
