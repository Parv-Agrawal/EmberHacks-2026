"""
Flask application factory.

Creates and configures the Flask app. Keeping this separate from run.py
means the app can be imported and tested without starting a dev server.
"""
from flask import Flask


def create_app():
    """Create and configure the Flask application."""
    app = Flask(__name__)

    from app.routes import main_bp
    app.register_blueprint(main_bp)

    return app
