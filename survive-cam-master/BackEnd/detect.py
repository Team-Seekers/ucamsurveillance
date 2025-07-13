# BackEnd/detect.py
# --- FINAL CORRECTED VERSION ---

import sys
import json
import cv2
import numpy as np
import base64
import os

# --- Human Detection Setup ---
try:
    # Initialize the HOG descriptor for full body detection
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    # Load the Haar Cascade classifier for face detection
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
        print(json.dumps({ 'error': f'Cascade file not found at {cascade_path}', 'human_detected': False }), file=sys.stderr)
        sys.exit(1)

    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        print(json.dumps({ 'error': 'Failed to load face cascade classifier', 'human_detected': False }), file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(json.dumps({ 'error': f'Error initializing detectors: {str(e)}', 'human_detected': False }), file=sys.stderr)
    sys.exit(1)

def base64_to_image(base64_string):
    """Converts a base64 string to an OpenCV image."""
    try:
        if 'base64,' in base64_string:
            base64_data = base64_string.split(',')[1]
        else:
            base64_data = base64_string
        
        base64_data = base64_data.strip()
        img_bytes = base64.b64decode(base64_data)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if image is None:
            raise ValueError("Failed to decode image data. Decoded image is None.")
        if image.size == 0:
            raise ValueError("Image has zero dimensions after decoding.")
        return image
    except Exception as e:
        raise ValueError(f'Error decoding base64 image: {str(e)}')

def detect_humans(image_data):
    try:
        image = base64_to_image(image_data)
        frame = image.copy()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # 1. Face Detection
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))

        # 2. Full Body Detection
        boxes, weights = hog.detectMultiScale(frame, winStride=(8, 8), padding=(16, 16), scale=1.05)

        human_detected = len(faces) > 0 or len(boxes) > 0
        
        # NOTE: You can disable drawing the debug image for better performance if not needed.
        # Draw face detections
        for (x, y, w, h) in faces:
            cv2.rectangle(frame, (x, y), (x+w, y+h), (255, 0, 0), 2)
            cv2.putText(frame, 'Face', (x, y-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)

        # Draw body detections
        for (x, y, w, h) in boxes:
            cv2.rectangle(frame, (x, y), (x+w, y+h), (0, 255, 0), 2)
            cv2.putText(frame, 'Body', (x, y-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        
        success, buffer = cv2.imencode('.jpg', frame)
        if not success:
            debug_image_b64 = ""
        else:
            debug_image_b64 = base64.b64encode(buffer).decode('utf-8')

        result = {
            'human_detected': human_detected,
            'face_count': len(faces),
            'body_count': len(boxes),
            'debug_image': f'data:image/jpeg;base64,{debug_image_b64}'
        }

        print(json.dumps(result))
        sys.stdout.flush()
        return result

    except Exception as e:
        error_result = {'error': f'Detection process error: {str(e)}', 'human_detected': False}
        print(json.dumps(error_result), file=sys.stderr)
        sys.stderr.flush()
        return error_result

if __name__ == "__main__":
    try:
        # --- THIS IS THE CORRECTED INPUT METHOD ---
        # Read all data from standard input (stdin)
        image_data = sys.stdin.read()
        
        if not image_data:
            print(json.dumps({
                'error': 'Empty image data received from stdin',
                'human_detected': False
            }), file=sys.stderr)
            sys.exit(1)

        result = detect_humans(image_data)
        
        if 'error' in result and result['error']:
            sys.exit(1) # Exit with error code if detection failed
        else:
            sys.exit(0) # Exit successfully

    except Exception as e:
        print(json.dumps({
            'error': f'Unhandled error in main script: {str(e)}',
            'human_detected': False
        }), file=sys.stderr)
        sys.exit(1)