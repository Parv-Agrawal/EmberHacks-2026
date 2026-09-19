"""
Tests for app/exercises/squat.py.

TODO: build a fake "landmarks" object (or record a few real frames)
to test _angle() and SquatChecker.evaluate() without needing a webcam.
"""
import pytest

from app.exercises.squat import _angle


class _Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y


def test_angle_of_straight_line_is_180():
    """Three colinear points should measure a 180-degree angle."""
    a = _Point(0, 0)
    b = _Point(1, 0)
    c = _Point(2, 0)
    assert _angle(a, b, c) == pytest.approx(180, abs=1)
