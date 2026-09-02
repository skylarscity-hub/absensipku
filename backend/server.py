from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
import logging
import os
import uuid

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field


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


class SessionResponse(BaseModel):
    session_token: str
    user: UserPublic


class AttendanceCreate(BaseModel):
    action: Literal["check_in", "check_out"]
    latitude: float
    longitude: float
    face_verified: bool
    liveness_signal: str = Field(min_length=4, max_length=80)


class SettingsUpdate(BaseModel):
    office_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_meters: Optional[int] = Field(default=None, ge=50, le=5000)


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


async def get_settings() -> Dict[str, Any]:
    settings = await db.settings.find_one({"settings_id": "primary"}, {"_id": 0})
    if settings:
        return clean(settings)
    settings = {
        "settings_id": "primary",
        "office_name": "PKUCity Office",
        "latitude": -6.200000,
        "longitude": 106.816666,
        "radius_meters": 150,
        "updated_at": now_utc(),
    }
    await db.settings.insert_one(dict(settings))
    return settings


def distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius = 6371000
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return earth_radius * 2 * asin(sqrt(a))


@app.on_event("startup")
async def startup() -> None:
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.admin_requests.create_index("request_id", unique=True)
    await get_settings()


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
    role = existing.get("role", "employee") if existing else ("admin" if email.lower() == bootstrap_email else "employee")
    user_doc = {
        "user_id": existing.get("user_id", user_id) if existing else user_id,
        "email": email,
        "name": identity.get("name") or email.split("@")[0],
        "picture": identity.get("picture") or identity.get("avatar"),
        "role": role,
        "email_verified": True,
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


@api_router.get("/dashboard")
async def dashboard(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    settings = await get_settings()
    schedule = await db.schedule.find_one({"schedule_id": "weekly"}, {"_id": 0})
    schedule = clean(schedule) or {"schedule_id": "weekly", "check_in": "08:00", "check_out": "17:00", "grace_minutes": 15}
    today = now_utc().strftime("%Y-%m-%d")
    record = await db.attendance.find_one({"user_id": user["user_id"], "date": today}, {"_id": 0}, sort=[("created_at", -1)])
    return {"user": user, "settings": settings, "schedule": schedule, "today": clean(record), "server_time": now_utc()}


@api_router.get("/attendance", response_model=List[Dict[str, Any]])
async def attendance_history(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    records = await db.attendance.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return [clean(record) for record in records]


@api_router.post("/attendance")
async def create_attendance(payload: AttendanceCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    settings = await get_settings()
    distance = distance_meters(payload.latitude, payload.longitude, settings["latitude"], settings["longitude"])
    if distance > settings["radius_meters"]:
        return {"accepted": False, "reason": "geofence", "message": f"You are {round(distance)}m from the office. Move within {settings['radius_meters']}m."}
    if not payload.face_verified or payload.liveness_signal != "blink-and-smile":
        return {"accepted": False, "reason": "liveness", "message": "Face liveness check failed. Please retake the guided selfie."}
    record = {
        "attendance_id": f"att_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "date": now_utc().strftime("%Y-%m-%d"),
        "action": payload.action,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "distance_meters": round(distance),
        "verification": "verified",
        "created_at": now_utc(),
    }
    await db.attendance.insert_one(dict(record))
    return {"accepted": True, "record": record, "message": "Attendance recorded successfully."}


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
    settings = await get_settings()
    schedule = await db.schedule.find_one({"schedule_id": "weekly"}, {"_id": 0}) or {"schedule_id": "weekly", "check_in": "08:00", "check_out": "17:00", "grace_minutes": 15}
    requests = await db.admin_requests.find({"status": "pending"}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return {"settings": settings, "schedule": clean(schedule), "requests": [clean(item) for item in requests]}


@api_router.patch("/admin/settings")
async def update_settings(payload: SettingsUpdate, request: Request) -> Dict[str, Any]:
    await require_admin(request)
    updates = {key: value for key, value in payload.model_dump().items() if value is not None}
    updates["updated_at"] = now_utc()
    await db.settings.update_one({"settings_id": "primary"}, {"$set": updates}, upsert=True)
    return clean(await db.settings.find_one({"settings_id": "primary"}, {"_id": 0}))


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


app.include_router(api_router)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown_db_client() -> None:
    client.close()