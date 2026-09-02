"""Backend tests for new features added in iteration 5:
   - Leaves (employee + admin flows, approved leave excuses attendance in dashboard).
   - Monthly stats endpoint (/api/admin/stats).
   - Profile avatar (PATCH /api/profile/avatar, GET /api/users/{user_id}/avatar).
   - Attendance proof photo (GET /api/admin/attendance/{id}/photo) + reports has_photo/no leak.

All authenticated flows seed users + user_sessions directly via motor (test_database).
"""
from datetime import datetime, timedelta, timezone
import base64
import os
import uuid

import pytest
import pytest_asyncio
import requests
from motor.motor_asyncio import AsyncIOMotorClient

import server  # type: ignore

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001").rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

# 1x1 red JPEG (~125 bytes). Starts with FFD8 (JPEG magic).
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB"
    "AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AH//Z"
)
TINY_JPEG_DATA_URL = f"data:image/jpeg;base64,{TINY_JPEG_B64}"


def _new_client():
    return AsyncIOMotorClient(MONGO_URL)


@pytest_asyncio.fixture
async def db():
    client = _new_client()
    server.client = client
    server.db = client[DB_NAME]
    yield client[DB_NAME]
    client.close()


async def _seed_user(db, *, role: str, email: str | None = None, full_name: str = "Test User", department: str = "QA"):
    email = email or f"TEST_{uuid.uuid4().hex[:8]}@example.com"
    user_id = f"user_TEST_{uuid.uuid4().hex[:10]}"
    doc = {
        "user_id": user_id,
        "email": email,
        "name": full_name,
        "full_name": full_name,
        "department": department,
        "role": role,
        "email_verified": True,
        "profile_complete": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    await db.users.update_one({"email": email}, {"$set": doc}, upsert=True)
    return doc


async def _seed_session(db, user_id: str) -> str:
    token = f"TEST_tok_{uuid.uuid4().hex}"
    await db.user_sessions.insert_one({
        "session_token": token,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
    })
    return token


@pytest_asyncio.fixture
async def admin_ctx(db):
    admin = await _seed_user(db, role="admin", full_name="Admin Alice", department="Ops")
    token = await _seed_session(db, admin["user_id"])
    yield {"token": token, "user": admin}
    await db.users.delete_one({"email": admin["email"]})
    await db.user_sessions.delete_one({"session_token": token})
    await db.leaves.delete_many({"user_id": admin["user_id"]})


@pytest_asyncio.fixture
async def employee_ctx(db):
    emp = await _seed_user(db, role="employee", full_name="Emp Bob", department="Eng")
    token = await _seed_session(db, emp["user_id"])
    yield {"token": token, "user": emp}
    await db.users.delete_one({"email": emp["email"]})
    await db.user_sessions.delete_one({"session_token": token})
    await db.leaves.delete_many({"user_id": emp["user_id"]})
    await db.attendance.delete_many({"user_id": emp["user_id"]})


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Leaves: employee flow
# ---------------------------------------------------------------------------

def test_leaves_require_auth():
    assert requests.post(f"{BASE_URL}/api/leaves", json={"start_date": "2026-01-01", "end_date": "2026-01-02", "reason": "x"}, timeout=15).status_code == 401
    assert requests.get(f"{BASE_URL}/api/leaves", timeout=15).status_code == 401


def test_create_leave_success_and_list_own(employee_ctx):
    token = employee_ctx["token"]
    payload = {"start_date": "2027-03-10", "end_date": "2027-03-12", "reason": "Family trip"}
    r = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=_auth(token), timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["leave_id"].startswith("lv_")
    assert body["status"] == "pending"
    assert body["start_date"] == "2027-03-10"
    assert body["end_date"] == "2027-03-12"
    assert body["days"] == 3
    # GET returns only my leaves
    r2 = requests.get(f"{BASE_URL}/api/leaves", headers=_auth(token), timeout=15)
    assert r2.status_code == 200
    mine = r2.json()
    assert any(lv["leave_id"] == body["leave_id"] for lv in mine)


def test_create_leave_rejects_end_before_start(employee_ctx):
    token = employee_ctx["token"]
    r = requests.post(
        f"{BASE_URL}/api/leaves",
        json={"start_date": "2027-03-10", "end_date": "2027-03-09", "reason": "typo"},
        headers=_auth(token),
        timeout=15,
    )
    assert r.status_code == 400


def test_list_leaves_isolated_per_user(db, employee_ctx, admin_ctx):
    # Employee creates a leave; admin's /api/leaves must not include it.
    r = requests.post(
        f"{BASE_URL}/api/leaves",
        json={"start_date": "2027-04-01", "end_date": "2027-04-01", "reason": "isolate"},
        headers=_auth(employee_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 200
    leave_id = r.json()["leave_id"]
    r2 = requests.get(f"{BASE_URL}/api/leaves", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r2.status_code == 200
    assert all(lv["leave_id"] != leave_id for lv in r2.json())


# ---------------------------------------------------------------------------
# Leaves: admin flow
# ---------------------------------------------------------------------------

def test_admin_leaves_auth_gating(employee_ctx):
    assert requests.get(f"{BASE_URL}/api/admin/leaves", timeout=15).status_code == 401
    r = requests.get(f"{BASE_URL}/api/admin/leaves", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r.status_code == 403


def test_admin_approve_and_reject_flow(employee_ctx, admin_ctx):
    # Create two leaves as employee.
    def create(start, end):
        r = requests.post(
            f"{BASE_URL}/api/leaves",
            json={"start_date": start, "end_date": end, "reason": "wf"},
            headers=_auth(employee_ctx["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        return r.json()["leave_id"]

    id_ok = create("2027-05-01", "2027-05-02")
    id_rej = create("2027-05-10", "2027-05-11")

    # Approve
    r = requests.post(f"{BASE_URL}/api/admin/leaves/{id_ok}/approve", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    # Approving already-resolved -> 404
    r2 = requests.post(f"{BASE_URL}/api/admin/leaves/{id_ok}/approve", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r2.status_code == 404
    # Unknown id -> 404
    r3 = requests.post(f"{BASE_URL}/api/admin/leaves/lv_doesnotexist/approve", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r3.status_code == 404

    # Reject
    r4 = requests.post(f"{BASE_URL}/api/admin/leaves/{id_rej}/reject", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r4.status_code == 200 and r4.json()["status"] == "rejected"
    r5 = requests.post(f"{BASE_URL}/api/admin/leaves/{id_rej}/reject", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r5.status_code == 404

    # Filter list by status
    r6 = requests.get(f"{BASE_URL}/api/admin/leaves?status=approved", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r6.status_code == 200
    assert any(lv["leave_id"] == id_ok for lv in r6.json())
    assert all(lv.get("status") == "approved" for lv in r6.json())
    r7 = requests.get(f"{BASE_URL}/api/admin/leaves?status=rejected", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r7.status_code == 200
    assert any(lv["leave_id"] == id_rej for lv in r7.json())


# ---------------------------------------------------------------------------
# Approved leave excuses attendance (dashboard.on_leave)
# ---------------------------------------------------------------------------

def test_dashboard_shows_on_leave_when_approved_covers_today(employee_ctx, admin_ctx):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    r = requests.post(
        f"{BASE_URL}/api/leaves",
        json={"start_date": today, "end_date": today, "reason": "sick"},
        headers=_auth(employee_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 200
    leave_id = r.json()["leave_id"]
    r2 = requests.post(f"{BASE_URL}/api/admin/leaves/{leave_id}/approve", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r2.status_code == 200

    r3 = requests.get(f"{BASE_URL}/api/dashboard", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r3.status_code == 200
    body = r3.json()
    assert body.get("on_leave"), f"dashboard.on_leave missing: {body}"
    assert body["on_leave"]["leave_id"] == leave_id
    assert body["on_leave"]["status"] == "approved"


# ---------------------------------------------------------------------------
# Monthly stats
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def stats_seed(db, admin_ctx, employee_ctx):
    # Use isolated future year/month so no other rows collide.
    year, month = 2099, 6  # June 2099 has 30 days
    # Force schedule 08:00 +15m grace (restore afterwards).
    prev = await db.schedule.find_one({"schedule_id": "weekly"}, {"_id": 0}) or {}
    await db.schedule.update_one(
        {"schedule_id": "weekly"},
        {"$set": {"schedule_id": "weekly", "check_in": "08:00", "check_out": "17:00", "grace_minutes": 15}},
        upsert=True,
    )
    emp = employee_ctx["user"]
    # Seed a second employee for the "late" scenario so two different (user,date) rows exist.
    emp2 = await _seed_user(db, role="employee", full_name="Late Larry", department="Eng")

    on_time_date = f"{year:04d}-{month:02d}-05"   # 08:15 exact boundary -> on_time
    late_date = f"{year:04d}-{month:02d}-06"      # 08:20 -> late
    leave_date = f"{year:04d}-{month:02d}-10"     # approved leave covers this day

    def _at(date_str, hour, minute):
        y, m, d = [int(p) for p in date_str.split("-")]
        return datetime(y, m, d, hour, minute, 0, tzinfo=timezone.utc)

    await db.attendance.insert_many([
        {
            "attendance_id": f"att_TEST_{uuid.uuid4().hex[:10]}",
            "user_id": emp["user_id"], "user_email": emp["email"], "user_name": emp["full_name"],
            "department": emp["department"], "date": on_time_date, "action": "check_in",
            "latitude": 0.0, "longitude": 0.0, "distance_meters": 1,
            "office_id": "off_test", "office_name": "PKUCity", "verification": "verified",
            "created_at": _at(on_time_date, 8, 15),
        },
        {
            "attendance_id": f"att_TEST_{uuid.uuid4().hex[:10]}",
            "user_id": emp2["user_id"], "user_email": emp2["email"], "user_name": emp2["full_name"],
            "department": emp2["department"], "date": late_date, "action": "check_in",
            "latitude": 0.0, "longitude": 0.0, "distance_meters": 1,
            "office_id": "off_test", "office_name": "PKUCity", "verification": "verified",
            "created_at": _at(late_date, 8, 20),
        },
    ])
    # Approved leave covering leave_date
    leave_id = f"lv_TEST_{uuid.uuid4().hex[:10]}"
    await db.leaves.insert_one({
        "leave_id": leave_id, "user_id": emp["user_id"], "user_email": emp["email"],
        "user_name": emp["full_name"], "department": emp["department"],
        "start_date": leave_date, "end_date": leave_date, "days": 1, "reason": "PTO",
        "status": "approved", "created_at": datetime.now(timezone.utc),
        "resolved_at": datetime.now(timezone.utc),
    })
    yield {
        "token": admin_ctx["token"], "year": year, "month": month,
        "on_time_date": on_time_date, "late_date": late_date, "leave_date": leave_date,
        "emp": emp, "emp2": emp2, "leave_id": leave_id,
    }
    await db.attendance.delete_many({"user_id": {"$in": [emp["user_id"], emp2["user_id"]]}})
    await db.leaves.delete_many({"leave_id": leave_id})
    await db.users.delete_one({"email": emp2["email"]})
    if prev:
        await db.schedule.update_one({"schedule_id": "weekly"}, {"$set": prev}, upsert=True)


def test_admin_stats_auth_gating(employee_ctx):
    assert requests.get(f"{BASE_URL}/api/admin/stats?year=2099&month=6", timeout=15).status_code == 401
    r = requests.get(f"{BASE_URL}/api/admin/stats?year=2099&month=6", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r.status_code == 403


def test_admin_stats_shape_and_counts(stats_seed):
    ctx = stats_seed
    r = requests.get(
        f"{BASE_URL}/api/admin/stats?year={ctx['year']}&month={ctx['month']}",
        headers=_auth(ctx["token"]),
        timeout=20,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("year", "month", "schedule", "totals", "days"):
        assert k in data, f"missing key {k}"
    assert data["year"] == ctx["year"] and data["month"] == ctx["month"]
    assert data["schedule"]["check_in"] == "08:00"
    assert data["schedule"]["grace_minutes"] == 15
    days = data["days"]
    assert 28 <= len(days) <= 31
    assert len(days) == 30  # June 2099
    by_date = {d["date"]: d for d in days}
    # Boundary: 08:15 with grace 15 => on_time
    assert by_date[ctx["on_time_date"]]["on_time"] >= 1
    assert by_date[ctx["on_time_date"]]["late"] == 0
    # 08:20 => late
    assert by_date[ctx["late_date"]]["late"] >= 1
    assert by_date[ctx["late_date"]]["on_time"] == 0
    # Approved leave day => on_leave incremented
    assert by_date[ctx["leave_date"]]["on_leave"] >= 1
    # totals reflect at least our seeded rows
    assert data["totals"]["on_time"] >= 1
    assert data["totals"]["late"] >= 1
    assert data["totals"]["on_leave"] >= 1
    assert data["totals"]["days_in_month"] == 30


# ---------------------------------------------------------------------------
# Profile avatar
# ---------------------------------------------------------------------------

def test_avatar_requires_auth():
    r = requests.patch(f"{BASE_URL}/api/profile/avatar", json={"image_base64": TINY_JPEG_DATA_URL}, timeout=15)
    assert r.status_code == 401


def test_avatar_upload_and_read(employee_ctx):
    token = employee_ctx["token"]
    r = requests.patch(
        f"{BASE_URL}/api/profile/avatar",
        json={"image_base64": TINY_JPEG_DATA_URL},
        headers=_auth(token),
        timeout=15,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("avatar", "").startswith("data:image/jpeg;base64,")
    # GET avatar
    user_id = employee_ctx["user"]["user_id"]
    r2 = requests.get(f"{BASE_URL}/api/users/{user_id}/avatar", headers=_auth(token), timeout=15)
    assert r2.status_code == 200
    assert r2.headers.get("content-type", "").startswith("image/")
    # magic bytes JPEG FFD8
    assert r2.content[:2] == b"\xff\xd8", f"JPEG magic missing, got {r2.content[:4]!r}"


def test_avatar_non_image_rejected(employee_ctx):
    r = requests.patch(
        f"{BASE_URL}/api/profile/avatar",
        json={"image_base64": "data:application/pdf;base64," + base64.b64encode(b"%PDF-1.4 fake").decode()},
        headers=_auth(employee_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 400


def test_avatar_oversize_rejected(employee_ctx):
    # 900KB of bytes => >800KB limit after b64 decode.
    big = b"\xff" * 900_000
    payload = "data:image/jpeg;base64," + base64.b64encode(big).decode()
    r = requests.patch(
        f"{BASE_URL}/api/profile/avatar",
        json={"image_base64": payload},
        headers=_auth(employee_ctx["token"]),
        timeout=20,
    )
    assert r.status_code == 413


def test_avatar_404_when_not_set(admin_ctx):
    # admin user is freshly seeded with no avatar field -> expect 404.
    from pymongo import MongoClient
    MongoClient(MONGO_URL)[DB_NAME].users.update_one(
        {"user_id": admin_ctx["user"]["user_id"]}, {"$unset": {"avatar": ""}}
    )
    r = requests.get(
        f"{BASE_URL}/api/users/{admin_ctx['user']['user_id']}/avatar",
        headers=_auth(admin_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Attendance proof photo (admin) + reports has_photo
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def attendance_with_photo(db, employee_ctx):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    emp = employee_ctx["user"]
    att_id_with = f"att_TEST_{uuid.uuid4().hex[:10]}"
    att_id_without = f"att_TEST_{uuid.uuid4().hex[:10]}"
    await db.attendance.insert_many([
        {
            "attendance_id": att_id_with, "user_id": emp["user_id"], "user_email": emp["email"],
            "user_name": emp["full_name"], "department": emp["department"], "date": today,
            "action": "check_in", "latitude": 0.0, "longitude": 0.0, "distance_meters": 1,
            "office_id": "off_test", "office_name": "PKUCity", "verification": "verified",
            "photo": TINY_JPEG_DATA_URL, "created_at": datetime.now(timezone.utc),
        },
        {
            "attendance_id": att_id_without, "user_id": emp["user_id"], "user_email": emp["email"],
            "user_name": emp["full_name"], "department": emp["department"], "date": today,
            "action": "check_out", "latitude": 0.0, "longitude": 0.0, "distance_meters": 1,
            "office_id": "off_test", "office_name": "PKUCity", "verification": "verified",
            "created_at": datetime.now(timezone.utc),
        },
    ])
    yield {"today": today, "with": att_id_with, "without": att_id_without, "emp": emp}
    await db.attendance.delete_many({"attendance_id": {"$in": [att_id_with, att_id_without]}})


def test_attendance_photo_admin_returns_jpeg(admin_ctx, attendance_with_photo):
    r = requests.get(
        f"{BASE_URL}/api/admin/attendance/{attendance_with_photo['with']}/photo",
        headers=_auth(admin_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("image/jpeg")
    assert r.content[:2] == b"\xff\xd8", f"JPEG magic FFD8 missing, got {r.content[:4]!r}"


def test_attendance_photo_non_admin_forbidden(employee_ctx, attendance_with_photo):
    r = requests.get(
        f"{BASE_URL}/api/admin/attendance/{attendance_with_photo['with']}/photo",
        headers=_auth(employee_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 403


def test_attendance_photo_missing_returns_404(admin_ctx, attendance_with_photo):
    r = requests.get(
        f"{BASE_URL}/api/admin/attendance/{attendance_with_photo['without']}/photo",
        headers=_auth(admin_ctx["token"]),
        timeout=15,
    )
    assert r.status_code == 404


def test_admin_reports_rows_has_photo_flag_and_no_leak(admin_ctx, attendance_with_photo):
    today = attendance_with_photo["today"]
    r = requests.get(
        f"{BASE_URL}/api/admin/reports?date_from={today}&date_to={today}",
        headers=_auth(admin_ctx["token"]),
        timeout=20,
    )
    assert r.status_code == 200
    body = r.json()
    rows = [row for row in body["rows"] if row.get("attendance_id") in (attendance_with_photo["with"], attendance_with_photo["without"])]
    assert len(rows) == 2, f"expected both seeded rows, got {rows}"
    # No row should leak the base64 photo string.
    assert all("photo" not in row for row in rows), "photo field leaked in report rows"
    assert all("has_photo" in row and isinstance(row["has_photo"], bool) for row in rows)
    by_id = {row["attendance_id"]: row for row in rows}
    assert by_id[attendance_with_photo["with"]]["has_photo"] is True
    assert by_id[attendance_with_photo["without"]]["has_photo"] is False
    # Also make sure the raw JSON blob does not include the base64 tail.
    assert TINY_JPEG_B64[:32] not in r.text
