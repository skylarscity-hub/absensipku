from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
import base64
import calendar
import csv
import hashlib
import io
import logging
import os
import secrets
import shutil
import tempfile
import uuid

import cv2
import httpx
import mediapipe as mp
import numpy as np
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]
app = FastAPI(title="PKUCity Attendance API")
api_router = APIRouter(prefix="/api")
logger = logging.getLogger("pkucity")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def clean(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not doc:
        return {}
    result = dict(doc)
    result.pop("_id", None)
    return result


class SessionRequest(BaseModel):
    session_id: str


class UserPublic(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None
    role: Literal["employee", "admin"] = "employee"
    email_verified: bool = True
    full_name: Optional[str] = None
    department: Optional[str] = None
    profile_complete: bool = False
    avatar: Optional[str] = None


class ProfileUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    department: str = Field(min_length=1, max_length=120)


class AdminUserUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    department: Optional[str] = Field(default=None, min_length=1, max_length=120)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    role: Optional[Literal["employee", "admin"]] = None


class AvatarUpload(BaseModel):
    image_base64: str = Field(min_length=32)


class LeaveCreate(BaseModel):
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    reason: str = Field(min_length=1, max_length=500)


class SessionResponse(BaseModel):
    session_token: str
    user: UserPublic


class AttendanceCreate(BaseModel):
    action: Literal["check_in", "check_out"]
    latitude: float
    longitude: float
    liveness_session_id: str = Field(min_length=12, max_length=120)


class OfficeCreate(BaseModel):
    office_name: str = Field(min_length=1, max_length=120)
    latitude: float
    longitude: float
    radius_meters: int = Field(default=100, ge=25, le=5000)
    active: bool = True


class OfficeUpdate(BaseModel):
    office_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_meters: Optional[int] = Field(default=None, ge=25, le=5000)
    active: Optional[bool] = None


class HolidayCreate(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    label: str = Field(min_length=1, max_length=120)


class ScheduleUpdate(BaseModel):
    check_in: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    check_out: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    grace_minutes: int = Field(default=15, ge=0, le=120)


async def get_current_user(request: Request) -> Dict[str, Any]:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = header[7:].strip()
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    expires_at = session.get("expires_at")
    if isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= now_utc():
            raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return clean(user)


async def require_admin(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def ensure_default_office() -> None:
    """Bootstrap first active office if none exists (migrates legacy settings.primary too)."""
    if await db.offices.count_documents({}) > 0:
        return
    legacy = await db.settings.find_one({"settings_id": "primary"}, {"_id": 0})
    office = {
        "office_id": f"off_{uuid.uuid4().hex[:12]}",
        "office_name": (legacy or {}).get("office_name", "PKUCity Office"),
        "latitude": (legacy or {}).get("latitude", -6.200000),
        "longitude": (legacy or {}).get("longitude", 106.816666),
        "radius_meters": (legacy or {}).get("radius_meters", 100),
        "active": True,
        "created_at": now_utc(),
        "updated_at": now_utc(),
    }
    await db.offices.insert_one(dict(office))


async def list_offices(active_only: bool = False) -> List[Dict[str, Any]]:
    query: Dict[str, Any] = {}
    if active_only:
        query["active"] = True
    docs = await db.offices.find(query, {"_id": 0}).sort("created_at", 1).to_list(200)
    return [clean(item) for item in docs]


async def get_schedule() -> Dict[str, Any]:
    schedule = await db.schedule.find_one({"schedule_id": "weekly"}, {"_id": 0})
    return clean(schedule) or {"schedule_id": "weekly", "check_in": "08:00", "check_out": "17:00", "grace_minutes": 15}


async def list_holidays(upcoming_only: bool = False) -> List[Dict[str, Any]]:
    query: Dict[str, Any] = {}
    if upcoming_only:
        query["date"] = {"$gte": now_utc().strftime("%Y-%m-%d")}
    docs = await db.holidays.find(query, {"_id": 0}).sort("date", 1).to_list(500)
    return [clean(item) for item in docs]


async def is_holiday(date_str: str) -> Optional[Dict[str, Any]]:
    return await db.holidays.find_one({"date": date_str}, {"_id": 0})


def distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius = 6371000
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return earth_radius * 2 * asin(sqrt(a))


def nearest_office(offices: List[Dict[str, Any]], lat: float, lon: float) -> Optional[Dict[str, Any]]:
    best: Optional[Dict[str, Any]] = None
    best_dist = float("inf")
    for office in offices:
        d = distance_meters(lat, lon, office["latitude"], office["longitude"])
        if d < best_dist:
            best_dist = d
            best = {**office, "distance_meters": round(d)}
    return best


LIVENESS_CHALLENGES = ("blink", "turn_left", "turn_right")
LIVENESS_MODEL_PATH = ROOT_DIR / "models" / "face_landmarker.task"


def extract_snapshot_data_url(video_path: str) -> Optional[str]:
    """Grab the middle frame of the video as a downscaled JPEG data URL (for admin proof)."""
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return None
    try:
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        target_index = max(0, total // 2)
        capture.set(cv2.CAP_PROP_POS_FRAMES, target_index)
        ok, frame = capture.read()
        if not ok or frame is None:
            return None
        h, w = frame.shape[:2]
        max_side = 480
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        ok, buffer_bytes = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
        if not ok:
            return None
        return f"data:image/jpeg;base64,{base64.b64encode(buffer_bytes.tobytes()).decode()}"
    finally:
        capture.release()


def eye_aspect_ratio(points: List[Any], indexes: List[int]) -> float:
    left, top_left, bottom_left, right, top_right, bottom_right = [points[index] for index in indexes]
    horizontal = max(float(np.linalg.norm(np.array([left.x, left.y]) - np.array([right.x, right.y]))), 1e-6)
    vertical_a = np.linalg.norm(np.array([top_left.x, top_left.y]) - np.array([bottom_left.x, bottom_left.y]))
    vertical_b = np.linalg.norm(np.array([top_right.x, top_right.y]) - np.array([bottom_right.x, bottom_right.y]))
    return float((vertical_a + vertical_b) / (2 * horizontal))


def analyze_liveness(video_path: str, expected: List[str]) -> Dict[str, Any]:
    if not LIVENESS_MODEL_PATH.exists():
        return {"passed": False, "reason": "liveness_model_unavailable", "events": [], "face_frames": 0}
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return {"passed": False, "reason": "invalid_video", "events": [], "face_frames": 0}
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    sample_every = max(1, int(fps / 15))
    frame_index = 0
    sampled_frames = 0
    face_frames = 0
    samples: List[Dict[str, float]] = []
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(LIVENESS_MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.6,
        min_face_presence_confidence=0.6,
        min_tracking_confidence=0.6,
    )
    try:
        with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
            while frame_index <= int(fps * 12):
                ok, frame = capture.read()
                if not ok:
                    break
                if frame_index % sample_every == 0:
                    sampled_frames += 1
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    result = detector.detect_for_video(image, int(frame_index * 1000 / fps))
                    if len(result.face_landmarks) == 1:
                        landmarks = result.face_landmarks[0]
                        left_ear = eye_aspect_ratio(landmarks, [33, 160, 144, 133, 158, 153])
                        right_ear = eye_aspect_ratio(landmarks, [362, 385, 380, 263, 387, 373])
                        nose = landmarks[1].x
                        cheek_center = (landmarks[234].x + landmarks[454].x) / 2
                        cheek_width = max(abs(landmarks[454].x - landmarks[234].x), 1e-5)
                        samples.append({"ear": (left_ear + right_ear) / 2, "yaw": (nose - cheek_center) / cheek_width})
                        face_frames += 1
                frame_index += 1
    except Exception as exc:
        logger.exception("Liveness analysis failed: %s", exc)
        return {"passed": False, "reason": "analysis_error", "events": [], "face_frames": face_frames}
    finally:
        capture.release()

    if len(samples) < 20 or sampled_frames == 0 or face_frames / sampled_frames < 0.65:
        return {"passed": False, "reason": "face_not_consistently_visible", "events": [], "face_frames": face_frames}
    events: List[str] = []
    blink_armed = False
    last_turn = ""
    for sample in samples:
        if sample["ear"] > 0.27:
            blink_armed = True
        if blink_armed and sample["ear"] < 0.20:
            events.append("blink")
            blink_armed = False
        turn = "turn_left" if sample["yaw"] < -0.09 else "turn_right" if sample["yaw"] > 0.09 else ""
        if turn and turn != last_turn:
            events.append(turn)
            last_turn = turn
        if not turn:
            last_turn = ""
    cursor = 0
    for event in events:
        if cursor < len(expected) and event == expected[cursor]:
            cursor += 1
    passed = cursor == len(expected)
    return {"passed": passed, "reason": None if passed else "challenge_failed", "events": events, "face_frames": face_frames}


@app.on_event("startup")
async def startup() -> None:
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.liveness_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.liveness_results.create_index("liveness_session_id", unique=True)
    await db.admin_requests.create_index("request_id", unique=True)
    await db.offices.create_index("office_id", unique=True)
    await db.holidays.create_index("date", unique=True)
    await db.leaves.create_index("leave_id", unique=True)
    await db.leaves.create_index([("user_id", 1), ("status", 1)])
    await ensure_default_office()


@api_router.get("/")
async def root() -> Dict[str, str]:
    return {"message": "PKUCity attendance API"}


@api_router.post("/auth/session", response_model=SessionResponse)
async def create_session(payload: SessionRequest) -> SessionResponse:
    try:
        async with httpx.AsyncClient(timeout=15) as http_client:
            response = await http_client.get(
                "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                headers={"X-Session-ID": payload.session_id},
            )
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Google verification failed")
        data = response.json()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Google session exchange failed: %s", exc)
        raise HTTPException(status_code=502, detail="Authentication service unavailable") from exc

    identity = data.get("user", data)
    email = identity.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Verified email was not returned")
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    bootstrap_email = os.getenv("PKUCITY_ADMIN_EMAIL", "").strip().lower()
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    # Bootstrap admin ALWAYS gets/keeps admin role on every login (even if the doc
    # was previously stored as employee). Everyone else keeps their existing role.
    if bootstrap_email and email.lower() == bootstrap_email:
        role = "admin"
    else:
        role = existing.get("role", "employee") if existing else "employee"
    user_doc = {
        "user_id": existing.get("user_id", user_id) if existing else user_id,
        "email": email,
        "name": (existing or {}).get("name") or identity.get("name") or email.split("@")[0],
        "picture": identity.get("picture") or identity.get("avatar") or (existing or {}).get("picture"),
        "role": role,
        "email_verified": True,
        "full_name": (existing or {}).get("full_name"),
        "department": (existing or {}).get("department"),
        "profile_complete": bool((existing or {}).get("profile_complete", False)),
        "updated_at": now_utc(),
    }
    await db.users.update_one({"email": email}, {"$set": user_doc, "$setOnInsert": {"created_at": now_utc()}}, upsert=True)
    session_token = data.get("session_token")
    if not session_token:
        raise HTTPException(status_code=401, detail="Authentication token was not returned")
    await db.user_sessions.update_one(
        {"session_token": session_token},
        {"$set": {"session_token": session_token, "user_id": user_doc["user_id"], "created_at": now_utc(), "expires_at": now_utc() + timedelta(days=7)}},
        upsert=True,
    )
    return SessionResponse(session_token=session_token, user=UserPublic(**clean(user_doc)))


@api_router.get("/auth/me", response_model=UserPublic)
async def me(request: Request) -> UserPublic:
    return UserPublic(**(await get_current_user(request)))


@api_router.patch("/profile", response_model=UserPublic)
async def update_profile(payload: ProfileUpdate, request: Request) -> UserPublic:
    user = await get_current_user(request)
    updates = {
        "full_name": payload.full_name.strip(),
        "department": payload.department.strip(),
        "name": payload.full_name.strip(),
        "profile_complete": True,
        "updated_at": now_utc(),
    }
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": updates})
    refreshed = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return UserPublic(**clean(refreshed))


@api_router.get("/dashboard")
async def dashboard(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    offices = await list_offices(active_only=True)
    schedule = await get_schedule()
    today = now_utc().strftime("%Y-%m-%d")
    holiday = await is_holiday(today)
    record = await db.attendance.find_one({"user_id": user["user_id"], "date": today}, {"_id": 0, "photo": 0}, sort=[("created_at", -1)])
    active_leave = await get_active_leave_for_today(user["user_id"], today)
    # Legacy field "settings" kept for backward-compatible frontend keys (uses first active office).
    primary = offices[0] if offices else {"office_name": "PKUCity Office", "latitude": 0.0, "longitude": 0.0, "radius_meters": 100}
    return {
        "user": user,
        "settings": primary,
        "offices": offices,
        "schedule": schedule,
        "today": clean(record),
        "holiday": clean(holiday) if holiday else None,
        "on_leave": active_leave,
        "server_time": now_utc(),
    }


@api_router.get("/attendance", response_model=List[Dict[str, Any]])
async def attendance_history(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    records = await db.attendance.find({"user_id": user["user_id"]}, {"_id": 0, "photo": 0}).sort("created_at", -1).to_list(100)
    return [clean(record) for record in records]


@api_router.post("/liveness/session")
async def create_liveness_session(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    session_id = f"live_{secrets.token_urlsafe(24)}"
    challenges = list(secrets.SystemRandom().sample(LIVENESS_CHALLENGES, len(LIVENESS_CHALLENGES)))
    await db.liveness_sessions.insert_one({
        "liveness_session_id": session_id,
        "user_id": user["user_id"],
        "challenges": challenges,
        "created_at": now_utc(),
        "expires_at": now_utc() + timedelta(minutes=3),
        "used": False,
    })
    return {"liveness_session_id": session_id, "steps": challenges, "expires_in": 180}


async def read_upload_limited(upload: UploadFile, limit: int = 12_000_000) -> bytes:
    data = bytearray()
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(status_code=413, detail="Liveness video is too large")
    return bytes(data)


@api_router.post("/liveness/verify")
async def verify_liveness(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    form = await request.form()
    liveness_session_id = form.get("liveness_session_id")
    video = form.get("video")
    if not isinstance(liveness_session_id, str) or not liveness_session_id or not hasattr(video, "read") or not hasattr(video, "content_type"):
        raise HTTPException(status_code=400, detail="Liveness session and video are required")
    liveness_session = await db.liveness_sessions.find_one_and_update(
        {"liveness_session_id": liveness_session_id, "user_id": user["user_id"], "used": False, "expires_at": {"$gt": now_utc()}},
        {"$set": {"used": True, "used_at": now_utc()}},
        {"_id": 0},
    )
    if not liveness_session:
        raise HTTPException(status_code=400, detail="Liveness session is invalid, expired, or already used")
    allowed_types = {"video/mp4", "video/quicktime", "video/webm", "application/octet-stream"}
    if video.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Unsupported liveness video type")
    video_data = await read_upload_limited(video)
    if not video_data:
        raise HTTPException(status_code=400, detail="Empty liveness video")
    work_dir = Path(tempfile.mkdtemp(prefix="pkucity-live-"))
    video_path = work_dir / "capture.video"
    try:
        video_path.write_bytes(video_data)
        verdict = analyze_liveness(str(video_path), liveness_session["challenges"])
        snapshot = extract_snapshot_data_url(str(video_path)) if verdict["passed"] else None
        result = {
            "liveness_session_id": liveness_session_id,
            "user_id": user["user_id"],
            "passed": verdict["passed"],
            "reason": verdict["reason"],
            "events": verdict["events"],
            "face_frames": verdict["face_frames"],
            "video_sha256": hashlib.sha256(video_data).hexdigest(),
            "snapshot": snapshot,
            "created_at": now_utc(),
            "attendance_used": False,
        }
        await db.liveness_results.insert_one(dict(result))
        result.pop("user_id", None)
        result.pop("video_sha256", None)
        result.pop("snapshot", None)  # keep out of API response; admin reads via report endpoint
        return clean(result)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@api_router.post("/attendance")
async def create_attendance(payload: AttendanceCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    today = now_utc().strftime("%Y-%m-%d")
    holiday = await is_holiday(today)
    if holiday:
        return {"accepted": False, "reason": "holiday", "message": f"Today is a holiday ({holiday.get('label')}). Attendance is not required."}
    offices = await list_offices(active_only=True)
    if not offices:
        return {"accepted": False, "reason": "no_office", "message": "No active office is configured. Please contact your admin."}
    nearest = nearest_office(offices, payload.latitude, payload.longitude)
    if not nearest or nearest["distance_meters"] > nearest["radius_meters"]:
        return {
            "accepted": False,
            "reason": "geofence",
            "message": f"You are {nearest['distance_meters']}m from '{nearest['office_name']}'. Move within {nearest['radius_meters']}m.",
        }
    liveness_result = await db.liveness_results.find_one_and_update(
        {"liveness_session_id": payload.liveness_session_id, "user_id": user["user_id"], "passed": True, "attendance_used": False},
        {"$set": {"attendance_used": True, "attendance_used_at": now_utc()}},
        {"_id": 0},
    )
    if not liveness_result:
        return {"accepted": False, "reason": "liveness", "message": "Face liveness verification failed or has already been used. Please record a new challenge video."}
    record = {
        "attendance_id": f"att_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_email": user.get("email"),
        "user_name": user.get("full_name") or user.get("name"),
        "department": user.get("department"),
        "date": today,
        "action": payload.action,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "distance_meters": nearest["distance_meters"],
        "office_id": nearest["office_id"],
        "office_name": nearest["office_name"],
        "verification": "verified",
        "photo": liveness_result.get("snapshot"),
        "created_at": now_utc(),
    }
    await db.attendance.insert_one(dict(record))
    # Do NOT return the base64 photo in the response — it's for admin proof only.
    response_record = {k: v for k, v in record.items() if k != "photo"}
    return {"accepted": True, "record": response_record, "message": f"Attendance recorded at '{nearest['office_name']}'."}


@api_router.post("/admin/request")
async def request_admin_access(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    if user.get("role") == "admin":
        return {"status": "approved", "message": "You already have admin access."}
    existing = await db.admin_requests.find_one({"user_id": user["user_id"], "status": "pending"}, {"_id": 0})
    if existing:
        return {"status": "pending", "message": "Your request is already waiting for approval."}
    request_doc = {"request_id": f"req_{uuid.uuid4().hex[:12]}", "user_id": user["user_id"], "email": user["email"], "name": user["name"], "status": "pending", "created_at": now_utc()}
    await db.admin_requests.insert_one(dict(request_doc))
    return {"status": "pending", "message": "Admin access request sent."}


@api_router.get("/admin/overview")
async def admin_overview(request: Request) -> Dict[str, Any]:
    await require_admin(request)
    offices = await list_offices()
    schedule = await get_schedule()
    requests = await db.admin_requests.find({"status": "pending"}, {"_id": 0}).sort("created_at", -1).to_list(50)
    holidays = await list_holidays()
    return {
        "settings": offices[0] if offices else {},
        "offices": offices,
        "schedule": schedule,
        "requests": [clean(item) for item in requests],
        "holidays": holidays,
    }


# ---- Multi-office admin endpoints ------------------------------------------------


@api_router.get("/admin/offices")
async def get_offices(request: Request) -> List[Dict[str, Any]]:
    await require_admin(request)
    return await list_offices()


@api_router.post("/admin/offices")
async def create_office(payload: OfficeCreate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    office = {
        "office_id": f"off_{uuid.uuid4().hex[:12]}",
        **payload.model_dump(),
        "created_at": now_utc(),
        "updated_at": now_utc(),
    }
    await db.offices.insert_one(dict(office))
    return clean(office)


@api_router.patch("/admin/offices/{office_id}")
async def update_office(office_id: str, payload: OfficeUpdate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = now_utc()
    result = await db.offices.find_one_and_update(
        {"office_id": office_id}, {"$set": updates}, {"_id": 0}, return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Office not found")
    return clean(result)


@api_router.delete("/admin/offices/{office_id}")
async def delete_office(office_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    active_count = await db.offices.count_documents({"active": True})
    target = await db.offices.find_one({"office_id": office_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Office not found")
    if target.get("active") and active_count <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last active office. Add another active office first.")
    await db.offices.delete_one({"office_id": office_id})
    return {"status": "deleted"}


# Backwards-compatible single-office patch (updates the first office).
@api_router.patch("/admin/settings")
async def update_settings(payload: OfficeUpdate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    offices = await list_offices()
    if not offices:
        raise HTTPException(status_code=400, detail="No office to update")
    return await update_office(offices[0]["office_id"], payload, request)


# ---- Holidays --------------------------------------------------------------------


@api_router.get("/admin/holidays")
async def get_holidays(request: Request) -> List[Dict[str, Any]]:
    await require_admin(request)
    return await list_holidays()


@api_router.post("/admin/holidays")
async def create_holiday(payload: HolidayCreate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    holiday = {
        "holiday_id": f"hol_{uuid.uuid4().hex[:12]}",
        **payload.model_dump(),
        "created_at": now_utc(),
    }
    try:
        await db.holidays.insert_one(dict(holiday))
    except Exception:
        raise HTTPException(status_code=409, detail="A holiday already exists for this date")
    return clean(holiday)


@api_router.delete("/admin/holidays/{holiday_id}")
async def delete_holiday(holiday_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    result = await db.holidays.delete_one({"holiday_id": holiday_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"status": "deleted"}


# ---- Schedule --------------------------------------------------------------------


@api_router.patch("/admin/schedule")
async def update_schedule(payload: ScheduleUpdate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    schedule = {"schedule_id": "weekly", **payload.model_dump(), "updated_at": now_utc()}
    await db.schedule.update_one({"schedule_id": "weekly"}, {"$set": schedule}, upsert=True)
    return schedule


@api_router.post("/admin/requests/{request_id}/approve")
async def approve_admin(request_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    access_request = await db.admin_requests.find_one({"request_id": request_id}, {"_id": 0})
    if not access_request:
        raise HTTPException(status_code=404, detail="Request not found")
    await db.users.update_one({"user_id": access_request["user_id"]}, {"$set": {"role": "admin", "updated_at": now_utc()}})
    await db.admin_requests.update_one({"request_id": request_id}, {"$set": {"status": "approved", "resolved_at": now_utc()}})
    return {"status": "approved"}


# ---- Admin users ----------------------------------------------------------------


@api_router.get("/admin/users")
async def admin_users(request: Request) -> List[Dict[str, Any]]:
    await require_admin(request)
    docs = await db.users.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [clean(item) for item in docs]


@api_router.patch("/admin/users/{user_id}", response_model=UserPublic)
async def admin_update_user(user_id: str, payload: AdminUserUpdate, request: Request) -> UserPublic:
    await require_admin(request)
    updates: Dict[str, Any] = {k: v.strip() if isinstance(v, str) else v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "full_name" in updates and "name" not in updates:
        updates["name"] = updates["full_name"]
    if "full_name" in updates or "department" in updates:
        updates["profile_complete"] = True
    updates["updated_at"] = now_utc()
    result = await db.users.update_one({"user_id": user_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    refreshed = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return UserPublic(**clean(refreshed))


# ---- Reports ---------------------------------------------------------------------


def _parse_date(value: Optional[str], fallback: str) -> str:
    if value and len(value) == 10:
        return value
    return fallback


async def _report_rows(request: Request, date_from: str, date_to: str) -> List[Dict[str, Any]]:
    await require_admin(request)
    cursor = db.attendance.find(
        {"date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0},
    ).sort("created_at", -1)
    docs = await cursor.to_list(2000)
    cleaned: List[Dict[str, Any]] = []
    for doc in docs:
        photo = doc.pop("photo", None)
        row = clean(doc)
        row["has_photo"] = bool(photo)
        cleaned.append(row)
    return cleaned


@api_router.get("/admin/reports")
async def admin_reports(request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Dict[str, Any]:
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)
    rows = await _report_rows(request, date_from, date_to)
    schedule = await get_schedule()
    check_out_hour, check_out_minute = [int(part) for part in schedule["check_out"].split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_end_minutes = check_out_hour * 60 + check_out_minute + grace

    summary: Dict[str, Dict[str, Any]] = {}
    # First pass: aggregate counts + overtime per (user, date)
    latest_checkout: Dict[str, Dict[str, datetime]] = {}
    for row in rows:
        key = row.get("user_id") or "unknown"
        bucket = summary.setdefault(key, {
            "user_id": key,
            "name": row.get("user_name") or row.get("user_email") or key,
            "email": row.get("user_email"),
            "check_ins": 0,
            "check_outs": 0,
            "overtime_minutes": 0,
            "last_action": None,
            "last_at": None,
        })
        if row.get("action") == "check_in":
            bucket["check_ins"] += 1
        elif row.get("action") == "check_out":
            bucket["check_outs"] += 1
            created_at = row.get("created_at")
            date_str = row.get("date")
            if isinstance(created_at, datetime) and date_str:
                per_day = latest_checkout.setdefault(key, {})
                if date_str not in per_day or created_at > per_day[date_str]:
                    per_day[date_str] = created_at
        created_at = row.get("created_at")
        if isinstance(created_at, datetime):
            iso = created_at.isoformat()
            if bucket["last_at"] is None or iso > bucket["last_at"]:
                bucket["last_at"] = iso
                bucket["last_action"] = row.get("action")
    # Second pass: overtime totals
    for user_id, dates in latest_checkout.items():
        total_overtime = 0
        for _, dt in dates.items():
            minutes_of_day = dt.hour * 60 + dt.minute
            diff = minutes_of_day - scheduled_end_minutes
            if diff > 0:
                total_overtime += diff
        if user_id in summary:
            summary[user_id]["overtime_minutes"] = total_overtime
    return {
        "date_from": date_from,
        "date_to": date_to,
        "total_rows": len(rows),
        "schedule": {"check_out": schedule["check_out"], "grace_minutes": grace},
        "summary": list(summary.values()),
        "rows": rows,
    }


@api_router.get("/admin/reports/export")
async def admin_reports_export(request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Response:
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)
    rows = await _report_rows(request, date_from, date_to)
    schedule = await get_schedule()
    ch, cm = [int(part) for part in schedule["check_out"].split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_end_minutes = ch * 60 + cm + grace
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Date", "Time (UTC)", "Name", "Email", "Department", "Action", "Office", "Distance (m)", "Overtime (min)", "Latitude", "Longitude", "Verification"])
    for row in rows:
        created_at = row.get("created_at")
        time_str = created_at.isoformat() if isinstance(created_at, datetime) else ""
        overtime = ""
        if row.get("action") == "check_out" and isinstance(created_at, datetime):
            diff = (created_at.hour * 60 + created_at.minute) - scheduled_end_minutes
            overtime = str(max(0, diff))
        writer.writerow([
            row.get("date", ""),
            time_str,
            row.get("user_name", ""),
            row.get("user_email", ""),
            row.get("department", ""),
            row.get("action", ""),
            row.get("office_name", ""),
            row.get("distance_meters", ""),
            overtime,
            row.get("latitude", ""),
            row.get("longitude", ""),
            row.get("verification", ""),
        ])
    csv_data = buffer.getvalue()
    filename = f"pkucity-attendance-{date_from}-to-{date_to}.csv"
    return Response(
        content=csv_data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api_router.get("/admin/reports/export.pdf")
async def admin_reports_export_pdf(request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Response:
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)
    rows = await _report_rows(request, date_from, date_to)
    schedule = await get_schedule()
    ch, cm = [int(part) for part in schedule["check_out"].split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_end_minutes = ch * 60 + cm + grace

    # Aggregate per user with overtime.
    summary: Dict[str, Dict[str, Any]] = {}
    latest_checkout: Dict[str, Dict[str, datetime]] = {}
    for row in rows:
        key = row.get("user_id") or "unknown"
        bucket = summary.setdefault(key, {
            "name": row.get("user_name") or row.get("user_email") or key,
            "email": row.get("user_email") or "",
            "department": row.get("department") or "",
            "check_ins": 0,
            "check_outs": 0,
            "overtime_minutes": 0,
        })
        if row.get("action") == "check_in":
            bucket["check_ins"] += 1
        elif row.get("action") == "check_out":
            bucket["check_outs"] += 1
            created_at = row.get("created_at")
            date_str = row.get("date")
            if isinstance(created_at, datetime) and date_str:
                per_day = latest_checkout.setdefault(key, {})
                if date_str not in per_day or created_at > per_day[date_str]:
                    per_day[date_str] = created_at
    for user_id, dates in latest_checkout.items():
        total = 0
        for _, dt in dates.items():
            diff = (dt.hour * 60 + dt.minute) - scheduled_end_minutes
            if diff > 0:
                total += diff
        summary[user_id]["overtime_minutes"] = total

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
    styles = getSampleStyleSheet()
    title_style = styles["Heading1"]
    title_style.textColor = colors.HexColor("#DC2626")
    body: List[Any] = []
    body.append(Paragraph("PKUCity Attendance Summary", title_style))
    body.append(Paragraph(f"Period: {date_from} → {date_to}", styles["Normal"]))
    body.append(Paragraph(f"Scheduled check-out: {schedule['check_out']} (+{grace} min grace) · {len(rows)} raw records · {len(summary)} employees", styles["Normal"]))
    body.append(Spacer(1, 8 * mm))

    table_data = [["Name", "Department", "Email", "Check-ins", "Check-outs", "Overtime"]]
    for user_id, bucket in summary.items():
        overtime_min = int(bucket.get("overtime_minutes", 0))
        overtime_label = f"{overtime_min // 60}h {overtime_min % 60}m" if overtime_min > 0 else "—"
        table_data.append([
            bucket["name"], bucket["department"], bucket["email"],
            str(bucket["check_ins"]), str(bucket["check_outs"]), overtime_label,
        ])
    if len(table_data) == 1:
        table_data.append(["No attendance records in range", "", "", "", "", ""])
    table = Table(table_data, hAlign="LEFT", colWidths=[35 * mm, 30 * mm, 55 * mm, 20 * mm, 20 * mm, 20 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DC2626")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FEF2F2")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#F3F4F6")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    body.append(table)
    body.append(Spacer(1, 6 * mm))
    body.append(Paragraph("Generated by PKUCity · confidential", styles["Italic"]))
    doc.build(body)
    pdf_bytes = buffer.getvalue()
    filename = f"pkucity-attendance-{date_from}-to-{date_to}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---- Attendance proof photo (admin) --------------------------------------------


@api_router.get("/admin/attendance/{attendance_id}/photo")
async def admin_attendance_photo(attendance_id: str, request: Request) -> Response:
    await require_admin(request)
    doc = await db.attendance.find_one({"attendance_id": attendance_id}, {"_id": 0, "photo": 1})
    if not doc or not doc.get("photo"):
        raise HTTPException(status_code=404, detail="Photo not found")
    photo = doc["photo"]
    if not isinstance(photo, str) or "," not in photo:
        raise HTTPException(status_code=404, detail="Photo not available")
    header, _, b64 = photo.partition(",")
    media_type = "image/jpeg"
    if header.startswith("data:") and ";" in header:
        media_type = header[5:header.index(";")]
    try:
        image_bytes = base64.b64decode(b64)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Photo is corrupted") from exc
    return Response(content=image_bytes, media_type=media_type)


# ---- Profile avatar -------------------------------------------------------------


def _validate_avatar_payload(data_url: str) -> str:
    if not data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Avatar must be a data URL image")
    _, _, b64 = data_url.partition(",")
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid avatar image") from exc
    if len(raw) > 800_000:
        raise HTTPException(status_code=413, detail="Avatar image must be < 800KB")
    return data_url


@api_router.patch("/profile/avatar", response_model=UserPublic)
async def update_avatar(payload: AvatarUpload, request: Request) -> UserPublic:
    user = await get_current_user(request)
    avatar = _validate_avatar_payload(payload.image_base64)
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"avatar": avatar, "updated_at": now_utc()}})
    refreshed = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return UserPublic(**clean(refreshed))


@api_router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: str, request: Request) -> Response:
    await get_current_user(request)  # auth only, any authenticated user can view avatars
    doc = await db.users.find_one({"user_id": user_id}, {"_id": 0, "avatar": 1})
    if not doc or not doc.get("avatar"):
        raise HTTPException(status_code=404, detail="Avatar not set")
    avatar = doc["avatar"]
    header, _, b64 = avatar.partition(",")
    media_type = "image/jpeg"
    if header.startswith("data:") and ";" in header:
        media_type = header[5:header.index(";")]
    try:
        raw = base64.b64decode(b64)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Avatar corrupted") from exc
    return Response(content=raw, media_type=media_type)


# ---- Leaves ---------------------------------------------------------------------


def _iter_date_range(start_date: str, end_date: str) -> List[str]:
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    if end < start:
        return []
    days: List[str] = []
    cursor = start
    while cursor <= end:
        days.append(cursor.strftime("%Y-%m-%d"))
        cursor += timedelta(days=1)
        if len(days) > 365:
            break
    return days


async def get_active_leave_for_today(user_id: str, date_str: str) -> Optional[Dict[str, Any]]:
    doc = await db.leaves.find_one(
        {"user_id": user_id, "status": "approved", "start_date": {"$lte": date_str}, "end_date": {"$gte": date_str}},
        {"_id": 0},
    )
    return clean(doc) if doc else None


@api_router.post("/leaves")
async def create_leave(payload: LeaveCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
    leave = {
        "leave_id": f"lv_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_email": user.get("email"),
        "user_name": user.get("full_name") or user.get("name"),
        "department": user.get("department"),
        "start_date": payload.start_date,
        "end_date": payload.end_date,
        "days": len(_iter_date_range(payload.start_date, payload.end_date)),
        "reason": payload.reason.strip(),
        "status": "pending",
        "created_at": now_utc(),
    }
    await db.leaves.insert_one(dict(leave))
    return clean(leave)


@api_router.get("/leaves")
async def list_my_leaves(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    docs = await db.leaves.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return [clean(doc) for doc in docs]


@api_router.get("/admin/leaves")
async def admin_list_leaves(request: Request, status: Optional[str] = None) -> List[Dict[str, Any]]:
    await require_admin(request)
    query: Dict[str, Any] = {}
    if status in {"pending", "approved", "rejected"}:
        query["status"] = status
    docs = await db.leaves.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [clean(doc) for doc in docs]


@api_router.post("/admin/leaves/{leave_id}/approve")
async def admin_approve_leave(leave_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    result = await db.leaves.update_one(
        {"leave_id": leave_id, "status": "pending"},
        {"$set": {"status": "approved", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Leave not found or already resolved")
    return {"status": "approved"}


@api_router.post("/admin/leaves/{leave_id}/reject")
async def admin_reject_leave(leave_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    result = await db.leaves.update_one(
        {"leave_id": leave_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Leave not found or already resolved")
    return {"status": "rejected"}


# ---- Monthly stats --------------------------------------------------------------


@api_router.get("/admin/stats")
async def admin_stats(request: Request, year: Optional[int] = None, month: Optional[int] = None) -> Dict[str, Any]:
    await require_admin(request)
    now = now_utc()
    year = year or now.year
    month = month or now.month
    days_in_month = calendar.monthrange(year, month)[1]
    date_from = f"{year:04d}-{month:02d}-01"
    date_to = f"{year:04d}-{month:02d}-{days_in_month:02d}"
    schedule = await get_schedule()
    ch, cm = [int(part) for part in schedule["check_in"].split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_start_minutes = ch * 60 + cm + grace

    docs = await db.attendance.find(
        {"date": {"$gte": date_from, "$lte": date_to}, "action": "check_in"},
        {"_id": 0, "photo": 0},
    ).to_list(5000)
    approved_leaves = await db.leaves.find(
        {"status": "approved", "start_date": {"$lte": date_to}, "end_date": {"$gte": date_from}},
        {"_id": 0},
    ).to_list(1000)
    holidays = await db.holidays.find({"date": {"$gte": date_from, "$lte": date_to}}, {"_id": 0}).to_list(200)
    holiday_set = {h["date"] for h in holidays}

    per_day: Dict[str, Dict[str, Any]] = {}
    for day_index in range(1, days_in_month + 1):
        key = f"{year:04d}-{month:02d}-{day_index:02d}"
        per_day[key] = {"date": key, "on_time": 0, "late": 0, "on_leave": 0, "holiday": key in holiday_set}

    seen: set = set()
    for row in docs:
        date_str = row.get("date")
        user_id = row.get("user_id")
        if not date_str or not user_id or date_str not in per_day:
            continue
        pair = (user_id, date_str)
        if pair in seen:
            continue  # count first check-in per user per day
        seen.add(pair)
        created_at = row.get("created_at")
        if isinstance(created_at, datetime):
            actual = created_at.hour * 60 + created_at.minute
            if actual <= scheduled_start_minutes:
                per_day[date_str]["on_time"] += 1
            else:
                per_day[date_str]["late"] += 1

    for leave in approved_leaves:
        for date_str in _iter_date_range(leave["start_date"], leave["end_date"]):
            if date_str in per_day:
                per_day[date_str]["on_leave"] += 1

    totals = {
        "on_time": sum(d["on_time"] for d in per_day.values()),
        "late": sum(d["late"] for d in per_day.values()),
        "on_leave": sum(d["on_leave"] for d in per_day.values()),
        "days_in_month": days_in_month,
    }
    return {
        "year": year,
        "month": month,
        "schedule": {"check_in": schedule["check_in"], "grace_minutes": grace},
        "totals": totals,
        "days": list(per_day.values()),
    }


app.include_router(api_router)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown_db_client() -> None:
    client.close()
