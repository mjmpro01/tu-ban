"""Rebuild every game asset from assets/source/ into assets/game/ (+ previews in assets/preview/).

Usage:  pip install -r tools/requirements.txt && python tools/build_assets.py
"""
import compose_preview
import process_characters
import process_environment
import process_ui

if __name__ == "__main__":
    print("characters...")
    process_characters.main()
    print("environment...")
    process_environment.main()
    print("ui...")
    process_ui.main()
    print("preview scene...")
    compose_preview.main()
    print("done")
