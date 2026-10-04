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
import time
import uuid

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
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

# Emergent-managed push notifications relay
PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)


class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str


async def send_push(recipients: List[str], data: Dict[str, Any], idempotency_key: Optional[str] = None) -> None:
    if not recipients:
        return
    if len(recipients) > 100:
        raise ValueError("max 100 recipients per /trigger call; chunk before sending")
    if "title" not in data or "message" not in data:
        raise ValueError("data must include title and message")
    payload: Dict[str, Any] = {"recipients": recipients, "data": data}
    if idempotency_key:
        payload["$idempotency_key"] = idempotency_key
    resp = await _push_client.post("/api/v1/push/trigger", json=payload)
    if resp.status_code == 401:
        raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def to_wib(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone(timedelta(hours=7)))

def format_minutes(total_minutes: int) -> str:
    sign = "-" if total_minutes < 0 else ""
    total_minutes = abs(int(total_minutes))
    return f"{sign}{total_minutes // 60} jam {total_minutes % 60} menit"


async def write_security_audit(
    user_id: str,
    event: str,
    *,
    outcome: str = "info",
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Write a privacy-minimized security/audit event.

    Never store passwords, bearer tokens, liveness videos, or raw GPS coordinates
    in this collection.
    """
    safe_metadata = dict(metadata or {})
    for forbidden_key in (
        "password",
        "token",
        "session_token",
        "video",
        "photo",
        "latitude",
        "longitude",
    ):
        safe_metadata.pop(forbidden_key, None)

    await db.security_audit.insert_one({
        "audit_id": f"aud_{uuid.uuid4().hex[:16]}",
        "user_id": user_id,
        "event": event,
        "outcome": outcome,
        "metadata": safe_metadata,
        "created_at": now_utc(),
    })


async def enforce_sensitive_rate_limit(
    user_id: str,
    action: str,
    *,
    limit: int,
    window_seconds: int,
) -> None:
    """Small Mongo-backed limiter for sensitive employee actions."""
    now = now_utc()
    cutoff = now - timedelta(seconds=window_seconds)
    count = await db.security_rate_events.count_documents({
        "user_id": user_id,
        "action": action,
        "created_at": {"$gte": cutoff},
    })
    if count >= limit:
        await write_security_audit(
            user_id,
            f"rate_limit:{action}",
            outcome="blocked",
            metadata={"limit": limit, "window_seconds": window_seconds},
        )
        raise HTTPException(
            status_code=429,
            detail="Terlalu banyak percobaan. Silakan tunggu sebentar lalu coba lagi.",
        )

    await db.security_rate_events.insert_one({
        "user_id": user_id,
        "action": action,
        "created_at": now,
        "expires_at": now + timedelta(days=1),
    })


async def enforce_password_attempt_limit(
    user_id: str,
    purpose: str,
    *,
    limit: int = 5,
    window_seconds: int = 900,
) -> None:
    """Block repeated password guessing for an authenticated account."""
    now = now_utc()
    cutoff = now - timedelta(seconds=window_seconds)
    count = await db.auth_failures.count_documents({
        "user_id": user_id,
        "purpose": purpose,
        "created_at": {"$gte": cutoff},
    })
    if count >= limit:
        await write_security_audit(
            user_id,
            "password_bruteforce_blocked",
            outcome="blocked",
            metadata={"purpose": purpose, "limit": limit},
        )
        raise HTTPException(
            status_code=429,
            detail="Terlalu banyak percobaan kata sandi. Coba lagi setelah 15 menit.",
        )


async def record_password_failure(user_id: str, purpose: str) -> None:
    now = now_utc()
    await db.auth_failures.insert_one({
        "user_id": user_id,
        "purpose": purpose,
        "created_at": now,
        "expires_at": now + timedelta(days=1),
    })
    await write_security_audit(
        user_id,
        "password_verify_failed",
        outcome="failed",
        metadata={"purpose": purpose},
    )


async def clear_password_failures(user_id: str, purpose: str) -> None:
    await db.auth_failures.delete_many({
        "user_id": user_id,
        "purpose": purpose,
    })


async def enforce_device_auth_rate_limit(device_id: str) -> None:
    """Rate-limit OAuth session exchange without storing the raw device ID."""
    digest = hashlib.sha256(device_id.encode("utf-8")).hexdigest()[:32]
    await enforce_sensitive_rate_limit(
        f"device:{digest}",
        "auth_session",
        limit=12,
        window_seconds=600,
    )


async def require_bootstrap_admin(request: Request) -> Dict[str, Any]:
    """Only the configured owner/bootstrap admin can grant admin privileges."""
    user = await require_admin(request)
    bootstrap_email = os.getenv("PKUCITY_ADMIN_EMAIL", "").strip().lower()
    if not bootstrap_email or str(user.get("email", "")).strip().lower() != bootstrap_email:
        await write_security_audit(
            user["user_id"],
            "admin_privilege_escalation_blocked",
            outcome="blocked",
        )
        raise HTTPException(
            status_code=403,
            detail="Hanya admin utama yang dapat memberikan akses administrator.",
        )
    return user


async def _find_unresolved_prior_checkout(
    user_id: str,
    today: str,
) -> Optional[Dict[str, Any]]:
    """Find the most recent prior date whose last approved attendance is Clock In."""
    start_date = (
        datetime.strptime(today, "%Y-%m-%d") - timedelta(days=31)
    ).strftime("%Y-%m-%d")

    rows = await db.attendance.find(
        {
            "user_id": user_id,
            "date": {"$gte": start_date, "$lt": today},
        },
        {"_id": 0, "date": 1, "action": 1, "created_at": 1},
    ).sort([("date", -1), ("created_at", -1)]).to_list(300)

    seen_dates = set()
    for row in rows:
        day = row.get("date")
        if not day or day in seen_dates:
            continue
        seen_dates.add(day)
        if row.get("action") == "check_in":
            pending_correction = await db.attendance_corrections.find_one(
                {
                    "user_id": user_id,
                    "date": day,
                    "action": "check_out",
                    "status": "pending",
                },
                {"_id": 0, "correction_id": 1, "created_at": 1},
                sort=[("created_at", -1)],
            )
            return {
                "date": day,
                "check_in_at": row.get("created_at"),
                "correction_pending": bool(pending_correction),
                "correction_id": (
                    pending_correction.get("correction_id")
                    if pending_correction
                    else None
                ),
            }
    return None


OVERTIME_SAFETY_END = "06:00"


def _local_clock(day: str, hhmm: str) -> datetime:
    hour, minute = [int(v) for v in hhmm.split(":", 1)]
    return datetime.strptime(day, "%Y-%m-%d").replace(
        hour=hour, minute=minute, second=0, microsecond=0,
        tzinfo=timezone(timedelta(hours=7)),
    )


def _overtime_cap_local(work_day: str) -> datetime:
    """Hard safety cap: approved overtime can run until 06:00 WIB the next day."""
    next_day = datetime.strptime(work_day, "%Y-%m-%d") + timedelta(days=1)
    return next_day.replace(
        hour=6, minute=0, second=0, microsecond=0,
        tzinfo=timezone(timedelta(hours=7)),
    )


def _approved_overtime_counted_end(actual_local: datetime, work_day: str) -> datetime:
    return min(actual_local, _overtime_cap_local(work_day))


async def _daily_attendance_map(user_id: str, date_from: str, date_to: str) -> Dict[str, Dict[str, datetime]]:
    """Return daily attendance using policy-counted checkout timestamps.

    Without approved overtime, checkout is capped at the configured schedule end.
    With approved overtime, checkout may count after work-end but is hard-capped at
    06:00 WIB on the following day.
    """
    docs = await db.attendance.find(
        {"user_id": user_id, "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "photo": 0},
    ).sort("created_at", 1).to_list(2000)
    schedule = await get_schedule()
    approved = await db.overtime_requests.find(
        {
            "user_id": user_id,
            "status": "approved",
            "date": {"$gte": date_from, "$lte": date_to},
        },
        {"_id": 0, "date": 1},
    ).to_list(1000)
    approved_dates = {item.get("date") for item in approved if item.get("date")}

    def local_clock(day: str, hhmm: str) -> datetime:
        hour, minute = [int(v) for v in hhmm.split(":", 1)]
        return datetime.strptime(day, "%Y-%m-%d").replace(
            hour=hour, minute=minute, second=0, microsecond=0,
            tzinfo=timezone(timedelta(hours=7)),
        )

    by_date: Dict[str, Dict[str, datetime]] = {}
    for doc in docs:
        date_str = doc.get("date")
        created_at = doc.get("created_at")
        if not date_str or not isinstance(created_at, datetime):
            continue
        wib = to_wib(created_at)
        bucket = by_date.setdefault(date_str, {})
        if doc.get("action") == "check_in" and "check_in" not in bucket:
            bucket["check_in"] = wib
        elif doc.get("action") == "check_out":
            if date_str in approved_dates:
                bucket["check_out"] = _approved_overtime_counted_end(wib, date_str)
            else:
                bucket["check_out"] = min(wib, local_clock(date_str, schedule.get("check_out", "17:00")))
    return by_date


async def _effective_attendance_timestamp(user_id: str, action: str, actual_utc: datetime, date_str: str) -> datetime:
    """Return the policy timestamp stored for attendance.

    Check-in keeps the actual capture time.
    Check-out without approved overtime is stored at no later than schedule end.
    Check-out with approved overtime stores the counted checkout time, capped at
    06:00 WIB on the following day. The checkout photo can still be captured later.
    """
    actual_utc = as_utc(actual_utc)
    if action != "check_out":
        return actual_utc

    approved = await db.overtime_requests.find_one(
        {"user_id": user_id, "date": date_str, "status": "approved"},
        {"_id": 0, "request_id": 1},
        sort=[("approved_at", -1)],
    )
    if approved:
        counted_local = _approved_overtime_counted_end(to_wib(actual_utc), date_str)
        return counted_local.astimezone(timezone.utc)

    schedule = await get_schedule()
    wib = timezone(timedelta(hours=7))
    hour, minute = [int(v) for v in schedule.get("check_out", "17:00").split(":", 1)]
    scheduled_end = datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=hour, minute=minute, second=0, microsecond=0, tzinfo=wib
    )
    actual_local = to_wib(actual_utc)
    return min(actual_local, scheduled_end).astimezone(timezone.utc)


def _counted_session_minutes(check_in: datetime, check_out: datetime, date_str: str, schedule: Dict[str, Any]) -> int:
    """Calculate counted minutes using actual break overlap, not a flat deduction."""
    if check_out <= check_in:
        return 0
    break_start = schedule.get("break_start", "12:00")
    break_end = schedule.get("break_end", "13:00")
    bh, bm = [int(v) for v in break_start.split(":", 1)]
    eh, em = [int(v) for v in break_end.split(":", 1)]
    base = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone(timedelta(hours=7)))
    break_from = base.replace(hour=bh, minute=bm, second=0, microsecond=0)
    break_to = base.replace(hour=eh, minute=em, second=0, microsecond=0)
    raw = int((check_out - check_in).total_seconds() // 60)
    overlap_start = max(check_in, break_from)
    overlap_end = min(check_out, break_to)
    break_minutes = max(0, int((overlap_end - overlap_start).total_seconds() // 60))
    return max(raw - break_minutes, 0)

def _month_bounds_utc(year: int, month: int) -> tuple[datetime, datetime]:
    """Return UTC boundaries for a calendar month in WIB."""
    wib = timezone(timedelta(hours=7))

    start_local = datetime(year, month, 1, tzinfo=wib)

    if month == 12:
        next_local = datetime(year + 1, 1, 1, tzinfo=wib)
    else:
        next_local = datetime(year, month + 1, 1, tzinfo=wib)

    return (
        start_local.astimezone(timezone.utc),
        next_local.astimezone(timezone.utc),
    )

async def _calculate_work_time(
    user_id: str,
    year: int,
    month: int,
) -> Dict[str, Any]:
    """Calculate monthly work time in WIB.

    Rules:
    - Check-in starts a session and check-out closes it.
    - Break is deducted only for the actual overlap with the configured break window.
    - Regular work is capped at the configured work-end time.
    - Time after work-end counts only when an overtime request for that WIB date is approved.
    - Approved overtime has no requested end-time, but has a hard safety cap at
      06:00 WIB on the following day.
    - An open session is calculated live without waiting for check-out.
    """
    start_utc, end_utc = _month_bounds_utc(year, month)
    schedule = await get_schedule()
    break_start = schedule.get("break_start", "12:00")
    break_end = schedule.get("break_end", "13:00")
    work_end = schedule.get("check_out", "17:00")

    docs = await db.attendance.find(
        {
            "user_id": user_id,
            "created_at": {"$gte": start_utc, "$lt": end_utc},
            "action": {"$in": ["check_in", "check_out"]},
        },
        {"_id": 0, "photo": 0},
    ).sort("created_at", 1).to_list(5000)

    month_start_date = to_wib(start_utc).strftime("%Y-%m-%d")
    month_end_date = (to_wib(end_utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    approved_requests = await db.overtime_requests.find(
        {
            "user_id": user_id,
            "status": "approved",
            "date": {"$gte": month_start_date, "$lte": month_end_date},
        },
        {"_id": 0, "date": 1, "approved_at": 1},
    ).sort("approved_at", 1).to_list(1000)
    approved_overtime_days = {item.get("date") for item in approved_requests if item.get("date")}

    def local_clock(day: str, hhmm: str) -> datetime:
        hour, minute = [int(v) for v in hhmm.split(":", 1)]
        return datetime.strptime(day, "%Y-%m-%d").replace(
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
            tzinfo=timezone(timedelta(hours=7)),
        )

    def split_session_seconds(session_start_utc: datetime, session_end_utc: datetime, work_day: str) -> tuple[int, int]:
        start_local = to_wib(session_start_utc)
        end_local = to_wib(session_end_utc)
        scheduled_end = local_clock(work_day, work_end)

        overtime_approved = work_day in approved_overtime_days
        allowed_end = _overtime_cap_local(work_day) if overtime_approved else scheduled_end

        capped_end = min(end_local, allowed_end)
        if capped_end <= start_local:
            return 0, 0

        regular_end = min(capped_end, scheduled_end)
        regular_seconds = 0
        if regular_end > start_local:
            raw_seconds = max(0, int((regular_end - start_local).total_seconds()))
            break_from = local_clock(work_day, break_start)
            break_to = local_clock(work_day, break_end)
            overlap_start = max(start_local, break_from)
            overlap_end = min(regular_end, break_to)
            break_seconds = max(0, int((overlap_end - overlap_start).total_seconds()))
            regular_seconds = max(raw_seconds - break_seconds, 0)

        overtime_start = max(start_local, scheduled_end)
        overtime_seconds = 0
        if overtime_approved and capped_end > overtime_start:
            overtime_seconds = max(0, int((capped_end - overtime_start).total_seconds()))

        return regular_seconds, overtime_seconds

    completed_regular_seconds = 0
    completed_overtime_seconds = 0
    worked_days = set()
    open_check_in: Optional[datetime] = None
    open_check_in_day: Optional[str] = None

    for doc in docs:
        created_at = doc.get("created_at")
        action = doc.get("action")
        if not isinstance(created_at, datetime):
            continue
        created_at_utc = as_utc(created_at)
        day = to_wib(created_at_utc).strftime("%Y-%m-%d")

        if action == "check_in":
            if open_check_in is None:
                open_check_in = created_at_utc
                open_check_in_day = day
        elif action == "check_out" and open_check_in is not None:
            if created_at_utc > open_check_in:
                work_day = open_check_in_day or day
                regular_seconds, overtime_seconds = split_session_seconds(open_check_in, created_at_utc, work_day)
                completed_regular_seconds += regular_seconds
                completed_overtime_seconds += overtime_seconds
                if regular_seconds > 0 or overtime_seconds > 0:
                    worked_days.add(work_day)
            open_check_in = None
            open_check_in_day = None

    now = now_utc()
    now_wib = to_wib(now)
    today_wib = now_wib.strftime("%Y-%m-%d")
    selected_is_current_month = year == now_wib.year and month == now_wib.month

    active = False
    active_since: Optional[str] = None
    active_regular_seconds = 0
    active_overtime_seconds = 0
    missing_checkout = False
    overtime_approved_until: Optional[str] = None

    previous_wib = (now_wib.date() - timedelta(days=1)).strftime("%Y-%m-%d")
    active_open_day = (
        open_check_in_day == today_wib
        or (open_check_in_day == previous_wib and open_check_in_day in approved_overtime_days)
    )
    if selected_is_current_month and open_check_in is not None and open_check_in_day and active_open_day:
        active = True
        active_since = open_check_in.isoformat()
        active_regular_seconds, active_overtime_seconds = split_session_seconds(open_check_in, now, open_check_in_day)
        overtime_approved = open_check_in_day in approved_overtime_days
        scheduled_end = local_clock(open_check_in_day, work_end)
        safety_end = _overtime_cap_local(open_check_in_day) if overtime_approved else scheduled_end
        missing_checkout = now_wib > safety_end
        if active_regular_seconds > 0 or active_overtime_seconds > 0:
            worked_days.add(open_check_in_day)

    completed_seconds = completed_regular_seconds + completed_overtime_seconds
    active_seconds = active_regular_seconds + active_overtime_seconds
    regular_seconds = completed_regular_seconds + active_regular_seconds
    overtime_seconds = completed_overtime_seconds + active_overtime_seconds
    total_seconds = completed_seconds + active_seconds

    # Tell Admin Work Time whether it can safely tick locally between backend refreshes.
    counting_now = False
    counting_until: Optional[str] = None
    if active and open_check_in_day:
        current_local = now_wib
        scheduled_end = local_clock(open_check_in_day, work_end)
        break_from = local_clock(open_check_in_day, break_start)
        break_to = local_clock(open_check_in_day, break_end)
        overtime_approved = open_check_in_day in approved_overtime_days
        safety_end = _overtime_cap_local(open_check_in_day) if overtime_approved else scheduled_end

        if current_local < safety_end:
            if current_local < scheduled_end:
                # Regular work: do not tick during the configured break overlap.
                if break_from <= current_local < break_to:
                    counting_now = False
                    counting_until = break_to.astimezone(timezone.utc).isoformat()
                else:
                    counting_now = True
                    boundary = scheduled_end
                    if current_local < break_from < scheduled_end:
                        boundary = min(boundary, break_from)
                    counting_until = boundary.astimezone(timezone.utc).isoformat()
            elif overtime_approved:
                counting_now = True
                counting_until = safety_end.astimezone(timezone.utc).isoformat()

    return {
        "year": year,
        "month": month,

        # Second-precision authoritative fields.
        "completed_seconds": completed_seconds,
        "completed_regular_seconds": completed_regular_seconds,
        "completed_overtime_seconds": completed_overtime_seconds,
        "active_seconds": active_seconds,
        "active_regular_seconds": active_regular_seconds,
        "active_overtime_seconds": active_overtime_seconds,
        "regular_seconds": regular_seconds,
        "overtime_seconds": overtime_seconds,
        "total_seconds": total_seconds,
        "counting_now": counting_now,
        "counting_until": counting_until,

        # Backward-compatible minute fields used by the existing Home/Reports UI.
        "completed_minutes": completed_seconds // 60,
        "completed_regular_minutes": completed_regular_seconds // 60,
        "completed_overtime_minutes": completed_overtime_seconds // 60,
        "active_minutes": active_seconds // 60,
        "active_regular_minutes": active_regular_seconds // 60,
        "active_overtime_minutes": active_overtime_seconds // 60,
        "regular_minutes": regular_seconds // 60,
        "overtime_minutes": overtime_seconds // 60,
        "total_minutes": total_seconds // 60,

        "active": active,
        "active_since": active_since,
        "missing_checkout": missing_checkout,
        "overtime_approved_until": None,
        "days_worked": len(worked_days),
    }


def clean(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not doc:
        return {}
    result = dict(doc)
    result.pop("_id", None)
    return result


class SessionRequest(BaseModel):
    access_token: str = Field(min_length=20, max_length=4096)
    device_id: str = Field(min_length=12, max_length=160)


class PasswordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Verification stays backward-compatible with legacy passwords.
    password: str = Field(min_length=6, max_length=128)


class PasswordSetupBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # New passwords use a stronger minimum length. Existing hashes remain valid.
    password: str = Field(min_length=10, max_length=128)


class UserPublic(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None
    role: Literal["employee", "admin"] = "employee"
    email_verified: bool = True
    full_name: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    annual_leave_quota: int = 12
    profile_complete: bool = False
    avatar: Optional[str] = None
    account_status: Literal["pending", "approved", "rejected"] = "approved"
    password_set: bool = False


class ProfileUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    department: Optional[str] = Field(default=None, min_length=1, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=40)
    address: Optional[str] = Field(default=None, max_length=500)
    emergency_contact_name: Optional[str] = Field(default=None, max_length=120)
    emergency_contact_phone: Optional[str] = Field(default=None, max_length=40)


class AdminUserUpdate(BaseModel):
    # Forbid mass-assignment attempts such as role/password injection.
    model_config = ConfigDict(extra="forbid")

    full_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    department: Optional[str] = Field(default=None, min_length=1, max_length=120)
    employee_id: Optional[str] = Field(default=None, min_length=1, max_length=50)
    phone: Optional[str] = Field(default=None, max_length=40)
    address: Optional[str] = Field(default=None, max_length=500)
    emergency_contact_name: Optional[str] = Field(default=None, max_length=120)
    emergency_contact_phone: Optional[str] = Field(default=None, max_length=40)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    annual_leave_quota: Optional[int] = Field(default=None, ge=0, le=365)


class AvatarUpload(BaseModel):
    image_base64: str = Field(min_length=32)


class AttachmentPayload(BaseModel):
    file_name: str = Field(min_length=1, max_length=180)
    mime_type: str = Field(min_length=3, max_length=120)
    data_base64: str = Field(min_length=16)


class LeaveCreate(BaseModel):
    leave_type: Literal["annual", "sick", "permission", "business_trip"] = "annual"
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    reason: str = Field(min_length=1, max_length=500)
    attachment: Optional[AttachmentPayload] = None
    attachment_url: Optional[str] = Field(default=None, max_length=1000)


class AttendanceCorrectionCreate(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    action: Literal["check_in", "check_out"]
    requested_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    reason: str = Field(min_length=1, max_length=500)
    attachment: Optional[AttachmentPayload] = None
    attachment_url: Optional[str] = Field(default=None, max_length=1000)


class AnnouncementCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=4000)
    active: bool = True


class PolicyCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=8000)
    active: bool = True


class SessionResponse(BaseModel):
    session_token: str
    user: UserPublic


class AttendanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["check_in", "check_out"]
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    liveness_session_id: str = Field(
        min_length=12,
        max_length=120,
        pattern=r"^live_[A-Za-z0-9_-]+$",
    )


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
    break_start: str = Field(default="12:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    break_end: str = Field(default="13:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    check_out: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    grace_minutes: int = Field(default=15, ge=0, le=120)


class OvertimeRequestCreate(BaseModel):
    # Backward-compatible only. The value is ignored: once approved, overtime
    # counts until the employee actually checks out.
    end_time: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    reason: str = Field(min_length=1, max_length=500)


class EarlyLeaveRequestCreate(BaseModel):
    reason: str = Field(min_length=3, max_length=500)



PASSWORD_ITERATIONS = 600_000
SESSION_IDLE_MINUTES = 10

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"

def verify_password(password: str, stored: Optional[str]) -> bool:
    if not stored:
        return False
    try:
        algo, iterations, salt_b64, digest_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return secrets.compare_digest(actual, expected)
    except Exception:
        return False

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://tzgpmpiavwnealdtjnub.supabase.co").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()


async def get_supabase_user(access_token: str) -> Dict[str, Any]:
    if not SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="SUPABASE_ANON_KEY belum dikonfigurasi di backend")
    try:
        async with httpx.AsyncClient(timeout=12) as http_client:
            response = await http_client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {access_token}",
                },
            )
    except Exception as exc:
        logger.exception("Supabase Auth verification failed: %s", exc)
        raise HTTPException(status_code=502, detail="Authentication service unavailable") from exc

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Sesi login tidak valid atau sudah berakhir")

    data = response.json()
    user = data.get("user") if isinstance(data, dict) else None
    if not isinstance(user, dict) or not user.get("id") or not user.get("email"):
        raise HTTPException(status_code=401, detail="Identitas pengguna tidak ditemukan")
    return user


async def get_session_user(request: Request, require_unlock: bool = False, touch: bool = False) -> tuple[Dict[str, Any], Dict[str, Any]]:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = header[7:].strip()
    if len(token) < 20 or len(token) > 4096 or any(ch.isspace() for ch in token):
        raise HTTPException(status_code=401, detail="Session tidak valid")

    supabase_user = await get_supabase_user(token)
    supabase_user_id = str(supabase_user["id"])
    email = str(supabase_user.get("email", "")).strip().lower()

    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    user = None
    if session:
        user = await db.users.find_one({"user_id": session.get("user_id")}, {"_id": 0})

    if not user:
        user = await db.users.find_one(
            {"$or": [{"supabase_user_id": supabase_user_id}, {"email": email}]},
            {"_id": 0},
        )

    if not user:
        raise HTTPException(status_code=401, detail="User profile belum terdaftar")

    if user.get("supabase_user_id") != supabase_user_id:
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$set": {"supabase_user_id": supabase_user_id, "updated_at": now_utc()}},
        )
        user["supabase_user_id"] = supabase_user_id

    if user.get("account_status", "approved") != "approved":
        raise HTTPException(
            status_code=403,
            detail="Account is waiting for admin approval"
            if user.get("account_status") == "pending"
            else "Account access was rejected",
        )

    if not session:
        previous_session = await db.user_sessions.find_one(
            {"user_id": user["user_id"]},
            {"_id": 0},
            sort=[("last_activity_at", -1), ("created_at", -1)],
        )
        session = {
            "session_token": token,
            "user_id": user["user_id"],
            "device_id": user.get("active_device_id"),
            "created_at": now_utc(),
            "expires_at": now_utc() + timedelta(days=7),
            "unlocked_until": (previous_session or {}).get("unlocked_until"),
            "last_activity_at": (previous_session or {}).get("last_activity_at"),
        }
        await db.user_sessions.update_one(
            {"session_token": token},
            {"$set": session},
            upsert=True,
        )
    else:
        expires_at = session.get("expires_at")
        if isinstance(expires_at, datetime) and as_utc(expires_at) <= now_utc():
            raise HTTPException(status_code=401, detail="Session expired")

    active_device_id = user.get("active_device_id")
    session_device_id = session.get("device_id")
    if active_device_id and session_device_id != active_device_id:
        raise HTTPException(status_code=401, detail="This account is signed in on another device")

    if require_unlock:
        unlocked_until = session.get("unlocked_until")
        if not isinstance(unlocked_until, datetime):
            raise HTTPException(status_code=423, detail="Password required")
        unlocked_until = as_utc(unlocked_until)
        if unlocked_until <= now_utc():
            raise HTTPException(status_code=423, detail="Password required")
        if touch:
            next_unlock = now_utc() + timedelta(minutes=SESSION_IDLE_MINUTES)
            await db.user_sessions.update_one(
                {"session_token": token},
                {"$set": {"unlocked_until": next_unlock, "last_activity_at": now_utc()}},
            )
            session["unlocked_until"] = next_unlock

    return clean(user), clean(session)

async def get_current_user(request: Request) -> Dict[str, Any]:
    user, _ = await get_session_user(request, require_unlock=True, touch=True)
    return user


async def require_admin(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    if user.get("role") != "admin":
        await write_security_audit(
            user["user_id"],
            "admin_access_denied",
            outcome="blocked",
            metadata={"path": request.url.path},
        )
        raise HTTPException(status_code=403, detail="Akses admin diperlukan")
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
    if schedule:
        result = clean(schedule)
        # Backward-compatible defaults for old schedule documents.
        result.setdefault("check_in", "08:00")
        result.setdefault("break_start", "12:00")
        result.setdefault("break_end", "13:00")
        result.setdefault("check_out", "17:00")
        result.setdefault("grace_minutes", 15)
        return result
    return {
        "schedule_id": "weekly",
        "check_in": "08:00",
        "break_start": "12:00",
        "break_end": "13:00",
        "check_out": "17:00",
        "grace_minutes": 15,
    }


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


LIVENESS_CHALLENGES = ("rgb_flash",)
RGB_FLASH_COLORS = ("red", "green", "blue")
RGB_FLASH_PHASE_SECONDS = 0.95
RGB_FLASH_MIN_RESPONSE = 1.2
RGB_FLASH_MIN_BRIGHTNESS = 10.0


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


def _snapshot_data_url_from_frame(frame: Optional[np.ndarray]) -> Optional[str]:
    """Encode an already-decoded camera frame for attendance proof."""
    if frame is None or frame.size == 0:
        return None
    h, w = frame.shape[:2]
    max_side = 480
    if max(h, w) > max_side:
        scale = max_side / max(h, w)
        frame = cv2.resize(
            frame,
            (max(1, int(w * scale)), max(1, int(h * scale))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buffer_bytes = cv2.imencode(
        ".jpg",
        frame,
        [int(cv2.IMWRITE_JPEG_QUALITY), 76],
    )
    if not ok:
        return None
    return f"data:image/jpeg;base64,{base64.b64encode(buffer_bytes.tobytes()).decode()}"


def _center_face_crop_rgb(frame_bgr: np.ndarray) -> np.ndarray:
    """Return a portrait-oriented center crop matching the on-screen face guide.

    RGB Flash expects an aligned RGB face crop at 224x224. We first try the
    OpenCV bundled Haar detector when available; if that asset is missing in a
    production container, we fall back to the same central region shown by the
    camera UI instead of failing the whole liveness flow.
    """
    height, width = frame_bgr.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("empty_frame")

    x1 = y1 = x2 = y2 = None
    try:
        cascade_root = getattr(cv2.data, "haarcascades", "")
        cascade_path = f"{cascade_root}haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if not cascade.empty():
            gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(
                gray,
                scaleFactor=1.12,
                minNeighbors=5,
                minSize=(max(70, int(min(width, height) * 0.16)),) * 2,
            )
            if len(faces):
                x, y, w, h = max(faces, key=lambda rect: int(rect[2]) * int(rect[3]))
                pad_x = int(w * 0.32)
                pad_top = int(h * 0.38)
                pad_bottom = int(h * 0.24)
                x1 = max(0, int(x) - pad_x)
                x2 = min(width, int(x + w) + pad_x)
                y1 = max(0, int(y) - pad_top)
                y2 = min(height, int(y + h) + pad_bottom)
    except Exception as exc:
        logger.debug("Optional Haar face crop unavailable: %s", exc)

    if None in (x1, y1, x2, y2) or x2 <= x1 or y2 <= y1:
        crop_w = int(width * 0.62)
        crop_h = int(height * 0.68)
        x1 = max(0, (width - crop_w) // 2)
        x2 = min(width, x1 + crop_w)
        y1 = max(0, int(height * 0.12))
        y2 = min(height, y1 + crop_h)

    crop_bgr = frame_bgr[y1:y2, x1:x2]
    if crop_bgr.size == 0:
        raise ValueError("face_crop_empty")
    crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    # RGB Flash usage expects an RGB 224x224 face crop. Keep uint8 pixels;
    # the detector owns its own normalization/preprocessing.
    return cv2.resize(crop_rgb, (224, 224), interpolation=cv2.INTER_AREA).astype(np.uint8)


def _central_face_crop(frame: np.ndarray) -> np.ndarray:
    """Crop the same central region shown by the mobile face guide."""
    h, w = frame.shape[:2]
    crop_w = max(80, int(w * 0.56))
    crop_h = max(100, int(h * 0.60))
    x1 = max(0, (w - crop_w) // 2)
    y1 = max(0, int(h * 0.15))
    return frame[y1:min(h, y1 + crop_h), x1:min(w, x1 + crop_w)]


def _rgb_means(frame_bgr: np.ndarray) -> Dict[str, float]:
    crop = _central_face_crop(frame_bgr)
    if crop.size == 0:
        return {"r": 0.0, "g": 0.0, "b": 0.0, "brightness": 0.0, "sharpness": 0.0}

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    mask = gray > 22
    if int(np.count_nonzero(mask)) < 250:
        mask = np.ones(gray.shape, dtype=bool)

    b = crop[:, :, 0][mask].astype(np.float32)
    g = crop[:, :, 1][mask].astype(np.float32)
    r = crop[:, :, 2][mask].astype(np.float32)

    return {
        "r": float(np.mean(r)) if r.size else 0.0,
        "g": float(np.mean(g)) if g.size else 0.0,
        "b": float(np.mean(b)) if b.size else 0.0,
        "brightness": float(np.mean(gray[mask])) if np.any(mask) else 0.0,
        "sharpness": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
    }


def analyze_liveness(video_path: str, expected: List[str], rgb_sequence: Optional[List[str]] = None) -> Dict[str, Any]:
    """CPU-friendly active RGB liveness.

    The camera video is traversed sequentially, but OpenCV only materializes the
    small set of frames we actually need. This is much faster on CPU-only
    containers than converting every video frame to a NumPy image.
    """
    sequence = list(rgb_sequence or RGB_FLASH_COLORS)
    if sorted(sequence) != sorted(RGB_FLASH_COLORS):
        return {
            "passed": False,
            "reason": "rgb_sequence_invalid",
            "events": [],
            "face_frames": 0,
            "sampled_frames": 0,
            "rgb_score": 0.0,
        }

    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return {
            "passed": False,
            "reason": "video_unreadable",
            "events": [],
            "face_frames": 0,
            "sampled_frames": 0,
            "rgb_score": 0.0,
        }

    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        usable_fps = fps if fps > 1 else 30.0
        duration_s = frame_count / usable_fps if frame_count > 0 else 3.6

        # Frontend: 500ms neutral pre-roll + 950ms per RGB phase.
        # Add a small encoder/camera pipeline offset and sample well inside each
        # phase rather than near the transition edges.
        start_offset = 0.55
        phase = RGB_FLASH_PHASE_SECONDS
        sample_fractions = (0.32, 0.55, 0.78)

        target_specs: List[tuple[int, str]] = []
        for idx, color_name in enumerate(sequence):
            phase_start = start_offset + idx * phase
            for fraction in sample_fractions:
                timestamp = phase_start + phase * fraction
                if timestamp < max(0.0, duration_s - 0.04):
                    target_frame = max(1, int(round(timestamp * usable_fps)))
                    target_specs.append((target_frame, color_name))
        target_specs.sort(key=lambda item: item[0])

        buckets: Dict[str, List[Dict[str, float]]] = {
            color_name: [] for color_name in sequence
        }
        sample_count = 0
        frame_index = 0
        target_index = 0
        best_snapshot_frame: Optional[np.ndarray] = None
        best_snapshot_sharpness = -1.0

        capture.set(cv2.CAP_PROP_POS_FRAMES, 0)

        # `grab()` advances the decoder without allocating/converting an image.
        # `retrieve()` is only called for our 9 target samples.
        while target_index < len(target_specs):
            if not capture.grab():
                break
            frame_index += 1

            target_frame, color_name = target_specs[target_index]
            if frame_index < target_frame:
                continue

            ok, frame = capture.retrieve()
            if not ok or frame is None:
                target_index += 1
                continue

            metrics = _rgb_means(frame)
            buckets[color_name].append(metrics)
            sample_count += 1

            if metrics["sharpness"] > best_snapshot_sharpness:
                best_snapshot_sharpness = metrics["sharpness"]
                best_snapshot_frame = frame.copy()

            target_index += 1

        samples: Dict[str, Dict[str, float]] = {}
        for color_name in sequence:
            phase_metrics = buckets.get(color_name) or []
            if not phase_metrics:
                return {
                    "passed": False,
                    "reason": "rgb_frame_missing",
                    "events": [],
                    "face_frames": len(samples),
                    "sampled_frames": sample_count,
                    "rgb_score": 0.0,
                }

            # Median is more stable when camera exposure/white balance is still
            # settling at one of the phase samples.
            samples[color_name] = {
                key: float(np.median([m[key] for m in phase_metrics]))
                for key in ("r", "g", "b", "brightness", "sharpness")
            }

        channel_key = {"red": "r", "green": "g", "blue": "b"}
        responses: Dict[str, float] = {}
        normalized_responses: Dict[str, float] = {}

        for color_name in sequence:
            key = channel_key[color_name]
            target = samples[color_name][key]
            others = [samples[other][key] for other in sequence if other != color_name]
            baseline = float(np.mean(others)) if others else target
            responses[color_name] = float(target - baseline)

            target_sum = (
                samples[color_name]["r"]
                + samples[color_name]["g"]
                + samples[color_name]["b"]
                + 1e-6
            )
            other_ratios = []
            for other in sequence:
                if other == color_name:
                    continue
                other_sum = (
                    samples[other]["r"]
                    + samples[other]["g"]
                    + samples[other]["b"]
                    + 1e-6
                )
                other_ratios.append(samples[other][key] / other_sum)
            normalized_responses[color_name] = float(
                (samples[color_name][key] / target_sum)
                - (float(np.mean(other_ratios)) if other_ratios else 0.0)
            )

        avg_brightness = float(np.mean([m["brightness"] for m in samples.values()]))
        avg_sharpness = float(np.mean([m["sharpness"] for m in samples.values()]))

        raw_matches = sum(
            1 for c in sequence if responses[c] >= RGB_FLASH_MIN_RESPONSE
        )
        ratio_matches = sum(
            1 for c in sequence if normalized_responses[c] >= 0.006
        )

        # Keep two-of-three agreement to avoid turning the check into a simple
        # brightness test, while being more tolerant of phone auto-exposure.
        response_ok = raw_matches >= 2 or ratio_matches >= 2
        brightness_ok = avg_brightness >= RGB_FLASH_MIN_BRIGHTNESS
        texture_ok = avg_sharpness >= 5.0
        passed = bool(response_ok and brightness_ok and texture_ok)

        events: List[str] = []
        if response_ok:
            events.append("rgb_sequence_matched")
        if brightness_ok:
            events.append("face_region_visible")
        if texture_ok:
            events.append("texture_present")

        strength = float(np.mean([max(0.0, responses[c]) for c in sequence]))
        ratio_strength = float(
            np.mean([max(0.0, normalized_responses[c]) for c in sequence])
        )
        score = round(
            max(
                min(1.0, strength / 9.0),
                min(1.0, ratio_strength / 0.030),
            )
            * 0.65
            + min(1.0, avg_brightness / 85.0) * 0.20
            + min(1.0, avg_sharpness / 80.0) * 0.15,
            3,
        )

        if not brightness_ok:
            reason = "rgb_too_dark"
        elif not texture_ok:
            reason = "rgb_face_region_blurry"
        elif not response_ok:
            reason = "rgb_sequence_not_detected"
        else:
            reason = "live"

        return {
            "passed": passed,
            "reason": reason,
            "events": events,
            "face_frames": len(samples),
            "sampled_frames": sample_count,
            "rgb_score": score,
            "snapshot": _snapshot_data_url_from_frame(best_snapshot_frame) if passed else None,
            "metrics": {
                "sequence": sequence,
                "responses": {k: round(v, 2) for k, v in responses.items()},
                "normalized_responses": {
                    k: round(v, 4) for k, v in normalized_responses.items()
                },
                "raw_matches": raw_matches,
                "ratio_matches": ratio_matches,
                "avg_brightness": round(avg_brightness, 2),
                "avg_sharpness": round(avg_sharpness, 2),
                "duration_s": round(duration_s, 2),
            },
        }
    finally:
        capture.release()


@app.on_event("startup")
async def startup() -> None:
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.liveness_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.liveness_results.create_index("liveness_session_id", unique=True)
    await db.admin_requests.create_index("request_id", unique=True)
    await db.attendance_approval_requests.create_index("request_id", unique=True)
    await db.attendance_approval_requests.create_index([("user_id", 1), ("status", 1), ("requested_at", -1)])
    await db.overtime_requests.create_index("request_id", unique=True)
    await db.overtime_requests.create_index([("user_id", 1), ("date", 1), ("status", 1), ("requested_at", -1)])
    await db.early_leave_requests.create_index("request_id", unique=True)
    await db.early_leave_requests.create_index([("user_id", 1), ("date", 1), ("status", 1), ("requested_at", -1)])
    await db.offices.create_index("office_id", unique=True)
    await db.holidays.create_index("date", unique=True)
    await db.leaves.create_index("leave_id", unique=True)
    await db.leaves.create_index([("user_id", 1), ("status", 1)])
    await db.notifications.create_index("notification_id", unique=True)
    await db.notifications.create_index([("user_id", 1), ("read", 1), ("created_at", -1)])
    await db.security_audit.create_index([("user_id", 1), ("created_at", -1)])
    await db.security_audit.create_index([("event", 1), ("created_at", -1)])
    await db.security_rate_events.create_index([("user_id", 1), ("action", 1), ("created_at", -1)])
    await db.security_rate_events.create_index("expires_at", expireAfterSeconds=0)
    await db.auth_failures.create_index([("user_id", 1), ("purpose", 1), ("created_at", -1)])
    await db.auth_failures.create_index("expires_at", expireAfterSeconds=0)
    # Existing accounts predate approval/password security; keep them approved to avoid lockout.
    await db.users.update_many({"account_status": {"$exists": False}}, {"$set": {"account_status": "approved"}})
    await ensure_default_office()


@api_router.get("/")
async def root() -> Dict[str, str]:
    return {"message": "PKUCity attendance API"}


@api_router.post("/auth/session", response_model=SessionResponse)
async def create_session(payload: SessionRequest) -> SessionResponse:
    device_id = payload.device_id.strip()
    await enforce_device_auth_rate_limit(device_id)

    identity = await get_supabase_user(payload.access_token.strip())
    email = str(identity.get("email", "")).strip()
    if not email:
        raise HTTPException(status_code=401, detail="Verified email was not returned")

    email_lower = email.lower()
    bootstrap_email = os.getenv("PKUCITY_ADMIN_EMAIL", "").strip().lower()
    supabase_user_id = str(identity["id"])
    metadata = identity.get("user_metadata") or {}
    name = (
        metadata.get("full_name")
        or metadata.get("name")
        or identity.get("user_metadata", {}).get("full_name")
        or email.split("@")[0]
    )
    picture = (
        metadata.get("avatar_url")
        or metadata.get("picture")
        or metadata.get("avatar")
    )
    is_bootstrap_admin = bool(bootstrap_email and email_lower == bootstrap_email)

    existing = await db.users.find_one(
        {"$or": [{"supabase_user_id": supabase_user_id}, {"email": email}]},
        {"_id": 0},
    )

    if not existing:
        user_doc = {
            "user_id": f"user_{uuid.uuid4().hex[:12]}",
            "supabase_user_id": supabase_user_id,
            "email": email,
            "name": name,
            "picture": picture,
            "role": "admin" if is_bootstrap_admin else "employee",
            "email_verified": bool(identity.get("email_confirmed_at") or identity.get("confirmed_at")),
            "full_name": None,
            "department": None,
            "profile_complete": False,
            "account_status": "approved" if is_bootstrap_admin else "pending",
            "password_set": False,
            "created_at": now_utc(),
            "updated_at": now_utc(),
        }
        await db.users.insert_one(dict(user_doc))
        if not is_bootstrap_admin:
            raise HTTPException(status_code=403, detail="Account created. Waiting for admin approval before you can sign in.")
        existing = user_doc
    else:
        updates: Dict[str, Any] = {
            "supabase_user_id": supabase_user_id,
            "picture": picture or existing.get("picture"),
            "name": name or existing.get("name") or email.split("@")[0],
            "email_verified": bool(identity.get("email_confirmed_at") or identity.get("confirmed_at") or existing.get("email_verified", False)),
            "updated_at": now_utc(),
        }
        if is_bootstrap_admin:
            updates.update({"role": "admin", "account_status": "approved"})
        await db.users.update_one({"user_id": existing["user_id"]}, {"$set": updates})
        existing = {**existing, **updates}

    status = existing.get("account_status", "approved")
    if status == "pending":
        raise HTTPException(status_code=403, detail="Your account is waiting for admin approval.")
    if status == "rejected":
        raise HTTPException(status_code=403, detail="Your account access was rejected. Please contact an admin.")

    user_id = existing["user_id"]
    now = now_utc()

    active_device_id = existing.get("active_device_id")
    if active_device_id and active_device_id != device_id:
        active_session = await db.user_sessions.find_one(
            {"user_id": user_id, "device_id": active_device_id, "expires_at": {"$gt": now}},
            {"_id": 0, "session_token": 1},
        )
        if active_session:
            raise HTTPException(
                status_code=409,
                detail="This account is already signed in on another device. Sign out from that device first.",
            )
        await db.users.update_one(
            {"user_id": user_id, "active_device_id": active_device_id},
            {"$unset": {"active_device_id": "", "active_device_since": ""}},
        )

    acquired = await db.users.update_one(
        {
            "user_id": user_id,
            "$or": [
                {"active_device_id": {"$exists": False}},
                {"active_device_id": None},
                {"active_device_id": device_id},
            ],
        },
        {"$set": {"active_device_id": device_id, "active_device_since": now, "updated_at": now}},
    )
    if acquired.matched_count == 0:
        raise HTTPException(
            status_code=409,
            detail="This account is already signed in on another device. Sign out from that device first.",
        )

    session_token = payload.access_token.strip()
    await db.user_sessions.delete_many({"user_id": user_id, "session_token": {"$ne": session_token}})
    await db.user_sessions.update_one(
        {"session_token": session_token},
        {"$set": {
            "session_token": session_token,
            "user_id": user_id,
            "device_id": device_id,
            "created_at": now,
            "expires_at": now + timedelta(days=7),
            "unlocked_until": None,
            "last_activity_at": None,
        }},
        upsert=True,
    )

    existing["active_device_id"] = device_id
    existing["active_device_since"] = now
    public = clean(existing)
    public["password_set"] = bool(existing.get("password_hash"))
    return SessionResponse(session_token=session_token, user=UserPublic(**public))


@api_router.get("/auth/security-status")
async def auth_security_status(request: Request) -> Dict[str, Any]:
    user, session = await get_session_user(request, require_unlock=False)
    unlocked_until = session.get("unlocked_until")
    unlocked = isinstance(unlocked_until, datetime) and as_utc(unlocked_until) > now_utc()
    user["password_set"] = bool(user.get("password_hash"))
    user.pop("password_hash", None)
    return {"user": UserPublic(**user).model_dump(), "password_set": bool(user.get("password_set")), "unlocked": unlocked}


@api_router.post("/auth/password/setup")
async def setup_password(payload: PasswordSetupBody, request: Request) -> Dict[str, Any]:
    user, session = await get_session_user(request, require_unlock=False)
    await enforce_sensitive_rate_limit(
        user["user_id"],
        "password_setup",
        limit=3,
        window_seconds=3600,
    )
    stored = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "password_hash": 1})
    if stored and stored.get("password_hash"):
        raise HTTPException(status_code=409, detail="Password is already set")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"password_hash": hash_password(payload.password), "password_set": True, "password_set_at": now_utc(), "updated_at": now_utc()}})
    until = now_utc() + timedelta(minutes=SESSION_IDLE_MINUTES)
    await db.user_sessions.update_one({"session_token": session["session_token"]}, {"$set": {"unlocked_until": until, "last_activity_at": now_utc()}})
    await write_security_audit(user["user_id"], "password_setup", outcome="success")
    return {"status": "ok", "unlocked_until": until}


@api_router.post("/auth/password/verify")
async def verify_account_password(payload: PasswordBody, request: Request) -> Dict[str, Any]:
    user, session = await get_session_user(request, require_unlock=False)
    await enforce_password_attempt_limit(user["user_id"], "unlock")
    stored = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "password_hash": 1})
    if not stored or not verify_password(payload.password, stored.get("password_hash")):
        await record_password_failure(user["user_id"], "unlock")
        raise HTTPException(status_code=401, detail="Kata sandi salah")
    await clear_password_failures(user["user_id"], "unlock")
    await write_security_audit(user["user_id"], "password_verify", outcome="success", metadata={"purpose": "unlock"})
    until = now_utc() + timedelta(minutes=SESSION_IDLE_MINUTES)
    await db.user_sessions.update_one(
        {"session_token": session["session_token"]},
        {"$set": {"unlocked_until": until, "last_activity_at": now_utc()}},
    )
    return {"status": "ok", "unlocked_until": until}


@api_router.post("/auth/profile-edit/verify")
async def verify_profile_edit_password(payload: PasswordBody, request: Request) -> Dict[str, Any]:
    user, session = await get_session_user(request, require_unlock=False)
    await enforce_password_attempt_limit(user["user_id"], "profile_edit")
    stored = await db.users.find_one(
        {"user_id": user["user_id"]},
        {"_id": 0, "password_hash": 1},
    )
    if not stored or not verify_password(payload.password, stored.get("password_hash")):
        await record_password_failure(user["user_id"], "profile_edit")
        raise HTTPException(status_code=401, detail="Kata sandi salah")
    await clear_password_failures(user["user_id"], "profile_edit")
    await write_security_audit(user["user_id"], "password_verify", outcome="success", metadata={"purpose": "profile_edit"})

    # Dedicated, short-lived authorization only for editing personal profile data.
    verified_until = now_utc() + timedelta(minutes=5)
    await db.user_sessions.update_one(
        {"session_token": session["session_token"]},
        {"$set": {
            "profile_edit_verified_until": verified_until,
            "last_activity_at": now_utc(),
        }},
    )
    return {"status": "ok", "profile_edit_verified_until": verified_until}


@api_router.post("/auth/lock")
async def lock_session(request: Request) -> Dict[str, str]:
    _, session = await get_session_user(request, require_unlock=False)
    await db.user_sessions.update_one({"session_token": session["session_token"]}, {"$set": {"unlocked_until": None}})
    return {"status": "locked"}


@api_router.post("/auth/logout")
async def logout_session(request: Request) -> Dict[str, str]:
    user, session = await get_session_user(request, require_unlock=False)
    session_token = session["session_token"]
    device_id = session.get("device_id")
    await db.user_sessions.delete_one({"session_token": session_token})
    if device_id:
        await db.users.update_one(
            {"user_id": user["user_id"], "active_device_id": device_id},
            {"$unset": {"active_device_id": "", "active_device_since": ""}, "$set": {"updated_at": now_utc()}},
        )
    return {"status": "signed_out"}


@api_router.get("/auth/me", response_model=UserPublic)
async def me(request: Request) -> UserPublic:
    return UserPublic(**(await get_current_user(request)))


@api_router.patch("/profile", response_model=UserPublic)
async def update_profile(payload: ProfileUpdate, request: Request) -> UserPublic:
    user, session = await get_session_user(request, require_unlock=True, touch=True)

    # Editing personal data always requires a fresh password confirmation,
    # independent from the normal 10-minute app unlock.
    verified_until = session.get("profile_edit_verified_until")
    if not isinstance(verified_until, datetime) or as_utc(verified_until) <= now_utc():
        raise HTTPException(status_code=423, detail="Profile edit password verification required")

    updates: Dict[str, Any] = {"updated_at": now_utc()}
    for field in ["full_name", "department", "phone", "address", "emergency_contact_name", "emergency_contact_phone"]:
        value = getattr(payload, field)
        if value is not None:
            updates[field] = value.strip()
    if payload.full_name is not None:
        updates["name"] = payload.full_name.strip()
    if (payload.full_name or user.get("full_name")) and (payload.department or user.get("department")):
        updates["profile_complete"] = True
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": updates})
    await db.user_sessions.update_one(
        {"session_token": session["session_token"]},
        {"$unset": {"profile_edit_verified_until": ""}},
    )
    refreshed = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return UserPublic(**clean(refreshed))


@api_router.get("/dashboard")
async def dashboard(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    offices = await list_offices(active_only=True)
    schedule = await get_schedule()

    now = now_utc()
    now_wib = to_wib(now)
    today = now_wib.strftime("%Y-%m-%d")

    work_time = await _calculate_work_time(
        user["user_id"],
        now_wib.year,
        now_wib.month,
    )
    holiday = await is_holiday(today)
    record = await db.attendance.find_one({"user_id": user["user_id"], "date": today}, {"_id": 0, "photo": 0}, sort=[("created_at", -1)])
    today_records = await db.attendance.find(
        {"user_id": user["user_id"], "date": today},
        {"_id": 0, "photo": 0},
    ).sort("created_at", 1).to_list(20)

    today_clock_in = next((item for item in today_records if item.get("action") == "check_in"), None)
    today_clock_out = next((item for item in reversed(today_records) if item.get("action") == "check_out"), None)
    today_attendance = {
        "clock_in_at": today_clock_in.get("created_at") if today_clock_in else None,
        "clock_out_at": today_clock_out.get("created_at") if today_clock_out else None,
        "clock_in_wib": to_wib(as_utc(today_clock_in["created_at"])).strftime("%H:%M") if today_clock_in and isinstance(today_clock_in.get("created_at"), datetime) else None,
        "clock_out_wib": to_wib(as_utc(today_clock_out["created_at"])).strftime("%H:%M") if today_clock_out and isinstance(today_clock_out.get("created_at"), datetime) else None,
        "status": "clocked_out" if today_clock_out else ("clocked_in" if today_clock_in else "not_started"),
    }
    pending_attendance = await db.attendance_approval_requests.find_one(
        {"user_id": user["user_id"], "status": "pending"},
        {"_id": 0, "photo": 0},
        sort=[("requested_at", -1)],
    )
    overtime_request = await db.overtime_requests.find_one(
        {"user_id": user["user_id"], "date": today, "status": {"$in": ["pending", "approved"]}},
        {"_id": 0},
        sort=[("requested_at", -1)],
    )
    early_leave_request = await db.early_leave_requests.find_one(
        {"user_id": user["user_id"], "date": today, "status": {"$in": ["pending", "approved"]}},
        {"_id": 0},
        sort=[("requested_at", -1)],
    )
    active_leave = await get_active_leave_for_today(user["user_id"], today)
    missing_checkout = await _find_unresolved_prior_checkout(user["user_id"], today)
    unread_notifications = await db.notifications.count_documents({"user_id": user["user_id"], "read": False})
    # Legacy field "settings" kept for backward-compatible frontend keys (uses first active office).
    primary = offices[0] if offices else {"office_name": "PKUCity Office", "latitude": 0.0, "longitude": 0.0, "radius_meters": 100}
    return {
        "user": user,
        "settings": primary,
        "offices": offices,
        "schedule": schedule,
        "today": clean(record),
        "today_attendance": clean(today_attendance),
        "pending_attendance": clean(pending_attendance) if pending_attendance else None,
        "overtime_request": clean(overtime_request) if overtime_request else None,
        "early_leave_request": clean(early_leave_request) if early_leave_request else None,
        "missing_checkout": clean(missing_checkout) if missing_checkout else None,
        "holiday": clean(holiday) if holiday else None,
        "on_leave": active_leave,
        "unread_notifications": unread_notifications,
        "server_time": now,
        "work_time": work_time,
        }


@api_router.get("/attendance", response_model=List[Dict[str, Any]])
async def attendance_history(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    records = await db.attendance.find(
        {"user_id": user["user_id"]},
        {"_id": 0, "photo": 0},
    ).sort("created_at", -1).to_list(100)

    result: List[Dict[str, Any]] = []
    for record in records:
        item = clean(record)
        created_at = record.get("created_at")
        if isinstance(created_at, datetime):
            # MongoDB returns datetimes without timezone metadata by default.
            # Attendance timestamps are stored as UTC policy timestamps, so attach
            # UTC explicitly before converting to WIB.
            item["time_wib"] = to_wib(as_utc(created_at)).strftime("%H:%M")
        else:
            item["time_wib"] = None
        result.append(item)
    return result


@api_router.post("/liveness/session")
async def create_liveness_session(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    await enforce_sensitive_rate_limit(
        user["user_id"],
        "liveness_session",
        limit=12,
        window_seconds=300,
    )
    session_id = f"live_{secrets.token_urlsafe(24)}"
    challenges = list(LIVENESS_CHALLENGES)
    rgb_sequence = list(secrets.SystemRandom().sample(RGB_FLASH_COLORS, len(RGB_FLASH_COLORS)))
    await db.liveness_sessions.insert_one({
        "liveness_session_id": session_id,
        "user_id": user["user_id"],
        "challenges": challenges,
        "rgb_sequence": rgb_sequence,
        "created_at": now_utc(),
        "expires_at": now_utc() + timedelta(minutes=3),
        "used": False,
    })
    return {"liveness_session_id": session_id, "steps": challenges, "rgb_sequence": rgb_sequence, "expires_in": 180}


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
    await enforce_sensitive_rate_limit(
        user["user_id"],
        "liveness_verify",
        limit=12,
        window_seconds=300,
    )
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
        analysis_started = time.perf_counter()
        verdict = analyze_liveness(
            str(video_path),
            liveness_session["challenges"],
            liveness_session.get("rgb_sequence"),
        )
        verdict["analysis_ms"] = round(
            (time.perf_counter() - analysis_started) * 1000
        )
        snapshot = verdict.pop("snapshot", None) if verdict["passed"] else None
        result = {
            "liveness_session_id": liveness_session_id,
            "user_id": user["user_id"],
            "passed": verdict["passed"],
            "reason": verdict["reason"],
            "events": verdict["events"],
            "rgb_sequence": liveness_session.get("rgb_sequence"),
            "face_frames": verdict["face_frames"],
            "sampled_frames": verdict.get("sampled_frames"),
            "rgb_score": verdict.get("rgb_score"),
            "analysis_ms": verdict.get("analysis_ms"),
            "rgb_metrics": verdict.get("metrics"),
            "video_sha256": hashlib.sha256(video_data).hexdigest(),
            "snapshot": snapshot,
            "created_at": now_utc(),
            "attendance_used": False,
        }
        await db.liveness_results.insert_one(dict(result))
        await write_security_audit(
            user["user_id"],
            "liveness_verify",
            outcome="passed" if verdict["passed"] else "failed",
            metadata={
                "reason": verdict.get("reason"),
                "rgb_score": verdict.get("rgb_score"),
                "analysis_ms": verdict.get("analysis_ms"),
            },
        )
        result.pop("user_id", None)
        result.pop("video_sha256", None)
        result.pop("snapshot", None)  # keep out of API response; admin reads via report endpoint
        return clean(result)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@api_router.post("/attendance")
async def create_attendance(payload: AttendanceCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    await enforce_sensitive_rate_limit(
        user["user_id"],
        "attendance",
        limit=10,
        window_seconds=300,
    )
    attendance_now = now_utc()
    now_wib = to_wib(attendance_now)
    today = now_wib.strftime("%Y-%m-%d")
    attendance_date = today

    if payload.action == "check_in":
        unresolved = await _find_unresolved_prior_checkout(user["user_id"], today)
        if unresolved:
            await write_security_audit(
                user["user_id"],
                "clock_in_blocked_missing_checkout",
                outcome="blocked",
                metadata={
                    "missing_date": unresolved["date"],
                    "correction_pending": unresolved["correction_pending"],
                },
            )
            if unresolved["correction_pending"]:
                return {
                    "accepted": False,
                    "reason": "missing_checkout_correction_pending",
                    "missing_date": unresolved["date"],
                    "message": f"Clock In terkunci karena Clock Out tanggal {unresolved['date']} belum selesai. Koreksi absensi sudah diajukan dan masih menunggu persetujuan admin.",
                }
            return {
                "accepted": False,
                "reason": "missing_checkout_requires_correction",
                "missing_date": unresolved["date"],
                "message": f"Clock In terkunci karena Anda belum Clock Out pada {unresolved['date']}. Ajukan Koreksi Absensi untuk Clock Out dan tunggu persetujuan admin.",
            }

    # Holidays block new check-ins, but never block a checkout that closes an
    # already-active shift. This matters for approved overtime that crosses midnight.
    if payload.action == "check_in":
        holiday = await is_holiday(today)
        if holiday:
            return {"accepted": False, "reason": "holiday", "message": f"Today is a holiday ({holiday.get('label')}). Attendance is not required."}

    offices = await list_offices(active_only=True)
    if not offices:
        return {"accepted": False, "reason": "no_office", "message": "No active office is configured. Please contact your admin."}

    # Only one unresolved remote-attendance request may exist at a time.
    pending_request = await db.attendance_approval_requests.find_one(
        {"user_id": user["user_id"], "status": "pending"},
        {"_id": 0, "request_id": 1, "action": 1},
    )
    if pending_request:
        return {
            "accepted": False,
            "reason": "approval_pending",
            "message": "Your previous attendance request is still waiting for admin approval.",
        }

    # Validate the requested action against approved attendance records.
    latest_today = await db.attendance.find_one(
        {"user_id": user["user_id"], "date": today},
        {"_id": 0, "action": 1, "date": 1},
        sort=[("created_at", -1)],
    )
    latest_action = (latest_today or {}).get("action")

    # Approved overtime may legitimately run past midnight. If there is no open
    # check-in under today's date, allow checkout to close yesterday's open shift.
    if payload.action == "check_out" and latest_action != "check_in":
        previous_day = (now_wib.date() - timedelta(days=1)).strftime("%Y-%m-%d")
        previous = await db.attendance.find_one(
            {"user_id": user["user_id"], "date": previous_day},
            {"_id": 0, "action": 1, "date": 1},
            sort=[("created_at", -1)],
        )
        if (previous or {}).get("action") == "check_in":
            approved_previous = await db.overtime_requests.find_one(
                {"user_id": user["user_id"], "date": previous_day, "status": "approved"},
                {"_id": 0, "request_id": 1},
            )
            if approved_previous:
                attendance_date = previous_day
                latest_action = "check_in"

    if payload.action == "check_in" and latest_action == "check_in":
        return {
            "accepted": False,
            "reason": "already_checked_in",
            "message": "You are already checked in. Please check out first.",
        }

    if payload.action == "check_out" and latest_action != "check_in":
        return {
            "accepted": False,
            "reason": "not_checked_in",
            "message": "Tidak ditemukan Clock In aktif untuk hari ini atau lembur yang disetujui dari hari sebelumnya.",
        }

    # Clock Out sebelum jadwal pulang hanya diperbolehkan jika izin pulang cepat
    # untuk hari kerja tersebut sudah disetujui admin.
    if payload.action == "check_out" and attendance_date == today:
        schedule = await get_schedule()
        scheduled_end = _local_clock(attendance_date, schedule.get("check_out", "17:00"))
        if now_wib < scheduled_end:
            approved_early_leave = await db.early_leave_requests.find_one(
                {"user_id": user["user_id"], "date": attendance_date, "status": "approved"},
                {"_id": 0, "request_id": 1},
                sort=[("approved_at", -1)],
            )
            if not approved_early_leave:
                return {
                    "accepted": False,
                    "reason": "too_early_checkout",
                    "message": f"Belum waktunya Clock Out. Clock Out dapat dilakukan mulai pukul {schedule.get('check_out', '17:00')} WIB, kecuali izin pulang cepat sudah disetujui admin.",
                }

    effective_attendance_at = await _effective_attendance_timestamp(
        user["user_id"], payload.action, attendance_now, attendance_date
    )

    nearest = nearest_office(offices, payload.latitude, payload.longitude)
    if not nearest:
        return {"accepted": False, "reason": "no_office", "message": "No active office could be resolved."}

    # Consume the one-time liveness result before either immediate attendance or
    # an approval request is created, so it cannot be reused.
    liveness_result = await db.liveness_results.find_one_and_update(
        {"liveness_session_id": payload.liveness_session_id, "user_id": user["user_id"], "passed": True, "attendance_used": False},
        {"$set": {"attendance_used": True, "attendance_used_at": attendance_now}},
        {"_id": 0},
    )
    if not liveness_result:
        return {"accepted": False, "reason": "liveness", "message": "RGB Flash verification failed or has already been used. Please run the face check again."}

    inside_office = nearest["distance_meters"] <= nearest["radius_meters"]

    if not inside_office:
        approval_request = {
            "request_id": f"arq_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "user_email": user.get("email"),
            "user_name": user.get("full_name") or user.get("name"),
            "department": user.get("department"),
            "date": attendance_date,
            "action": payload.action,
            "latitude": payload.latitude,
            "longitude": payload.longitude,
            "distance_meters": nearest["distance_meters"],
            "office_id": nearest["office_id"],
            "office_name": nearest["office_name"],
            "radius_meters": nearest["radius_meters"],
            "verification": "verified_pending_admin",
            "photo": liveness_result.get("snapshot"),
            "liveness_session_id": payload.liveness_session_id,
            # Policy timestamp: late checkout is stored as scheduled work-end
            # unless approved overtime extends the allowed end. The photo is kept,
            # but the later physical capture time is not persisted.
            "requested_at": effective_attendance_at,
            "physical_requested_at": attendance_now,
            "approval_reason": (
                "remote_checkout_after_schedule"
                if payload.action == "check_out"
                else "remote_check_in"
            ),
            "status": "pending",
        }
        await db.attendance_approval_requests.insert_one(dict(approval_request))
        await write_security_audit(
            user["user_id"],
            "remote_attendance_requested",
            outcome="pending_admin",
            metadata={
                "request_id": approval_request["request_id"],
                "action": payload.action,
                "date": attendance_date,
                "distance_meters": nearest["distance_meters"],
                "radius_meters": nearest["radius_meters"],
                "approval_reason": approval_request["approval_reason"],
            },
        )

        # Surface the request to admins through the existing notification center.
        admins = await db.users.find({"role": "admin"}, {"_id": 0, "user_id": 1}).to_list(100)
        action_label = "check-in" if payload.action == "check_in" else "check-out"
        for admin in admins:
            try:
                await create_notification(
                    admin["user_id"],
                    "Remote attendance approval",
                    f"{approval_request['user_name']} requested {action_label} outside the office radius.",
                    "attendance_approval",
                    approval_request["request_id"],
                )
            except Exception as exc:
                logger.warning("Could not create admin attendance notification: %s", exc)

        response_request = {k: v for k, v in approval_request.items() if k not in {"photo", "liveness_session_id"}}
        return {
            "accepted": True,
            "pending_approval": True,
            "request": response_request,
            "message": (
                "Anda melakukan Clock Out di luar radius kantor. Permintaan dikirim ke admin untuk persetujuan."
                if payload.action == "check_out"
                else "Anda berada di luar radius kantor. Permintaan Clock In dikirim ke admin untuk persetujuan."
            ),
        }

    record = {
        "attendance_id": f"att_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_email": user.get("email"),
        "user_name": user.get("full_name") or user.get("name"),
        "department": user.get("department"),
        "date": attendance_date,
        "action": payload.action,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "distance_meters": nearest["distance_meters"],
        "office_id": nearest["office_id"],
        "office_name": nearest["office_name"],
        "verification": "verified",
        "photo": liveness_result.get("snapshot"),
        # Policy timestamp: check-out cannot extend past schedule end unless
        # overtime has already been approved.
        "created_at": effective_attendance_at,
    }
    await db.attendance.insert_one(dict(record))
    await write_security_audit(
        user["user_id"],
        "attendance_recorded",
        outcome="accepted",
        metadata={
            "attendance_id": record["attendance_id"],
            "action": payload.action,
            "date": attendance_date,
            "distance_meters": nearest["distance_meters"],
            "office_id": nearest["office_id"],
        },
    )
    response_record = {k: v for k, v in record.items() if k != "photo"}
    return {"accepted": True, "pending_approval": False, "record": response_record, "message": f"Attendance recorded at '{nearest['office_name']}'."}


async def _validate_attendance_approval_state(item: Dict[str, Any]) -> None:
    latest = await db.attendance.find_one(
        {"user_id": item["user_id"], "date": item["date"]},
        {"_id": 0, "action": 1},
        sort=[("created_at", -1)],
    )
    latest_action = (latest or {}).get("action")
    if item["action"] == "check_in" and latest_action == "check_in":
        raise HTTPException(status_code=409, detail="This employee is already checked in for the requested date.")
    if item["action"] == "check_out" and latest_action != "check_in":
        raise HTTPException(status_code=409, detail="No approved check-in exists for this employee on the requested date.")


@api_router.post("/admin/attendance-requests/{request_id}/approve")
async def admin_approve_attendance_request(request_id: str, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    item = await db.attendance_approval_requests.find_one(
        {"request_id": request_id, "status": "pending"},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pending attendance request not found")

    await _validate_attendance_approval_state(item)

    attendance = {
        "attendance_id": f"att_{uuid.uuid4().hex[:12]}",
        "user_id": item["user_id"],
        "user_email": item.get("user_email"),
        "user_name": item.get("user_name"),
        "department": item.get("department"),
        "date": item["date"],
        "action": item["action"],
        "latitude": item["latitude"],
        "longitude": item["longitude"],
        "distance_meters": item.get("distance_meters"),
        "office_id": item.get("office_id"),
        "office_name": item.get("office_name"),
        "verification": "admin_approved_remote",
        "photo": item.get("photo"),
        # Preserve the policy timestamp from the employee request. For a late
        # checkout without approved overtime this is the scheduled work-end time.
        "created_at": item["requested_at"],
        "approval_request_id": request_id,
        "approved_by": admin["user_id"],
        "approved_at": now_utc(),
    }
    await db.attendance.insert_one(dict(attendance))
    await write_security_audit(
        item["user_id"],
        "remote_attendance_approved",
        outcome="approved",
        metadata={
            "request_id": request_id,
            "action": item["action"],
            "date": item["date"],
            "approved_by": admin["user_id"],
        },
    )
    await db.attendance_approval_requests.update_one(
        {"request_id": request_id, "status": "pending"},
        {"$set": {"status": "approved", "resolved_at": now_utc(), "resolved_by": admin["user_id"], "attendance_id": attendance["attendance_id"]}},
    )

    try:
        action_label = "Check-in" if item["action"] == "check_in" else "Check-out"
        await create_notification(
            item["user_id"],
            "Attendance approved",
            f"Your remote {action_label.lower()} request has been approved.",
            "attendance_approval",
            request_id,
        )
    except Exception as exc:
        logger.warning("Could not create employee approval notification: %s", exc)

    response_attendance = {k: v for k, v in attendance.items() if k != "photo"}
    return {"status": "approved", "attendance": response_attendance}


@api_router.post("/admin/attendance-requests/{request_id}/reject")
async def admin_reject_attendance_request(request_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    result = await db.attendance_approval_requests.find_one_and_update(
        {"request_id": request_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not result:
        raise HTTPException(status_code=404, detail="Pending attendance request not found")

    await write_security_audit(
        result["user_id"],
        "remote_attendance_rejected",
        outcome="rejected",
        metadata={
            "request_id": request_id,
            "action": result.get("action"),
            "date": result.get("date"),
            "rejected_by": admin["user_id"],
        },
    )

    try:
        action_label = "check-in" if result["action"] == "check_in" else "check-out"
        await create_notification(
            result["user_id"],
            "Attendance request rejected",
            f"Your remote {action_label} request was rejected. Please submit a new attendance request if needed.",
            "attendance_approval",
            request_id,
        )
    except Exception as exc:
        logger.warning("Could not create employee rejection notification: %s", exc)

    return {"status": "rejected"}



@api_router.post("/early-leave-requests")
async def create_early_leave_request(payload: EarlyLeaveRequestCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    now = now_utc()
    now_wib = to_wib(now)
    today = now_wib.strftime("%Y-%m-%d")
    schedule = await get_schedule()
    scheduled_end = _local_clock(today, schedule.get("check_out", "17:00"))

    if now_wib >= scheduled_end:
        raise HTTPException(status_code=409, detail="Jam pulang normal sudah tiba. Izin pulang cepat tidak diperlukan.")

    latest = await db.attendance.find_one(
        {"user_id": user["user_id"], "date": today},
        {"_id": 0, "action": 1},
        sort=[("created_at", -1)],
    )
    if (latest or {}).get("action") != "check_in":
        raise HTTPException(status_code=409, detail="Anda harus sudah Clock In sebelum mengajukan izin pulang cepat.")

    existing = await db.early_leave_requests.find_one(
        {"user_id": user["user_id"], "date": today, "status": {"$in": ["pending", "approved"]}},
        {"_id": 0},
        sort=[("requested_at", -1)],
    )
    if existing:
        return {
            "status": existing["status"],
            "request": clean(existing),
            "message": "Pengajuan izin pulang cepat untuk hari ini sudah ada.",
        }

    doc = {
        "request_id": f"el_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_name": user.get("full_name") or user.get("name"),
        "user_email": user.get("email"),
        "employee_id": user.get("employee_id"),
        "department": user.get("department"),
        "date": today,
        "reason": payload.reason.strip(),
        "status": "pending",
        "requested_at": now,
    }
    await db.early_leave_requests.insert_one(dict(doc))

    admins = await db.users.find({"role": "admin"}, {"_id": 0, "user_id": 1}).to_list(100)
    for admin in admins:
        try:
            await create_notification(
                admin["user_id"],
                "Pengajuan izin pulang cepat",
                f"{doc['user_name']} mengajukan izin pulang cepat.",
                "early_leave_approval",
                doc["request_id"],
            )
        except Exception as exc:
            logger.warning("Could not create early leave admin notification: %s", exc)

    return {"status": "pending", "request": clean(doc), "message": "Pengajuan izin pulang cepat dikirim ke admin."}


@api_router.post("/early-leave-requests/{request_id}/cancel")
async def cancel_early_leave_request(request_id: str, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    result = await db.early_leave_requests.update_one(
        {"request_id": request_id, "user_id": user["user_id"], "status": "pending"},
        {"$set": {"status": "cancelled", "cancelled_at": now_utc()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Hanya pengajuan izin pulang cepat yang masih menunggu yang dapat dibatalkan.")
    return {"status": "cancelled"}


@api_router.post("/admin/early-leave-requests/{request_id}/approve")
async def approve_early_leave_request(request_id: str, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    item = await db.early_leave_requests.find_one(
        {"request_id": request_id, "status": "pending"},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pengajuan izin pulang cepat tidak ditemukan.")

    approved_at = now_utc()
    await db.early_leave_requests.update_one(
        {"request_id": request_id, "status": "pending"},
        {"$set": {
            "status": "approved",
            "approved_at": approved_at,
            "resolved_at": approved_at,
            "resolved_by": admin["user_id"],
        }},
    )
    await create_notification(
        item["user_id"],
        "Izin pulang cepat disetujui",
        "Pengajuan izin pulang cepat Anda telah disetujui. Anda dapat Clock Out sebelum jadwal pulang.",
        "early_leave_approval",
        request_id,
    )
    return {"status": "approved", "request_id": request_id}


@api_router.post("/admin/early-leave-requests/{request_id}/reject")
async def reject_early_leave_request(request_id: str, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    item = await db.early_leave_requests.find_one_and_update(
        {"request_id": request_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pengajuan izin pulang cepat tidak ditemukan.")

    await create_notification(
        item["user_id"],
        "Izin pulang cepat ditolak",
        "Pengajuan izin pulang cepat Anda ditolak.",
        "early_leave_approval",
        request_id,
    )
    return {"status": "rejected", "request_id": request_id}


@api_router.post("/overtime-requests")
async def create_overtime_request(payload: OvertimeRequestCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    now = now_utc()
    now_wib = to_wib(now)
    today = now_wib.strftime("%Y-%m-%d")

    latest_attendance = await db.attendance.find_one(
        {"user_id": user["user_id"], "date": today},
        {"_id": 0, "action": 1},
        sort=[("created_at", -1)],
    )
    if (latest_attendance or {}).get("action") != "check_in":
        raise HTTPException(status_code=409, detail="You must be checked in before requesting overtime.")

    existing = await db.overtime_requests.find_one(
        {"user_id": user["user_id"], "date": today, "status": {"$in": ["pending", "approved"]}},
        {"_id": 0},
        sort=[("requested_at", -1)],
    )
    if existing:
        return {"status": existing["status"], "request": clean(existing), "message": "An overtime request already exists for today."}

    request_doc = {
        "request_id": f"ot_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_name": user.get("full_name") or user.get("name"),
        "user_email": user.get("email"),
        "department": user.get("department"),
        "date": today,
        "reason": payload.reason.strip(),
        "status": "pending",
        "requested_at": now,
    }
    await db.overtime_requests.insert_one(dict(request_doc))
    return {
        "status": "pending",
        "request": request_doc,
        "message": "Overtime request sent to admin. If approved, overtime will count until you check out, up to 06:00 WIB the next day.",
    }


@api_router.post("/overtime-requests/{request_id}/cancel")
async def cancel_overtime_request(request_id: str, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    result = await db.overtime_requests.update_one(
        {"request_id": request_id, "user_id": user["user_id"], "status": "pending"},
        {"$set": {"status": "cancelled", "cancelled_at": now_utc()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Only your pending overtime request can be cancelled")
    return {"status": "cancelled"}


@api_router.post("/admin/overtime-requests/{request_id}/approve")
async def approve_overtime_request(request_id: str, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    item = await db.overtime_requests.find_one({"request_id": request_id, "status": "pending"}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Pending overtime request not found")

    approved_at = now_utc()
    await db.overtime_requests.update_one(
        {"request_id": request_id, "status": "pending"},
        {"$set": {"status": "approved", "resolved_at": approved_at, "approved_at": approved_at, "resolved_by": admin["user_id"]}},
    )
    try:
        await create_notification(
            item["user_id"],
            "Overtime approved",
            "Your overtime request has been approved. Overtime will count until you check out, with a safety cap at 06:00 WIB the next day.",
            "overtime_approval",
            request_id,
        )
    except Exception as exc:
        logger.warning("Could not create overtime approval notification: %s", exc)
    return {"status": "approved", "request_id": request_id}


@api_router.post("/admin/overtime-requests/{request_id}/reject")
async def reject_overtime_request(request_id: str, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    item = await db.overtime_requests.find_one_and_update(
        {"request_id": request_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pending overtime request not found")
    try:
        await create_notification(
            item["user_id"],
            "Overtime request rejected",
            "Your overtime request was rejected.",
            "overtime_approval",
            request_id,
        )
    except Exception as exc:
        logger.warning("Could not create overtime rejection notification: %s", exc)
    return {"status": "rejected", "request_id": request_id}


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
    attendance_requests = await db.attendance_approval_requests.find(
        {"status": "pending"},
        {"_id": 0, "photo": 0, "liveness_session_id": 0},
    ).sort("requested_at", -1).to_list(200)
    overtime_requests = await db.overtime_requests.find(
        {"status": "pending"},
        {"_id": 0},
    ).sort("requested_at", -1).to_list(200)
    early_leave_requests = await db.early_leave_requests.find(
        {"status": "pending"},
        {"_id": 0},
    ).sort("requested_at", -1).to_list(200)
    account_requests = await db.users.find(
        {"account_status": "pending"},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", 1).to_list(500)
    holidays = await list_holidays()
    return {
        "settings": offices[0] if offices else {},
        "offices": offices,
        "schedule": schedule,
        "requests": [clean(item) for item in requests],
        "attendance_requests": [clean(item) for item in attendance_requests],
        "overtime_requests": [clean(item) for item in overtime_requests],
        "early_leave_requests": [clean(item) for item in early_leave_requests],
        "account_requests": [clean(item) for item in account_requests],
        "holidays": holidays,
    }

@api_router.get("/admin/work-time")
async def admin_work_time(
    request: Request,
    year: Optional[int] = None,
    month: Optional[int] = None,
) -> Dict[str, Any]:
    admin = await require_admin(request)

    now_wib = to_wib(now_utc())
    selected_year = year or now_wib.year
    selected_month = month or now_wib.month

    if selected_month < 1 or selected_month > 12:
        raise HTTPException(status_code=400, detail="Month must be between 1 and 12")

    month_start = f"{selected_year:04d}-{selected_month:02d}-01"
    month_end_day = calendar.monthrange(selected_year, selected_month)[1]
    month_end = f"{selected_year:04d}-{selected_month:02d}-{month_end_day:02d}"

    # Start with every non-admin, non-rejected account.
    account_docs = await db.users.find(
        {
            "user_id": {"$ne": admin["user_id"]},
            "role": {"$ne": "admin"},
            "account_status": {"$ne": "rejected"},
        },
        {
            "_id": 0,
            "user_id": 1,
            "name": 1,
            "full_name": 1,
            "email": 1,
            "department": 1,
            "employee_id": 1,
            "role": 1,
            "account_status": 1,
        },
    ).sort("created_at", 1).to_list(1000)

    employees_by_id: Dict[str, Dict[str, Any]] = {
        item["user_id"]: item for item in account_docs if item.get("user_id")
    }

    # Anyone who actually has attendance in the selected month belongs in Work Time,
    # including admins who also clock in/out. Admins without attendance are not added.
    # This also covers older/legacy accounts whose user profile metadata is incomplete.
    attendance_docs = await db.attendance.find(
        {
            "date": {"$gte": month_start, "$lte": month_end},
        },
        {
            "_id": 0,
            "user_id": 1,
            "user_name": 1,
            "user_email": 1,
            "department": 1,
        },
    ).to_list(5000)

    attendance_profiles: Dict[str, Dict[str, Any]] = {}
    for row in attendance_docs:
        uid = row.get("user_id")
        if not uid:
            continue
        profile = attendance_profiles.setdefault(uid, {"user_id": uid})
        if row.get("user_name"):
            profile["name"] = row.get("user_name")
        if row.get("user_email"):
            profile["email"] = row.get("user_email")
        if row.get("department"):
            profile["department"] = row.get("department")

    # If an attendance participant (employee or admin) is missing from the normal
    # employee query, fetch the profile directly; otherwise fall back to attendance metadata.
    missing_ids = [uid for uid in attendance_profiles if uid not in employees_by_id]
    if missing_ids:
        missing_users = await db.users.find(
            {
                "user_id": {"$in": missing_ids},
                "account_status": {"$ne": "rejected"},
            },
            {
                "_id": 0,
                "user_id": 1,
                "name": 1,
                "full_name": 1,
                "email": 1,
                "department": 1,
                "employee_id": 1,
            },
        ).to_list(1000)
        for item in missing_users:
            employees_by_id[item["user_id"]] = item

    for uid, profile in attendance_profiles.items():
        if uid not in employees_by_id:
            employees_by_id[uid] = profile

    items: List[Dict[str, Any]] = []
    for employee in employees_by_id.values():
        uid = employee.get("user_id")
        if not uid:
            continue

        work_time = await _calculate_work_time(uid, selected_year, selected_month)
        attendance_profile = attendance_profiles.get(uid, {})

        items.append({
            "user_id": uid,
            "name": (
                employee.get("full_name")
                or employee.get("name")
                or attendance_profile.get("name")
                or employee.get("email")
                or attendance_profile.get("email")
                or "Karyawan"
            ),
            "email": employee.get("email") or attendance_profile.get("email"),
            "department": employee.get("department") or attendance_profile.get("department"),
            "employee_id": employee.get("employee_id"),
            **work_time,
        })

    items.sort(key=lambda item: (str(item.get("name") or "").lower(), item.get("user_id") or ""))

    return {
        "year": selected_year,
        "month": selected_month,
        "server_time": now_utc(),
        "items": items,
    }


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
    owner_admin = await require_bootstrap_admin(request)
    access_request = await db.admin_requests.find_one({"request_id": request_id}, {"_id": 0})
    if not access_request:
        raise HTTPException(status_code=404, detail="Request not found")
    await db.users.update_one({"user_id": access_request["user_id"]}, {"$set": {"role": "admin", "updated_at": now_utc()}})
    await db.admin_requests.update_one({"request_id": request_id}, {"$set": {"status": "approved", "resolved_at": now_utc(), "resolved_by": owner_admin["user_id"]}})
    await write_security_audit(
        access_request["user_id"],
        "admin_privilege_granted",
        outcome="approved",
        metadata={"granted_by": owner_admin["user_id"], "request_id": request_id},
    )
    return {"status": "approved"}


@api_router.post("/admin/account-requests/{user_id}/approve")
async def approve_account_request(user_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    result = await db.users.update_one({"user_id": user_id, "account_status": "pending"}, {"$set": {"account_status": "approved", "approved_at": now_utc(), "updated_at": now_utc()}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Pending account not found")
    return {"status": "approved"}


@api_router.post("/admin/account-requests/{user_id}/reject")
async def reject_account_request(user_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    result = await db.users.update_one({"user_id": user_id, "account_status": "pending"}, {"$set": {"account_status": "rejected", "rejected_at": now_utc(), "updated_at": now_utc()}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Pending account not found")
    await db.user_sessions.delete_many({"user_id": user_id})
    return {"status": "rejected"}


# ---- Admin users ----------------------------------------------------------------


@api_router.get("/admin/users")
async def admin_users(request: Request) -> List[Dict[str, Any]]:
    await require_admin(request)
    docs = await db.users.find(
        {},
        {
            "_id": 0,
            "password_hash": 0,
            "password_set": 0,
            "password_set_at": 0,
        },
    ).sort("created_at", -1).to_list(500)
    return [clean(item) for item in docs]


@api_router.patch("/admin/users/{user_id}", response_model=UserPublic)
async def admin_update_user(user_id: str, payload: AdminUserUpdate, request: Request) -> UserPublic:
    await require_admin(request)
    raw_updates = payload.model_dump()

    updates: Dict[str, Any] = {k: v.strip() if isinstance(v, str) else v for k, v in raw_updates.items() if v is not None}
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
    refreshed = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "password_hash": 0, "password_set": 0, "password_set_at": 0},
    )
    return UserPublic(**clean(refreshed))



# ---- HR dashboard ----------------------------------------------------------------

@api_router.get("/admin/hr-dashboard")
async def admin_hr_dashboard(
    request: Request,
    year: Optional[int] = None,
) -> Dict[str, Any]:
    await require_admin(request)
    now = now_utc()
    now_wib = to_wib(now)
    today = now_wib.strftime("%Y-%m-%d")
    selected_year = year or now_wib.year

    # HR participant roster is account + attendance aware.
    # Keep legacy accounts compatible and don't drop an admin account that also
    # functions as a real employee.
    base_accounts = await db.users.find(
        {"account_status": {"$ne": "rejected"}},
        {
            "_id": 0,
            "user_id": 1,
            "full_name": 1,
            "name": 1,
            "email": 1,
            "employee_id": 1,
            "department": 1,
            "annual_leave_quota": 1,
            "role": 1,
            "account_status": 1,
            "created_at": 1,
        },
    ).sort("created_at", 1).to_list(2000)

    year_start = f"{selected_year:04d}-01-01"
    year_end = f"{selected_year:04d}-12-31"
    attendance_user_ids = set(
        await db.attendance.distinct(
            "user_id",
            {"date": {"$gte": year_start, "$lte": year_end}},
        )
    )

    employees: List[Dict[str, Any]] = []
    for account in base_accounts:
        uid = account.get("user_id")
        if not uid:
            continue
        is_regular_employee = account.get("role") != "admin"
        is_admin_employee = bool(
            account.get("employee_id")
            or account.get("department")
            or uid in attendance_user_ids
        )
        if is_regular_employee or is_admin_employee:
            employees.append(account)

    employee_ids = {u["user_id"] for u in employees if u.get("user_id")}

    today_rows = await db.attendance.find(
        {"date": today, "user_id": {"$in": list(employee_ids)}},
        {"_id": 0, "user_id": 1, "action": 1, "created_at": 1},
    ).sort("created_at", 1).to_list(5000)

    first_checkins: Dict[str, datetime] = {}
    for row in today_rows:
        uid = row.get("user_id")
        created = row.get("created_at")
        if row.get("action") != "check_in" or not uid or not isinstance(created, datetime):
            continue
        value = as_utc(created)
        current = first_checkins.get(uid)
        if current is None or value < current:
            first_checkins[uid] = value

    schedule = await get_schedule()
    [check_h, check_m] = [int(v) for v in schedule.get("check_in", "08:00").split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    allowed_minutes = check_h * 60 + check_m + grace

    late_today = 0
    for value in first_checkins.values():
        local = to_wib(value)
        if local.hour * 60 + local.minute > allowed_minutes:
            late_today += 1

    leave_docs = await db.leaves.find(
        {
            "status": "approved",
            "start_date": {"$lte": today},
            "end_date": {"$gte": today},
            "user_id": {"$in": list(employee_ids)},
        },
        {"_id": 0, "user_id": 1},
    ).to_list(2000)
    on_leave_ids = {item["user_id"] for item in leave_docs if item.get("user_id")}

    holidays = await list_holidays()
    holiday_dates = {item["date"] for item in holidays}
    is_workday = now_wib.weekday() != 6 and today not in holiday_dates
    present_ids = set(first_checkins.keys())
    absent_ids = employee_ids - present_ids - on_leave_ids if is_workday else set()

    pending = {
        "accounts": await db.users.count_documents({"account_status": "pending"}),
        "attendance": await db.attendance_approval_requests.count_documents({"status": "pending"}),
        "overtime": await db.overtime_requests.count_documents({"status": "pending"}),
        "early_leave": await db.early_leave_requests.count_documents({"status": "pending"}),
        "leaves": await db.leaves.count_documents({"status": "pending"}),
        "corrections": await db.attendance_corrections.count_documents({"status": "pending"}),
    }

    annual_leaves = await db.leaves.find(
        {
            "user_id": {"$in": list(employee_ids)},
            "leave_type": "annual",
            "status": "approved",
            "start_date": {"$lte": year_end},
            "end_date": {"$gte": year_start},
        },
        {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1},
    ).to_list(5000)

    leave_dates_by_user: Dict[str, set[str]] = {}
    for leave in annual_leaves:
        uid = leave.get("user_id")
        if not uid:
            continue
        target = leave_dates_by_user.setdefault(uid, set())
        start = max(leave["start_date"], year_start)
        end = min(leave["end_date"], year_end)
        for date_str in _iter_date_range(start, end):
            parsed = datetime.strptime(date_str, "%Y-%m-%d")
            if parsed.weekday() != 6 and date_str not in holiday_dates:
                target.add(date_str)

    balances: List[Dict[str, Any]] = []
    for employee in employees:
        uid = employee["user_id"]
        quota = int(employee.get("annual_leave_quota", 12) or 0)
        used = len(leave_dates_by_user.get(uid, set()))
        balances.append({
            "user_id": uid,
            "name": employee.get("full_name") or employee.get("name") or employee.get("email") or "Karyawan",
            "email": employee.get("email"),
            "employee_id": employee.get("employee_id"),
            "department": employee.get("department"),
            "quota": quota,
            "used": used,
            "remaining": max(quota - used, 0),
        })

    balances.sort(key=lambda item: str(item.get("name") or "").lower())

    return {
        "date": today,
        "year": selected_year,
        "is_workday": is_workday,
        "total_employees": len(employee_ids),
        "present_today": len(present_ids),
        "late_today": late_today,
        "on_leave_today": len(on_leave_ids),
        "absent_today": len(absent_ids),
        "pending": pending,
        "leave_balances": balances,
    }


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
    schedule = await get_schedule()
    approved = await db.overtime_requests.find(
        {"status": "approved", "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "user_id": 1, "date": 1},
    ).to_list(5000)
    approved_days = {(item.get("user_id"), item.get("date")) for item in approved if item.get("user_id") and item.get("date")}

    def local_clock(day: str, hhmm: str) -> datetime:
        hour, minute = [int(v) for v in hhmm.split(":", 1)]
        return datetime.strptime(day, "%Y-%m-%d").replace(
            hour=hour, minute=minute, second=0, microsecond=0,
            tzinfo=timezone(timedelta(hours=7)),
        )

    cleaned: List[Dict[str, Any]] = []
    for doc in docs:
        photo = doc.pop("photo", None)
        row = clean(doc)
        row["has_photo"] = bool(photo)
        created_at = row.get("created_at")
        if isinstance(created_at, datetime):
            actual_wib = to_wib(created_at)
            row["actual_time_wib"] = actual_wib.strftime("%H:%M")
            counted_wib = actual_wib
            if row.get("action") == "check_out" and row.get("date"):
                date_str = row["date"]
                if (row.get("user_id"), date_str) in approved_days:
                    counted_wib = _approved_overtime_counted_end(actual_wib, date_str)
                else:
                    allowed_end = local_clock(date_str, schedule.get("check_out", "17:00"))
                    counted_wib = min(actual_wib, allowed_end)
            row["time_wib"] = counted_wib.strftime("%H:%M")
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
    scheduled_end_minutes = check_out_hour * 60 + check_out_minute

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
    # Second pass: overtime totals. Only admin-approved overtime is counted.
    approved_overtime = await db.overtime_requests.find(
        {"status": "approved", "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "user_id": 1, "date": 1},
    ).to_list(5000)
    approved_days = {(item.get("user_id"), item.get("date")) for item in approved_overtime if item.get("user_id") and item.get("date")}
    for user_id, dates in latest_checkout.items():
        total_overtime = 0
        for date_str, dt in dates.items():
            if (user_id, date_str) not in approved_days:
                continue
            actual = to_wib(dt)
            counted_end = _approved_overtime_counted_end(actual, date_str)
            scheduled_end = _local_clock(date_str, schedule["check_out"])
            diff = int((counted_end - scheduled_end).total_seconds() // 60)
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
    scheduled_end_minutes = ch * 60 + cm
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Date", "Time (WIB)", "Name", "Email", "Department", "Action", "Office", "Distance (m)", "Overtime (min)", "Latitude", "Longitude", "Verification"])
    for row in rows:
        created_at = row.get("created_at")
        time_str = row.get("time_wib") or (to_wib(created_at).strftime("%H:%M:%S") if isinstance(created_at, datetime) else "")
        overtime = ""
        if row.get("action") == "check_out" and isinstance(created_at, datetime) and row.get("date"):
            date_str = row["date"]
            approved = await db.overtime_requests.find_one(
                {"user_id": row.get("user_id"), "date": date_str, "status": "approved"},
                {"_id": 0, "request_id": 1},
            )
            if approved:
                counted_end = _approved_overtime_counted_end(to_wib(created_at), date_str)
                scheduled_end = _local_clock(date_str, schedule["check_out"])
                overtime = str(max(0, int((counted_end - scheduled_end).total_seconds() // 60)))
            else:
                overtime = "0"
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
    scheduled_end_minutes = ch * 60 + cm

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
            "last_at": None,
        })
        created_at = row.get("created_at")
        if isinstance(created_at, datetime) and (bucket["last_at"] is None or created_at > bucket["last_at"]):
            bucket["last_at"] = created_at
        if row.get("action") == "check_in":
            bucket["check_ins"] += 1
        elif row.get("action") == "check_out":
            bucket["check_outs"] += 1
            date_str = row.get("date")
            if isinstance(created_at, datetime) and date_str:
                per_day = latest_checkout.setdefault(key, {})
                if date_str not in per_day or created_at > per_day[date_str]:
                    per_day[date_str] = created_at
    approved_overtime = await db.overtime_requests.find(
        {"status": "approved", "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "user_id": 1, "date": 1},
    ).to_list(5000)
    approved_days = {(item.get("user_id"), item.get("date")) for item in approved_overtime if item.get("user_id") and item.get("date")}
    for user_id, dates in latest_checkout.items():
        total = 0
        for date_str, dt in dates.items():
            if (user_id, date_str) not in approved_days:
                continue
            actual = to_wib(dt)
            counted_end = _approved_overtime_counted_end(actual, date_str)
            scheduled_end = _local_clock(date_str, schedule["check_out"])
            diff = int((counted_end - scheduled_end).total_seconds() // 60)
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
    body.append(Paragraph(f"Scheduled check-out counted until: {schedule['check_out']} unless overtime is approved · {len(rows)} raw records · {len(summary)} employees", styles["Normal"]))
    body.append(Spacer(1, 8 * mm))

    cell_style = styles["Normal"]
    cell_style.fontSize = 9
    cell_style.leading = 11
    header_style = ParagraphStyle("header", parent=cell_style, textColor=colors.white, fontName="Helvetica-Bold")

    def cell(text: str, header: bool = False) -> Paragraph:
        return Paragraph(str(text or ""), header_style if header else cell_style)

    table_data = [[cell("Name", True), cell("Department", True), cell("Email", True), cell("Check-ins", True), cell("Check-outs", True), cell("Last Activity", True), cell("Overtime", True)]]
    for user_id, bucket in summary.items():
        overtime_min = int(bucket.get("overtime_minutes", 0))
        overtime_label = f"{overtime_min // 60}h {overtime_min % 60}m" if overtime_min > 0 else "—"
        last_at = bucket.get("last_at")
        last_label = to_wib(last_at).strftime("%d %b %H:%M") if isinstance(last_at, datetime) else "—"
        table_data.append([
            cell(bucket["name"]), cell(bucket["department"]), cell(bucket["email"]),
            cell(str(bucket["check_ins"])), cell(str(bucket["check_outs"])), cell(last_label), cell(overtime_label),
        ])
    if len(table_data) == 1:
        table_data.append([cell("No attendance records in range"), cell(""), cell(""), cell(""), cell(""), cell(""), cell("")])
    table = Table(table_data, hAlign="LEFT", colWidths=[32 * mm, 22 * mm, 48 * mm, 16 * mm, 18 * mm, 24 * mm, 16 * mm], repeatRows=1)
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
    body.append(Paragraph("Dibuat oleh PKUCITY · rahasia", styles["Italic"]))
    doc.build(body)
    pdf_bytes = buffer.getvalue()
    filename = f"pkucity-attendance-{date_from}-to-{date_to}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
@api_router.get("/admin/reports/user/{user_id}/export.pdf")
async def admin_user_report_pdf(user_id: str, request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Response:
    await require_admin(request)
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)
    schedule = await get_schedule()
    ch_in, cm_in = [int(p) for p in schedule["check_in"].split(":")]
    ch_out, cm_out = [int(p) for p in schedule["check_out"].split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_start_minutes = ch_in * 60 + cm_in + grace
    scheduled_end_minutes = ch_out * 60 + cm_out

    docs = await db.attendance.find(
        {"user_id": user_id, "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "photo": 0},
    ).sort("created_at", 1).to_list(2000)
    approved_items = await db.overtime_requests.find(
        {"user_id": user_id, "status": "approved", "date": {"$gte": date_from, "$lte": date_to}},
        {"_id": 0, "date": 1},
    ).to_list(1000)
    approved_days = {item.get("date") for item in approved_items if item.get("date")}
    if not docs:
        raise HTTPException(status_code=404, detail="No attendance records for this user in range")

    user_name = docs[0].get("user_name") or docs[0].get("user_email") or user_id
    user_email = docs[0].get("user_email") or ""
    department = docs[0].get("department") or "—"

    late_count = 0
    overtime_count = 0
    total_overtime_minutes = 0
    rows_data: List[List[str]] = []
    for doc in docs:
        created_at = doc.get("created_at")
        wib = to_wib(created_at) if isinstance(created_at, datetime) else None
        time_label = wib.strftime("%H:%M") if wib else "—"
        action = doc.get("action")
        status_label = "—"
        if action == "check_in" and wib:
            actual = wib.hour * 60 + wib.minute
            if actual > scheduled_start_minutes:
                late_count += 1
                status_label = f"Late {actual - scheduled_start_minutes}m"
            else:
                status_label = "On time"
        elif action == "check_out" and wib:
            date_str = doc.get("date")
            overtime_approved = bool(date_str and date_str in approved_days)
            scheduled_end = _local_clock(date_str, schedule["check_out"]) if date_str else wib
            if overtime_approved and date_str:
                counted_end = _approved_overtime_counted_end(wib, date_str)
                time_label = counted_end.strftime("%H:%M")
                diff = max(0, int((counted_end - scheduled_end).total_seconds() // 60))
                if diff > 0:
                    overtime_count += 1
                    total_overtime_minutes += diff
                    status_label = f"Overtime {diff}m"
                if wib > _overtime_cap_local(date_str):
                    status_label += " · capped 06:00"
            else:
                counted_end = min(wib, scheduled_end)
                time_label = counted_end.strftime("%H:%M")
                if wib > scheduled_end:
                    status_label = f"Counted until {schedule['check_out']}"
        rows_data.append([
            doc.get("date", ""), time_label,
            "Check in" if action == "check_in" else "Check out",
            doc.get("office_name") or "—", status_label,
        ])

    buffer = io.BytesIO()
    doc_pdf = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
    styles = getSampleStyleSheet()
    title_style = styles["Heading1"]
    title_style.textColor = colors.HexColor("#DC2626")
    cell_style = styles["Normal"]
    cell_style.fontSize = 9
    cell_style.leading = 11
    header_style = ParagraphStyle("header2", parent=cell_style, textColor=colors.white, fontName="Helvetica-Bold")

    def cell(text: str, header: bool = False) -> Paragraph:
        return Paragraph(str(text or ""), header_style if header else cell_style)

    body: List[Any] = []
    body.append(Paragraph(f"Attendance Report — {user_name}", title_style))
    body.append(Paragraph(f"{department} · {user_email}", styles["Normal"]))
    body.append(Paragraph(f"Period: {date_from} → {date_to}", styles["Normal"]))
    body.append(Paragraph(f"Total late: {late_count} · Total overtime: {overtime_count} time(s), {total_overtime_minutes // 60}h {total_overtime_minutes % 60}m", styles["Normal"]))
    body.append(Spacer(1, 8 * mm))

    table_data = [[cell("Date", True), cell("Time", True), cell("Action", True), cell("Office", True), cell("Status", True)]]
    for row in rows_data:
        table_data.append([cell(v) for v in row])
    table = Table(table_data, hAlign="LEFT", colWidths=[28 * mm, 20 * mm, 25 * mm, 45 * mm, 35 * mm], repeatRows=1)
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
    body.append(Paragraph("Dibuat oleh PKUCITY · rahasia", styles["Italic"]))
    doc_pdf.build(body)
    pdf_bytes = buffer.getvalue()
    filename = f"pkucity-{user_name.replace(' ', '-').lower()}-{date_from}-to-{date_to}.pdf"
    return Response(content=pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})

@api_router.get("/admin/reports/summary.pdf")
async def admin_reports_summary_pdf(request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Response:
    await require_admin(request)
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)

    # Build the PDF participant list from both account data and real attendance.
    # This keeps Summary PDF consistent with Reports / Work Time:
    # - normal employee accounts are included;
    # - admins are included only when they actually have attendance in this period;
    # - legacy attendance rows still appear even if profile metadata is incomplete.
    employee_users = await db.users.find(
        {
            "role": {"$ne": "admin"},
            "account_status": {"$ne": "rejected"},
        },
        {"_id": 0},
    ).sort("created_at", 1).to_list(1000)

    users_by_id: Dict[str, Dict[str, Any]] = {
        item["user_id"]: item
        for item in employee_users
        if item.get("user_id")
    }

    attendance_participants = await db.attendance.find(
        {"date": {"$gte": date_from, "$lte": date_to}},
        {
            "_id": 0,
            "user_id": 1,
            "user_name": 1,
            "user_email": 1,
            "department": 1,
        },
    ).to_list(5000)

    attendance_profiles: Dict[str, Dict[str, Any]] = {}
    for row in attendance_participants:
        uid = row.get("user_id")
        if not uid:
            continue
        profile = attendance_profiles.setdefault(uid, {"user_id": uid})
        if row.get("user_name"):
            profile["name"] = row["user_name"]
        if row.get("user_email"):
            profile["email"] = row["user_email"]
        if row.get("department"):
            profile["department"] = row["department"]

    missing_ids = [uid for uid in attendance_profiles if uid not in users_by_id]
    if missing_ids:
        profile_docs = await db.users.find(
            {
                "user_id": {"$in": missing_ids},
                "account_status": {"$ne": "rejected"},
            },
            {"_id": 0},
        ).to_list(1000)
        for item in profile_docs:
            if item.get("user_id"):
                users_by_id[item["user_id"]] = item

    # Final fallback for old attendance records whose user document no longer has
    # all display metadata. Do not drop a real attendance participant from the PDF.
    for uid, fallback in attendance_profiles.items():
        if uid not in users_by_id:
            users_by_id[uid] = fallback

    users = sorted(
        users_by_id.values(),
        key=lambda item: str(
            item.get("full_name")
            or item.get("name")
            or item.get("email")
            or item.get("user_id")
            or ""
        ).lower(),
    )

    schedule = await get_schedule()
    holidays = await db.holidays.find({"date": {"$gte": date_from, "$lte": date_to}}, {"_id": 0}).to_list(200)
    holiday_set = {h["date"] for h in holidays}
    date_list = _iter_date_range(date_from, date_to)
    working_days = sum(1 for d in date_list if datetime.strptime(d, "%Y-%m-%d").weekday() != 6 and d not in holiday_set)
    target_minutes = working_days * 450  # 7 jam 30 menit per hari kerja

    styles = getSampleStyleSheet()
    cell_style = styles["Normal"]
    cell_style.fontSize = 9
    cell_style.leading = 11
    header_style = ParagraphStyle("header_sum", parent=cell_style, textColor=colors.white, fontName="Helvetica-Bold")

    def cell(text: Any, header: bool = False) -> Paragraph:
        return Paragraph(str(text if text is not None else ""), header_style if header else cell_style)

    table_data = [[
        cell("No.", True),
        cell("Nama", True),
        cell("ID Karyawan", True),
        cell("Posisi", True),
        cell("Jumlah Jam Kerja Sebulan (Jam)", True),
        cell("Kelebihan/Kekurangan", True),
    ]]
    for idx, u in enumerate(users, start=1):
        by_date = await _daily_attendance_map(u["user_id"], date_from, date_to)
        worked_minutes = 0
        for d in date_list:
            # Sunday / company holiday remains a non-required workday for the
            # monthly target, but real attendance on that date must still count.
            rec = by_date.get(d)
            if rec and rec.get("check_in") and rec.get("check_out"):
                worked_minutes += _counted_session_minutes(
                    rec["check_in"],
                    rec["check_out"],
                    d,
                    schedule,
                )
        diff = worked_minutes - target_minutes
        display_name = (
            u.get("full_name")
            or u.get("name")
            or u.get("email")
            or attendance_profiles.get(u["user_id"], {}).get("name")
            or attendance_profiles.get(u["user_id"], {}).get("email")
            or "Karyawan"
        )
        position = u.get("department") or attendance_profiles.get(u["user_id"], {}).get("department") or "—"
        employee_id = u.get("employee_id") or "—"
        table_data.append([
            cell(idx),
            cell(display_name),
            cell(employee_id),
            cell(position),
            cell(format_minutes(worked_minutes)),
            cell(format_minutes(diff)),
        ])
    if len(table_data) == 1:
        table_data.append([cell("Tidak ada karyawan"), cell(""), cell(""), cell(""), cell(""), cell("")])

    table = Table(
        table_data,
        hAlign="LEFT",
        colWidths=[10 * mm, 38 * mm, 24 * mm, 28 * mm, 40 * mm, 35 * mm],
        repeatRows=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DC2626")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FEF2F2")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#F3F4F6")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
    title_style = styles["Heading1"]
    title_style.textColor = colors.HexColor("#DC2626")
    body: List[Any] = [
        Paragraph("REKAP ABSENSI KARYAWAN", title_style),
        Paragraph(f"Periode: {date_from} → {date_to}", styles["Normal"]),
        Spacer(1, 6 * mm),
        table,
        Spacer(1, 6 * mm),
        Paragraph("Dibuat oleh PKUCITY · rahasia", styles["Italic"]),
    ]
    doc.build(body)
    pdf_bytes = buffer.getvalue()
    return Response(content=pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="rekap-absensi-{date_from}-to-{date_to}.pdf"'})

@api_router.get("/admin/reports/user/{user_id}/daily.pdf")
async def admin_user_daily_pdf(user_id: str, request: Request, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Response:
    await require_admin(request)
    today = now_utc().strftime("%Y-%m-%d")
    first_of_month = now_utc().replace(day=1).strftime("%Y-%m-%d")
    date_from = _parse_date(date_from, first_of_month)
    date_to = _parse_date(date_to, today)

    user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    offices = await list_offices()
    office_name = offices[0]["office_name"] if offices else "—"
    holidays = await db.holidays.find({"date": {"$gte": date_from, "$lte": date_to}}, {"_id": 0}).to_list(200)
    holiday_set = {h["date"] for h in holidays}
    by_date = await _daily_attendance_map(user_id, date_from, date_to)
    schedule = await get_schedule()
    date_list = _iter_date_range(date_from, date_to)

    styles = getSampleStyleSheet()
    cell_style = styles["Normal"]
    cell_style.fontSize = 9
    cell_style.leading = 11
    header_style = ParagraphStyle("header_daily", parent=cell_style, textColor=colors.white, fontName="Helvetica-Bold")

    def cell(text: Any, header: bool = False) -> Paragraph:
        return Paragraph(str(text if text is not None else ""), header_style if header else cell_style)

    table_data = [[cell("No.", True), cell("Tanggal", True), cell("Datang", True), cell("Pulang", True), cell("Total Jam Kerja", True), cell("Keterangan", True)]]
    total_minutes = 0
    for idx, d in enumerate(date_list, start=1):
        weekday = datetime.strptime(d, "%Y-%m-%d").weekday()
        rec = by_date.get(d)
        is_non_workday = weekday == 6 or d in holiday_set
        if rec and rec.get("check_in"):
            check_in_label = rec["check_in"].strftime("%H:%M")
            check_out = rec.get("check_out")
            if check_out:
                delta = _counted_session_minutes(rec["check_in"], check_out, d, schedule)
                total_minutes += delta
                table_data.append([
                    cell(idx),
                    cell(d),
                    cell(check_in_label),
                    cell(check_out.strftime("%H:%M")),
                    cell(format_minutes(delta)),
                    cell("LIBUR - MASUK" if is_non_workday else ""),
                ])
            else:
                table_data.append([
                    cell(idx),
                    cell(d),
                    cell(check_in_label),
                    cell(""),
                    cell(""),
                    cell("LIBUR - CLOCK IN" if is_non_workday else "Belum Clock Out"),
                ])
        elif is_non_workday:
            table_data.append([cell(idx), cell(d), cell(""), cell(""), cell(""), cell("LIBUR")])
        else:
            table_data.append([cell(idx), cell(d), cell(""), cell(""), cell(""), cell("Tidak Hadir")])

    table = Table(table_data, hAlign="LEFT", colWidths=[10 * mm, 25 * mm, 20 * mm, 20 * mm, 32 * mm, 28 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DC2626")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FEF2F2")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#F3F4F6")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
    title_style = styles["Heading1"]
    title_style.textColor = colors.HexColor("#DC2626")
    name = user.get("full_name") or user.get("name") or "—"
    body: List[Any] = [
        Paragraph("REKAP ABSENSI KARYAWAN", title_style),
        Spacer(1, 4 * mm),
        Paragraph(f"<b>Nama Karyawan:</b> {name}", styles["Normal"]),
        Paragraph(f"<b>ID Karyawan:</b> {user.get('employee_id') or '—'}", styles["Normal"]),
        Paragraph(f"<b>Jabatan:</b> {user.get('department') or '—'}", styles["Normal"]),
        Paragraph(f"<b>Lokasi:</b> {office_name}", styles["Normal"]),
        Spacer(1, 6 * mm),
        table,
        Spacer(1, 6 * mm),
        Paragraph(f"<b>Total jam kerja periode ini: {format_minutes(total_minutes)}</b>", styles["Normal"]),
        Spacer(1, 4 * mm),
        Paragraph("Dibuat oleh PKUCITY · rahasia", styles["Italic"]),
    ]
    doc.build(body)
    pdf_bytes = buffer.getvalue()
    return Response(content=pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="pkucity-{name.replace(" ", "-").lower()}-daily-{date_from}-to-{date_to}.pdf"'})

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
    current_user = await get_current_user(request)
    # Employee privacy: self only. Admin retains HR access.
    if current_user.get("role") != "admin" and current_user.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="You may only view your own profile")
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



ALLOWED_SUPPORT_MIME = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
}
MAX_SUPPORT_FILE_BYTES = 5 * 1024 * 1024


def _normalize_support_attachment(payload: Optional[AttachmentPayload]) -> Optional[Dict[str, Any]]:
    if payload is None:
        return None
    if payload.mime_type not in ALLOWED_SUPPORT_MIME:
        raise HTTPException(status_code=415, detail="Attachment must be PDF, JPG, PNG, or WEBP")
    try:
        raw = base64.b64decode(payload.data_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Attachment is not valid base64") from exc
    if not raw:
        raise HTTPException(status_code=400, detail="Attachment is empty")
    if len(raw) > MAX_SUPPORT_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Attachment is too large (maximum 5 MB)")
    return {
        "file_name": payload.file_name,
        "mime_type": payload.mime_type,
        "data_base64": payload.data_base64,
        "size_bytes": len(raw),
    }


def _public_request_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    clean_doc = clean(doc)
    attachment = clean_doc.get("attachment")
    if isinstance(attachment, dict):
        clean_doc["attachment"] = {
            "file_name": attachment.get("file_name"),
            "mime_type": attachment.get("mime_type"),
            "size_bytes": attachment.get("size_bytes"),
        }
    return clean_doc


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
        "leave_type": payload.leave_type,
        "start_date": payload.start_date,
        "end_date": payload.end_date,
        "days": len(_iter_date_range(payload.start_date, payload.end_date)),
        "reason": payload.reason.strip(),
        "attachment": _normalize_support_attachment(payload.attachment),
        "attachment_url": payload.attachment_url.strip() if payload.attachment_url else None,
        "status": "pending",
        "created_at": now_utc(),
    }
    await db.leaves.insert_one(dict(leave))
    return _public_request_doc(leave)


@api_router.get("/leaves")
async def list_my_leaves(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    docs = await db.leaves.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return [_public_request_doc(doc) for doc in docs]


@api_router.post("/leaves/{leave_id}/cancel")
async def cancel_my_leave(leave_id: str, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    result = await db.leaves.update_one(
        {"leave_id": leave_id, "user_id": user["user_id"], "status": "pending"},
        {"$set": {"status": "cancelled", "cancelled_at": now_utc()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Only your pending leave can be cancelled")
    return {"status": "cancelled"}


@api_router.get("/leave-balance")
async def my_leave_balance(request: Request, year: Optional[int] = None) -> Dict[str, Any]:
    user = await get_current_user(request)
    now_wib = to_wib(now_utc())
    selected_year = year or now_wib.year
    start = f"{selected_year:04d}-01-01"
    end = f"{selected_year:04d}-12-31"
    approved = await db.leaves.find(
        {
            "user_id": user["user_id"],
            "leave_type": "annual",
            "status": "approved",
            "start_date": {"$lte": end},
            "end_date": {"$gte": start},
        },
        {"_id": 0, "start_date": 1, "end_date": 1},
    ).to_list(500)
    used_dates = set()
    for leave in approved:
        for date_str in _iter_date_range(max(leave["start_date"], start), min(leave["end_date"], end)):
            if datetime.strptime(date_str, "%Y-%m-%d").weekday() != 6:
                used_dates.add(date_str)
    quota = int(user.get("annual_leave_quota", 12) or 0)
    used = len(used_dates)
    return {"year": selected_year, "quota": quota, "used": used, "remaining": max(quota - used, 0)}


@api_router.get("/leaves/{leave_id}/attachment")
async def my_leave_attachment(leave_id: str, request: Request) -> Response:
    user = await get_current_user(request)
    query: Dict[str, Any] = {"leave_id": leave_id}
    if user.get("role") != "admin":
        query["user_id"] = user["user_id"]
    doc = await db.leaves.find_one(query, {"_id": 0, "attachment": 1})
    attachment = (doc or {}).get("attachment")
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    raw = base64.b64decode(attachment["data_base64"])
    return Response(
        content=raw,
        media_type=attachment["mime_type"],
        headers={"Content-Disposition": f'attachment; filename="{attachment["file_name"]}"'},
    )


@api_router.get("/admin/leaves")
async def admin_list_leaves(request: Request, status: Optional[str] = None) -> List[Dict[str, Any]]:
    await require_admin(request)
    query: Dict[str, Any] = {}
    if status in {"pending", "approved", "rejected", "cancelled"}:
        query["status"] = status
    docs = await db.leaves.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [_public_request_doc(doc) for doc in docs]


@api_router.post("/admin/leaves/{leave_id}/approve")
async def admin_approve_leave(leave_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    leave = await db.leaves.find_one_and_update(
        {"leave_id": leave_id, "status": "pending"},
        {"$set": {"status": "approved", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not leave:
        raise HTTPException(status_code=404, detail="Leave not found or already resolved")
    await create_notification(
        user_id=leave["user_id"],
        title="Leave approved",
        body=f"Your leave from {leave['start_date']} to {leave['end_date']} has been approved. Enjoy!",
        category="leave_approved",
        related_id=leave_id,
    )
    return {"status": "approved"}


@api_router.post("/admin/leaves/{leave_id}/reject")
async def admin_reject_leave(leave_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    leave = await db.leaves.find_one_and_update(
        {"leave_id": leave_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not leave:
        raise HTTPException(status_code=404, detail="Leave not found or already resolved")
    await create_notification(
        user_id=leave["user_id"],
        title="Leave rejected",
        body=f"Your leave from {leave['start_date']} to {leave['end_date']} was rejected. Contact your admin for details.",
        category="leave_rejected",
        related_id=leave_id,
    )
    return {"status": "rejected"}


@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    # Enforce that the token maps to the authenticated user (client sends its own user_id).
    payload = {"user_id": user["user_id"], "platform": body.platform, "device_token": body.device_token}
    try:
        resp = await _push_client.post("/api/v1/push/users/register", json=payload)
    except httpx.HTTPError as exc:
        logger.warning("register-push relay error: %s", exc)
        raise HTTPException(502, "Push provider unavailable") from exc
    if resp.status_code == 401:
        raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()
    return {"status": "registered"}



# ---- Company information ----------------------------------------------------------

@api_router.get("/company-info")
async def company_info(request: Request) -> Dict[str, Any]:
    await get_current_user(request)
    announcements = await db.company_announcements.find(
        {"active": True}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    policies = await db.company_policies.find(
        {"active": True}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    holidays = await list_holidays()
    return {
        "announcements": [clean(v) for v in announcements],
        "policies": [clean(v) for v in policies],
        "holidays": holidays,
    }


@api_router.get("/admin/company-info")
async def admin_company_info(request: Request) -> Dict[str, Any]:
    await require_admin(request)
    announcements = await db.company_announcements.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    policies = await db.company_policies.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return {"announcements": [clean(v) for v in announcements], "policies": [clean(v) for v in policies]}


@api_router.post("/admin/company-info/announcements")
async def create_company_announcement(payload: AnnouncementCreate, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    doc = {
        "announcement_id": f"ann_{uuid.uuid4().hex[:12]}",
        "title": payload.title.strip(),
        "body": payload.body.strip(),
        "active": payload.active,
        "created_at": now_utc(),
        "created_by": admin["user_id"],
    }
    await db.company_announcements.insert_one(dict(doc))
    return clean(doc)


@api_router.delete("/admin/company-info/announcements/{announcement_id}")
async def delete_company_announcement(announcement_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    result = await db.company_announcements.delete_one({"announcement_id": announcement_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return {"status": "deleted"}


@api_router.post("/admin/company-info/policies")
async def create_company_policy(payload: PolicyCreate, request: Request) -> Dict[str, Any]:
    admin = await require_admin(request)
    doc = {
        "policy_id": f"pol_{uuid.uuid4().hex[:12]}",
        "title": payload.title.strip(),
        "body": payload.body.strip(),
        "active": payload.active,
        "created_at": now_utc(),
        "created_by": admin["user_id"],
    }
    await db.company_policies.insert_one(dict(doc))
    return clean(doc)


@api_router.delete("/admin/company-info/policies/{policy_id}")
async def delete_company_policy(policy_id: str, request: Request) -> Dict[str, str]:
    await require_admin(request)
    result = await db.company_policies.delete_one({"policy_id": policy_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Policy not found")
    return {"status": "deleted"}



# ---- Notifications --------------------------------------------------------------


async def create_notification(user_id: str, title: str, body: str, category: str, related_id: Optional[str] = None) -> Dict[str, Any]:
    doc = {
        "notification_id": f"ntf_{uuid.uuid4().hex[:12]}",
        "user_id": user_id,
        "title": title,
        "body": body,
        "category": category,
        "related_id": related_id,
        "read": False,
        "created_at": now_utc(),
    }
    await db.notifications.insert_one(dict(doc))
    # Send the same notification as a native push so it is visible even when
    # the app is in the background or closed. The push relay resolves user_id
    # to the device token registered through /register-push.
    try:
        await send_push(
            [user_id],
            {
                "title": title,
                "message": body,
                "category": category,
                "related_id": related_id or "",
            },
            idempotency_key=doc["notification_id"],
        )
    except Exception as exc:
        # In-app notifications must still work even if the external push
        # provider is temporarily unavailable.
        logger.warning("Could not send push notification %s: %s", doc["notification_id"], exc)
    return clean(doc)


@api_router.get("/notifications")
async def list_notifications(request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    docs = await db.notifications.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    unread = sum(1 for doc in docs if not doc.get("read"))
    return {"unread": unread, "items": [clean(doc) for doc in docs]}


@api_router.post("/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    result = await db.notifications.update_one(
        {"notification_id": notification_id, "user_id": user["user_id"]},
        {"$set": {"read": True, "read_at": now_utc()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"status": "read"}


@api_router.post("/notifications/read-all")
async def mark_all_read(request: Request) -> Dict[str, int]:
    user = await get_current_user(request)
    result = await db.notifications.update_many(
        {"user_id": user["user_id"], "read": False},
        {"$set": {"read": True, "read_at": now_utc()}},
    )
    return {"marked": result.modified_count}



# ---- Attendance corrections -------------------------------------------------------

@api_router.post("/attendance-corrections")
async def create_attendance_correction(payload: AttendanceCorrectionCreate, request: Request) -> Dict[str, Any]:
    user = await get_current_user(request)
    await enforce_sensitive_rate_limit(
        user["user_id"],
        "attendance_correction",
        limit=8,
        window_seconds=3600,
    )

    now_wib = to_wib(now_utc())
    try:
        target_day = datetime.strptime(payload.date, "%Y-%m-%d").replace(
            tzinfo=timezone(timedelta(hours=7))
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="Tanggal koreksi tidak valid.")

    target_end = target_day.replace(hour=23, minute=59, second=59)
    deadline = target_end + timedelta(hours=72)
    if target_day.date() > now_wib.date():
        raise HTTPException(status_code=400, detail="Tanggal koreksi tidak boleh berada di masa depan.")
    if now_wib > deadline:
        await write_security_audit(
            user["user_id"],
            "attendance_correction_deadline_blocked",
            outcome="blocked",
            metadata={"date": payload.date},
        )
        raise HTTPException(
            status_code=409,
            detail=f"Batas pengajuan koreksi untuk {payload.date} sudah berakhir. Hubungi administrator teknis bila diperlukan.",
        )

    existing = await db.attendance_corrections.find_one(
        {
            "user_id": user["user_id"],
            "date": payload.date,
            "action": payload.action,
            "status": "pending",
        },
        {"_id": 0, "correction_id": 1},
    )
    if existing:
        raise HTTPException(status_code=409, detail="A pending correction already exists for that date/action")
    doc = {
        "correction_id": f"cor_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "user_name": user.get("full_name") or user.get("name"),
        "user_email": user.get("email"),
        "department": user.get("department"),
        "date": payload.date,
        "action": payload.action,
        "requested_time": payload.requested_time,
        "reason": payload.reason.strip(),
        "attachment": _normalize_support_attachment(payload.attachment),
        "attachment_url": payload.attachment_url.strip() if payload.attachment_url else None,
        "status": "pending",
        "created_at": now_utc(),
    }
    await db.attendance_corrections.insert_one(dict(doc))
    await write_security_audit(
        user["user_id"],
        "attendance_correction_submitted",
        outcome="pending_admin",
        metadata={
            "correction_id": doc["correction_id"],
            "date": payload.date,
            "action": payload.action,
        },
    )
    return _public_request_doc(doc)


@api_router.get("/attendance-corrections")
async def list_my_attendance_corrections(request: Request) -> List[Dict[str, Any]]:
    user = await get_current_user(request)
    docs = await db.attendance_corrections.find(
        {"user_id": user["user_id"]},
        {"_id": 0},
    ).sort("created_at", -1).to_list(200)
    return [_public_request_doc(doc) for doc in docs]


@api_router.post("/attendance-corrections/{correction_id}/cancel")
async def cancel_attendance_correction(correction_id: str, request: Request) -> Dict[str, str]:
    user = await get_current_user(request)
    result = await db.attendance_corrections.update_one(
        {"correction_id": correction_id, "user_id": user["user_id"], "status": "pending"},
        {"$set": {"status": "cancelled", "cancelled_at": now_utc()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Only your pending correction can be cancelled")
    return {"status": "cancelled"}


@api_router.get("/admin/attendance-corrections")
async def admin_list_attendance_corrections(request: Request, status: Optional[str] = None) -> List[Dict[str, Any]]:
    await require_admin(request)
    query: Dict[str, Any] = {}
    if status in {"pending", "approved", "rejected", "cancelled"}:
        query["status"] = status
    docs = await db.attendance_corrections.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [_public_request_doc(doc) for doc in docs]


@api_router.post("/admin/attendance-corrections/{correction_id}/approve")
async def admin_approve_attendance_correction(correction_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    item = await db.attendance_corrections.find_one(
        {"correction_id": correction_id, "status": "pending"},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pending correction not found")

    local_dt = datetime.strptime(
        f"{item['date']} {item['requested_time']}",
        "%Y-%m-%d %H:%M",
    ).replace(tzinfo=timezone(timedelta(hours=7)))
    corrected_at = local_dt.astimezone(timezone.utc)

    existing = await db.attendance.find_one(
        {"user_id": item["user_id"], "date": item["date"], "action": item["action"]},
        {"_id": 0, "attendance_id": 1},
        sort=[("created_at", -1)],
    )
    if existing:
        await db.attendance.update_one(
            {"attendance_id": existing["attendance_id"]},
            {"$set": {
                "created_at": corrected_at,
                "verification": "admin_corrected",
                "corrected_by": admin["user_id"],
                "correction_id": correction_id,
            }},
        )
    else:
        await db.attendance.insert_one({
            "attendance_id": f"att_{uuid.uuid4().hex[:12]}",
            "user_id": item["user_id"],
            "user_email": item.get("user_email"),
            "user_name": item.get("user_name"),
            "department": item.get("department"),
            "date": item["date"],
            "action": item["action"],
            "distance_meters": None,
            "office_name": "Admin correction",
            "verification": "admin_corrected",
            "photo": None,
            "created_at": corrected_at,
            "corrected_by": admin["user_id"],
            "correction_id": correction_id,
        })

    await write_security_audit(
        item["user_id"],
        "attendance_correction_approved",
        outcome="approved",
        metadata={
            "correction_id": correction_id,
            "date": item["date"],
            "action": item["action"],
            "approved_by": admin["user_id"],
        },
    )
    await db.attendance_corrections.update_one(
        {"correction_id": correction_id, "status": "pending"},
        {"$set": {
            "status": "approved",
            "resolved_at": now_utc(),
            "resolved_by": admin["user_id"],
        }},
    )
    await create_notification(
        item["user_id"],
        "Koreksi absensi disetujui",
        f"Your {item['action'].replace('_', ' ')} correction for {item['date']} at {item['requested_time']} was approved.",
        "attendance_correction",
        correction_id,
    )
    return {"status": "approved"}


@api_router.post("/admin/attendance-corrections/{correction_id}/reject")
async def admin_reject_attendance_correction(correction_id: str, request: Request) -> Dict[str, str]:
    admin = await require_admin(request)
    item = await db.attendance_corrections.find_one_and_update(
        {"correction_id": correction_id, "status": "pending"},
        {"$set": {"status": "rejected", "resolved_at": now_utc(), "resolved_by": admin["user_id"]}},
        {"_id": 0},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pending correction not found")
    await write_security_audit(
        item["user_id"],
        "attendance_correction_rejected",
        outcome="rejected",
        metadata={
            "correction_id": correction_id,
            "date": item.get("date"),
            "action": item.get("action"),
            "rejected_by": admin["user_id"],
        },
    )
    await create_notification(
        item["user_id"],
        "Koreksi absensi ditolak",
        f"Your attendance correction for {item['date']} was rejected.",
        "attendance_correction",
        correction_id,
    )
    return {"status": "rejected"}


@api_router.get("/attendance-corrections/{correction_id}/attachment")
async def correction_attachment(correction_id: str, request: Request) -> Response:
    user = await get_current_user(request)
    query: Dict[str, Any] = {"correction_id": correction_id}
    if user.get("role") != "admin":
        query["user_id"] = user["user_id"]
    doc = await db.attendance_corrections.find_one(query, {"_id": 0, "attachment": 1})
    attachment = (doc or {}).get("attachment")
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return Response(
        content=base64.b64decode(attachment["data_base64"]),
        media_type=attachment["mime_type"],
        headers={"Content-Disposition": f'attachment; filename="{attachment["file_name"]}"'},
    )



@api_router.get("/my-monthly-summary")
async def my_monthly_summary(request: Request, year: Optional[int] = None, month: Optional[int] = None) -> Dict[str, Any]:
    user = await get_current_user(request)
    now_wib = to_wib(now_utc())
    selected_year = year or now_wib.year
    selected_month = month or now_wib.month
    if selected_month < 1 or selected_month > 12:
        raise HTTPException(status_code=400, detail="Invalid month")

    schedule = await get_schedule()
    holidays = await list_holidays()
    holiday_dates = {h["date"] for h in holidays}
    month_days = calendar.monthrange(selected_year, selected_month)[1]
    today_str = now_wib.strftime("%Y-%m-%d")
    records = await db.attendance.find(
        {"user_id": user["user_id"], "date": {"$regex": f"^{selected_year:04d}-{selected_month:02d}-"}},
        {"_id": 0, "date": 1, "action": 1, "created_at": 1},
    ).to_list(1000)

    checkins: Dict[str, datetime] = {}
    for row in records:
        if row.get("action") == "check_in" and isinstance(row.get("created_at"), datetime):
            current = checkins.get(row["date"])
            value = as_utc(row["created_at"])
            if current is None or value < current:
                checkins[row["date"]] = value

    approved_leaves = await db.leaves.find(
        {
            "user_id": user["user_id"],
            "status": "approved",
            "start_date": {"$lte": f"{selected_year:04d}-{selected_month:02d}-{month_days:02d}"},
            "end_date": {"$gte": f"{selected_year:04d}-{selected_month:02d}-01"},
        },
        {"_id": 0, "start_date": 1, "end_date": 1},
    ).to_list(500)
    leave_dates = set()
    for leave in approved_leaves:
        leave_dates.update(_iter_date_range(leave["start_date"], leave["end_date"]))

    check_h, check_m = [int(v) for v in schedule.get("check_in", "08:00").split(":")]
    grace = int(schedule.get("grace_minutes", 0))
    scheduled_minutes = check_h * 60 + check_m + grace
    late_days = 0
    late_minutes = 0
    absent_days = 0

    for day in range(1, month_days + 1):
        date_str = f"{selected_year:04d}-{selected_month:02d}-{day:02d}"
        parsed = datetime.strptime(date_str, "%Y-%m-%d")
        if parsed.weekday() == 6 or date_str in holiday_dates:
            continue
        if date_str > today_str:
            continue
        if date_str in leave_dates:
            continue
        checkin = checkins.get(date_str)
        if not checkin:
            absent_days += 1
            continue
        local = to_wib(checkin)
        actual_minutes = local.hour * 60 + local.minute
        if actual_minutes > scheduled_minutes:
            late_days += 1
            late_minutes += actual_minutes - scheduled_minutes

    work_time = await _calculate_work_time(user["user_id"], selected_year, selected_month)
    return {
        "year": selected_year,
        "month": selected_month,
        "late_days": late_days,
        "late_minutes": late_minutes,
        "absent_days": absent_days,
        "work_time": work_time,
    }


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
            wib = to_wib(created_at)
            actual = wib.hour * 60 + wib.minute
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


MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024


@app.middleware("http")
async def security_response_headers(request: Request, call_next):
    # Early body-size rejection prevents oversized JSON/multipart requests from
    # consuming unnecessary application memory. Liveness has an additional
    # endpoint-level streaming limit.
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_HTTP_BODY_BYTES:
                return Response(
                    content='{"detail":"Request terlalu besar"}',
                    status_code=413,
                    media_type="application/json",
                )
        except ValueError:
            return Response(
                content='{"detail":"Content-Length tidak valid"}',
                status_code=400,
                media_type="application/json",
            )

    request_id = secrets.token_hex(12)
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


app.include_router(api_router)

# Native apps do not require CORS. For web builds, set PKUCITY_ALLOWED_ORIGINS
# to an explicit comma-separated list. "*" remains a compatibility fallback,
# but never with credentials.
_allowed_origins_raw = os.getenv("PKUCITY_ALLOWED_ORIGINS", "*").strip()
_allowed_origins = (
    ["*"]
    if not _allowed_origins_raw or _allowed_origins_raw == "*"
    else [origin.strip() for origin in _allowed_origins_raw.split(",") if origin.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-ID"],
    max_age=600,
)


@app.on_event("shutdown")
async def shutdown_db_client() -> None:
    await _push_client.aclose()
    client.close()
