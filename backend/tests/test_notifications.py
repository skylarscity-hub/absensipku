"""Backend tests for iteration 6: in-app notifications on leave approve/reject.

Endpoints covered:
  - GET /api/notifications                       (auth-gated, scoped to caller, sorted desc)
  - POST /api/notifications/{id}/read            (single mark-read; 404 on wrong owner)
  - POST /api/notifications/read-all             (bulk mark-read; returns marked count)
  - POST /api/admin/leaves/{id}/approve|reject   (must create leave_approved / leave_rejected)
  - GET /api/dashboard                           (unread_notifications reflects count)

Auth uses the same seed-users + user_sessions pattern as test_new_features.py.
"""
from datetime import datetime, timedelta, timezone
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


def _new_client():
    return AsyncIOMotorClient(MONGO_URL)


@pytest_asyncio.fixture
async def db():
    client = _new_client()
    server.client = client
    server.db = client[DB_NAME]
    yield client[DB_NAME]
    client.close()


async def _seed_user(db, *, role: str, full_name: str = "Test User", department: str = "QA"):
    email = f"TEST_{uuid.uuid4().hex[:8]}@example.com"
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
    await db.notifications.delete_many({"user_id": admin["user_id"]})
    await db.leaves.delete_many({"user_id": admin["user_id"]})


@pytest_asyncio.fixture
async def employee_ctx(db):
    emp = await _seed_user(db, role="employee", full_name="Emp Bob", department="Eng")
    token = await _seed_session(db, emp["user_id"])
    yield {"token": token, "user": emp}
    await db.users.delete_one({"email": emp["email"]})
    await db.user_sessions.delete_one({"session_token": token})
    await db.notifications.delete_many({"user_id": emp["user_id"]})
    await db.leaves.delete_many({"user_id": emp["user_id"]})


@pytest_asyncio.fixture
async def employee_ctx_2(db):
    emp = await _seed_user(db, role="employee", full_name="Emp Carol", department="Eng")
    token = await _seed_session(db, emp["user_id"])
    yield {"token": token, "user": emp}
    await db.users.delete_one({"email": emp["email"]})
    await db.user_sessions.delete_one({"session_token": token})
    await db.notifications.delete_many({"user_id": emp["user_id"]})
    await db.leaves.delete_many({"user_id": emp["user_id"]})


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_leave(token: str, start="2027-06-01", end="2027-06-02") -> str:
    r = requests.post(
        f"{BASE_URL}/api/leaves",
        json={"start_date": start, "end_date": end, "reason": "notif test"},
        headers=_auth(token),
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()["leave_id"]


# ---------------------------------------------------------------------------
# Auth gating on all notification endpoints
# ---------------------------------------------------------------------------

def test_notifications_endpoints_require_auth():
    assert requests.get(f"{BASE_URL}/api/notifications", timeout=15).status_code == 401
    assert requests.post(f"{BASE_URL}/api/notifications/ntf_x/read", timeout=15).status_code == 401
    assert requests.post(f"{BASE_URL}/api/notifications/read-all", timeout=15).status_code == 401


# ---------------------------------------------------------------------------
# Notification creation on approve
# ---------------------------------------------------------------------------

def test_approve_creates_leave_approved_notification(employee_ctx, admin_ctx):
    leave_id = _create_leave(employee_ctx["token"], "2027-06-01", "2027-06-02")
    # Baseline
    before = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    before_ids = {n["notification_id"] for n in before["items"]}
    before_unread = before["unread"]

    r = requests.post(f"{BASE_URL}/api/admin/leaves/{leave_id}/approve", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r.status_code == 200 and r.json()["status"] == "approved"

    r2 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r2.status_code == 200
    body = r2.json()
    assert "unread" in body and "items" in body
    assert body["unread"] == before_unread + 1
    new = [n for n in body["items"] if n["notification_id"] not in before_ids]
    assert len(new) == 1, f"expected exactly one new notification, got {new}"
    n = new[0]
    assert n["category"] == "leave_approved"
    assert n["read"] is False
    assert n["related_id"] == leave_id
    assert n["user_id"] == employee_ctx["user"]["user_id"]
    assert isinstance(n.get("title"), str) and n["title"]
    assert isinstance(n.get("body"), str) and n["body"]

    # Dashboard.unread_notifications reflects it
    r3 = requests.get(f"{BASE_URL}/api/dashboard", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r3.status_code == 200
    assert r3.json().get("unread_notifications") == body["unread"]


# ---------------------------------------------------------------------------
# Notification creation on reject
# ---------------------------------------------------------------------------

def test_reject_creates_leave_rejected_notification(employee_ctx, admin_ctx):
    leave_id = _create_leave(employee_ctx["token"], "2027-07-01", "2027-07-01")
    r = requests.post(f"{BASE_URL}/api/admin/leaves/{leave_id}/reject", headers=_auth(admin_ctx["token"]), timeout=15)
    assert r.status_code == 200 and r.json()["status"] == "rejected"

    r2 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r2.status_code == 200
    items = r2.json()["items"]
    match = [n for n in items if n.get("related_id") == leave_id]
    assert len(match) == 1, f"expected 1 notification for leave, got {match}"
    assert match[0]["category"] == "leave_rejected"
    assert match[0]["read"] is False


# ---------------------------------------------------------------------------
# GET /api/notifications: scoping + sort
# ---------------------------------------------------------------------------

def test_notifications_scoped_to_caller_and_sorted_desc(employee_ctx, employee_ctx_2, admin_ctx):
    # Emp1 gets an approved notification; Emp2 gets a rejected one.
    lv1 = _create_leave(employee_ctx["token"], "2027-08-01", "2027-08-01")
    lv2 = _create_leave(employee_ctx_2["token"], "2027-08-02", "2027-08-02")
    assert requests.post(f"{BASE_URL}/api/admin/leaves/{lv1}/approve", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200
    assert requests.post(f"{BASE_URL}/api/admin/leaves/{lv2}/reject", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200

    r1 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    r2 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx_2["token"]), timeout=15).json()

    # Emp1 sees only own; must not see lv2
    assert all(n["user_id"] == employee_ctx["user"]["user_id"] for n in r1["items"])
    assert all(n.get("related_id") != lv2 for n in r1["items"])
    # Emp2 sees only own; must not see lv1
    assert all(n["user_id"] == employee_ctx_2["user"]["user_id"] for n in r2["items"])
    assert all(n.get("related_id") != lv1 for n in r2["items"])

    # Create a second approved leave for emp1 to verify desc sort.
    lv3 = _create_leave(employee_ctx["token"], "2027-08-05", "2027-08-05")
    assert requests.post(f"{BASE_URL}/api/admin/leaves/{lv3}/approve", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200
    body = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    items = body["items"]
    assert len(items) >= 2
    # created_at should be strictly non-increasing.
    timestamps = [n["created_at"] for n in items]
    assert timestamps == sorted(timestamps, reverse=True), f"notifications not sorted desc: {timestamps}"


# ---------------------------------------------------------------------------
# POST /api/notifications/{id}/read
# ---------------------------------------------------------------------------

def test_mark_single_notification_read_updates_unread(employee_ctx, admin_ctx):
    lv = _create_leave(employee_ctx["token"], "2027-09-01", "2027-09-01")
    assert requests.post(f"{BASE_URL}/api/admin/leaves/{lv}/approve", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200
    listing = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    unread_before = listing["unread"]
    assert unread_before >= 1
    target = next(n for n in listing["items"] if n.get("related_id") == lv)
    nid = target["notification_id"]

    r = requests.post(f"{BASE_URL}/api/notifications/{nid}/read", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r.status_code == 200
    assert r.json().get("status") == "read"

    after = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    assert after["unread"] == unread_before - 1
    marked = next(n for n in after["items"] if n["notification_id"] == nid)
    assert marked["read"] is True

    # Dashboard reflects new count
    d = requests.get(f"{BASE_URL}/api/dashboard", headers=_auth(employee_ctx["token"]), timeout=15).json()
    assert d["unread_notifications"] == after["unread"]


def test_mark_read_wrong_owner_does_not_leak(employee_ctx, employee_ctx_2, admin_ctx):
    lv = _create_leave(employee_ctx["token"], "2027-09-10", "2027-09-10")
    assert requests.post(f"{BASE_URL}/api/admin/leaves/{lv}/approve", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200
    listing = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    nid = next(n for n in listing["items"] if n.get("related_id") == lv)["notification_id"]

    # emp2 tries to mark emp1's notification as read
    r = requests.post(f"{BASE_URL}/api/notifications/{nid}/read", headers=_auth(employee_ctx_2["token"]), timeout=15)
    assert r.status_code in (403, 404), f"leaked cross-user access, got {r.status_code}"

    # And notification is still unread for the real owner.
    after = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    still = next(n for n in after["items"] if n["notification_id"] == nid)
    assert still["read"] is False


def test_mark_read_unknown_id_returns_404(employee_ctx):
    r = requests.post(
        f"{BASE_URL}/api/notifications/ntf_does_not_exist/read",
        headers=_auth(employee_ctx["token"]),
        timeout=15,
    )
    assert r.status_code in (403, 404)


# ---------------------------------------------------------------------------
# POST /api/notifications/read-all
# ---------------------------------------------------------------------------

def test_mark_all_read_marks_only_caller(employee_ctx, employee_ctx_2, admin_ctx):
    # Give emp1 two unread notifications and emp2 one.
    lv_a = _create_leave(employee_ctx["token"], "2027-10-01", "2027-10-01")
    lv_b = _create_leave(employee_ctx["token"], "2027-10-02", "2027-10-02")
    lv_c = _create_leave(employee_ctx_2["token"], "2027-10-03", "2027-10-03")
    for lid in (lv_a, lv_b, lv_c):
        assert requests.post(f"{BASE_URL}/api/admin/leaves/{lid}/approve", headers=_auth(admin_ctx["token"]), timeout=15).status_code == 200

    before_emp1 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    assert before_emp1["unread"] >= 2
    before_emp2 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx_2["token"]), timeout=15).json()
    assert before_emp2["unread"] >= 1

    r = requests.post(f"{BASE_URL}/api/notifications/read-all", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r.status_code == 200
    marked = r.json().get("marked")
    assert isinstance(marked, int) and marked >= 2

    # Emp1: all read now, unread==0
    after_emp1 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx["token"]), timeout=15).json()
    assert after_emp1["unread"] == 0
    assert all(n["read"] is True for n in after_emp1["items"])

    # Emp2: untouched
    after_emp2 = requests.get(f"{BASE_URL}/api/notifications", headers=_auth(employee_ctx_2["token"]), timeout=15).json()
    assert after_emp2["unread"] == before_emp2["unread"]

    # Dashboard reflects zero for emp1
    d = requests.get(f"{BASE_URL}/api/dashboard", headers=_auth(employee_ctx["token"]), timeout=15).json()
    assert d["unread_notifications"] == 0


def test_mark_all_read_when_none_unread_returns_zero(employee_ctx):
    # Fresh employee has no notifications at all.
    r = requests.post(f"{BASE_URL}/api/notifications/read-all", headers=_auth(employee_ctx["token"]), timeout=15)
    assert r.status_code == 200
    assert r.json() == {"marked": 0}
