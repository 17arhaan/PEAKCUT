#!/usr/bin/env python3
"""One-time fetch of the mediapipe BlazeFace short-range face detector model.

Run ONCE by the implementer; the output is committed to git (~230KB) so CI
and other machines never need network access to run face detection.

Source: official mediapipe model zoo, Apache License 2.0.
https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector
"""

import urllib.request
from pathlib import Path

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models" / "blaze_face_short_range.tflite"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(MODEL_URL, OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
