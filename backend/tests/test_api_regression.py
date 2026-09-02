import os
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


def test_root_and_unauthenticated_protection():
    root = requests.get(f"{BASE_URL}/api/", timeout=15)
    assert root.status_code == 200
    assert root.json()["message"] == "PKUCity attendance API"
    headers = {"Authorization": "Bearer invalid-test-token"}
    assert requests.get(f"{BASE_URL}/api/auth/me", headers=headers, timeout=15).status_code == 401
    assert requests.post(f"{BASE_URL}/api/liveness/session", headers=headers, timeout=15).status_code == 401
    assert requests.post(f"{BASE_URL}/api/liveness/verify", headers=headers, timeout=15).status_code == 401
    assert requests.post(f"{BASE_URL}/api/attendance", headers=headers, json={"action":"check_in","latitude":0,"longitude":0,"liveness_session_id":"invalid-session-123"}, timeout=15).status_code == 401
