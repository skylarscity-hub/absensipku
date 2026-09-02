"""Backend regression tests for PKUCity attendance API.

Covers:
  * P0 admin-email bootstrap in create_session (unit-tested with httpx mocked).
  * PDF report auth gating + content validation.
  * Overtime calculation in /api/admin/reports.
  * Department column in CSV export.
  * Admin overview offices/schedule/holidays gating.
  * Unauthenticated protection on core endpoints.

We cannot mint a real Emergent Google OAuth session_id, so authenticated tests seed
`user_sessions` + `users` documents directly via motor and pass a Bearer token.
"""

from datetime import datetime, timedelta, timezone
import os
import uuid

import httpx
import pytest
import pytest_asyncio
import requests
from motor.motor_asyncio import AsyncIOMotorClient

# Import backend server module for direct unit-testing of create_session logic
import server  # type: ignore

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001").rstrip("/")
ADMIN_EMAIL = os.environ["PKUCITY_ADMIN_EMAIL"].strip().lower()
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


def _new_client():
    return AsyncIOMotorClient(MONGO_URL)


@pytest_asyncio.fixture
async def db():
    # Motor binds the AsyncIOMotorClient to the running event loop on creation.
    # pytest-asyncio uses a fresh loop per test, so we rebind server.db too, else
    # server.create_session() (which is what test_admin_email... calls directly)
    # will try to use a client bound to a closed loop => RuntimeError.
    client = _new_client()
    server.client = client
    server.db = client[DB_NAME]
    yield client[DB_NAME]
    client.close()


async def _seed_user(db, *, email: str, role: str, full_name: str = "Test User", department: str = "QA") -> dict:
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


async def _cleanup(db, *, emails=None, tokens=None, user_ids=None):
    if emails:
        await db.users.delete_many({"email": {"$in": emails}})
    if tokens:
        await db.user_sessions.delete_many({"session_token": {"$in": tokens}})
    if user_ids:
        await db.attendance.delete_many({"user_id": {"$in": user_ids}})


# --------------------------------------------------------------------------
# Public / unauth checks
# --------------------------------------------------------------------------

def test_root_ok():
    r = requests.get(f"{BASE_URL}/api/", timeout=15)
    assert r.status_code == 200
    assert r.json()["message"] == "PKUCity attendance API"


def test_admin_endpoints_require_auth():
    endpoints = [
        "/api/admin/overview",
        "/api/admin/offices",
        "/api/admin/holidays",
        "/api/admin/users",
        "/api/admin/reports",
        "/api/admin/reports/export",
        "/api/admin/reports/export.pdf",
    ]
    for ep in endpoints:
        r = requests.get(f"{BASE_URL}{ep}", timeout=15)
        assert r.status_code == 401, f"{ep} without auth => {r.status_code}"


def test_pdf_export_bad_token_401():
    r = requests.get(
        f"{BASE_URL}/api/admin/reports/export.pdf",
        headers={"Authorization": "Bearer nope"},
        timeout=20,
    )
    assert r.status_code == 401


# --------------------------------------------------------------------------
# P0: admin-email bootstrap in create_session
# --------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200

    def json(self):
        return self._payload


class _FakeAsyncClient:
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *args, **kwargs):
        return _FakeResp(self._payload)


@pytest.mark.asyncio
async def test_admin_email_always_gets_admin_role_even_if_existing_employee(db, monkeypatch):
    """Reproduces the P0 bug: an existing user doc with role='employee' for the
    bootstrap admin email MUST be promoted back to admin on next create_session."""
    # Pre-seed the admin user as employee to reproduce the bug scenario.
    await db.users.update_one(
        {"email": ADMIN_EMAIL},
        {"$set": {
            "user_id": "user_TEST_bootstrap_admin",
            "email": ADMIN_EMAIL,
            "name": "Skylar",
            "role": "employee",
            "email_verified": True,
            "profile_complete": False,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )

    fake_token = f"TEST_admin_sess_{uuid.uuid4().hex}"
    payload = {
        "user": {"email": ADMIN_EMAIL, "name": "Skylar", "picture": None},
        "session_token": fake_token,
    }

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(payload))

    req = server.SessionRequest(session_id="fake-google-session")
    resp = await server.create_session(req)
    try:
        assert resp.user.role == "admin", f"admin bootstrap FAILED: got role={resp.user.role}"
        # Confirm persisted user has admin role now.
        user_after = await db.users.find_one({"email": ADMIN_EMAIL}, {"_id": 0})
        assert user_after["role"] == "admin"

        # Repeat login -> still admin.
        resp2 = await server.create_session(req)
        assert resp2.user.role == "admin"
        user_after2 = await db.users.find_one({"email": ADMIN_EMAIL}, {"_id": 0})
        assert user_after2["role"] == "admin"
    finally:
        await db.user_sessions.delete_many({"session_token": fake_token})
        # Leave the admin user in DB (real user) but keep role admin (correct state).


@pytest.mark.asyncio
async def test_non_admin_email_keeps_employee_role(db, monkeypatch):
    email = f"TEST_regular_{uuid.uuid4().hex[:8]}@example.com"
    fake_token = f"TEST_reg_{uuid.uuid4().hex}"
    payload = {"user": {"email": email, "name": "Reg"}, "session_token": fake_token}
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(payload))
    try:
        resp = await server.create_session(server.SessionRequest(session_id="x"))
        assert resp.user.role == "employee"
    finally:
        await _cleanup(db, emails=[email], tokens=[fake_token])


# --------------------------------------------------------------------------
# PDF report validation
# --------------------------------------------------------------------------

@pytest_asyncio.fixture
async def admin_bearer(db):
    email = f"TEST_admin_{uuid.uuid4().hex[:8]}@example.com"
    user = await _seed_user(db, email=email, role="admin", full_name="Admin Tester", department="Ops")
    token = await _seed_session(db, user["user_id"])
    yield token, user
    await _cleanup(db, emails=[email], tokens=[token], user_ids=[user["user_id"]])


@pytest_asyncio.fixture
async def employee_bearer(db):
    email = f"TEST_emp_{uuid.uuid4().hex[:8]}@example.com"
    user = await _seed_user(db, email=email, role="employee", full_name="Emp Tester", department="Eng")
    token = await _seed_session(db, user["user_id"])
    yield token, user
    await _cleanup(db, emails=[email], tokens=[token], user_ids=[user["user_id"]])


def test_pdf_export_forbidden_for_employee(employee_bearer):
    token, _ = employee_bearer
    r = requests.get(
        f"{BASE_URL}/api/admin/reports/export.pdf",
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    assert r.status_code == 403


def test_pdf_export_returns_valid_pdf(admin_bearer):
    token, _ = admin_bearer
    r = requests.get(
        f"{BASE_URL}/api/admin/reports/export.pdf?date_from=2020-01-01&date_to=2030-12-31",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("application/pdf")
    disp = r.headers.get("content-disposition", "")
    assert "attachment" in disp.lower() and ".pdf" in disp.lower()
    assert r.content[:4] == b"%PDF", f"PDF magic missing; first bytes={r.content[:8]!r}"
    # ReportLab writes %%EOF near the end.
    assert b"%%EOF" in r.content[-1024:]


# --------------------------------------------------------------------------
# Overtime + CSV Department column + admin overview
# --------------------------------------------------------------------------

@pytest_asyncio.fixture
async def seeded_attendance(db, admin_bearer):
    """Force schedule=08:00/17:00 grace=15, then insert one check_out at 18:30
    UTC on today's date so overtime should be (18*60+30) - (17*60+15) = 75 min."""
    token, admin_user = admin_bearer

    # Save current schedule to restore later.
    prev = await db.schedule.find_one({"schedule_id": "weekly"}, {"_id": 0}) or {}
    await db.schedule.update_one(
        {"schedule_id": "weekly"},
        {"$set": {"schedule_id": "weekly", "check_in": "08:00", "check_out": "17:00", "grace_minutes": 15}},
        upsert=True,
    )

    # Seed an employee whose attendance we'll aggregate.
    emp_email = f"TEST_ot_{uuid.uuid4().hex[:8]}@example.com"
    emp = await _seed_user(db, email=emp_email, role="employee", full_name="Overtime Owen", department="Finance")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    checkout_dt = datetime.now(timezone.utc).replace(hour=18, minute=30, second=0, microsecond=0)
    checkin_dt = datetime.now(timezone.utc).replace(hour=8, minute=5, second=0, microsecond=0)

    records = [
        {
            "attendance_id": f"att_TEST_{uuid.uuid4().hex[:10]}",
            "user_id": emp["user_id"],
            "user_email": emp_email,
            "user_name": emp["full_name"],
            "department": emp["department"],
            "date": today,
            "action": "check_in",
            "latitude": 0.0, "longitude": 0.0,
            "distance_meters": 5, "office_id": "off_test", "office_name": "PKUCity",
            "verification": "verified", "created_at": checkin_dt,
        },
        {
            "attendance_id": f"att_TEST_{uuid.uuid4().hex[:10]}",
            "user_id": emp["user_id"],
            "user_email": emp_email,
            "user_name": emp["full_name"],
            "department": emp["department"],
            "date": today,
            "action": "check_out",
            "latitude": 0.0, "longitude": 0.0,
            "distance_meters": 5, "office_id": "off_test", "office_name": "PKUCity",
            "verification": "verified", "created_at": checkout_dt,
        },
    ]
    await db.attendance.insert_many(records)
    yield {"token": token, "employee": emp, "today": today, "expected_overtime": 75}

    await db.attendance.delete_many({"user_id": emp["user_id"]})
    await db.users.delete_one({"email": emp_email})
    if prev:
        await db.schedule.update_one({"schedule_id": "weekly"}, {"$set": prev}, upsert=True)


def test_admin_reports_overtime_calculation(seeded_attendance):
    ctx = seeded_attendance
    r = requests.get(
        f"{BASE_URL}/api/admin/reports?date_from={ctx['today']}&date_to={ctx['today']}",
        headers={"Authorization": f"Bearer {ctx['token']}"},
        timeout=20,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["schedule"]["check_out"] == "17:00"
    assert data["schedule"]["grace_minutes"] == 15
    match = [row for row in data["summary"] if row["user_id"] == ctx["employee"]["user_id"]]
    assert match, f"seeded user not present in summary: {data['summary']}"
    row = match[0]
    assert row["check_ins"] == 1 and row["check_outs"] == 1
    assert row["overtime_minutes"] == ctx["expected_overtime"], (
        f"expected {ctx['expected_overtime']}, got {row['overtime_minutes']}"
    )


def test_csv_export_has_department_column(seeded_attendance):
    ctx = seeded_attendance
    r = requests.get(
        f"{BASE_URL}/api/admin/reports/export?date_from={ctx['today']}&date_to={ctx['today']}",
        headers={"Authorization": f"Bearer {ctx['token']}"},
        timeout=20,
    )
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("text/csv")
    text = r.text
    header_line = text.splitlines()[0]
    assert "Department" in header_line, header_line
    # Seeded record should appear with its department value.
    assert "Finance" in text, "seeded department 'Finance' missing from CSV"
    # And Overtime column populated for the check_out row (75 min).
    assert ",75," in text or text.rstrip().endswith(",75") or ",75\n" in text or "75," in text


def test_pdf_summary_contains_seeded_user(seeded_attendance):
    """The PDF stream is compressed by ReportLab so we can't scan bytes for
    column names. Instead we verify the /api/admin/reports summary (which is
    exactly what the PDF renders) exposes the required columns for the seeded
    user, and that the PDF endpoint returns a syntactically valid PDF."""
    ctx = seeded_attendance
    r = requests.get(
        f"{BASE_URL}/api/admin/reports/export.pdf?date_from={ctx['today']}&date_to={ctx['today']}",
        headers={"Authorization": f"Bearer {ctx['token']}"},
        timeout=30,
    )
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"
    assert b"%%EOF" in r.content[-1024:]

    # Verify the summary payload has all six PDF columns for the seeded user.
    r2 = requests.get(
        f"{BASE_URL}/api/admin/reports?date_from={ctx['today']}&date_to={ctx['today']}",
        headers={"Authorization": f"Bearer {ctx['token']}"},
        timeout=15,
    )
    assert r2.status_code == 200
    match = [row for row in r2.json()["summary"] if row["user_id"] == ctx["employee"]["user_id"]]
    assert match, "seeded user missing from summary"
    row = match[0]
    for key in ("name", "email", "check_ins", "check_outs", "overtime_minutes"):
        assert key in row, f"summary row missing {key}"
    assert row["name"] == "Overtime Owen"
    assert row["overtime_minutes"] == 75


def test_attendance_record_stores_full_name_and_department(seeded_attendance, db_client=None):
    """Sanity check: the /api/admin/reports raw rows include department + user_name."""
    ctx = seeded_attendance
    r = requests.get(
        f"{BASE_URL}/api/admin/reports?date_from={ctx['today']}&date_to={ctx['today']}",
        headers={"Authorization": f"Bearer {ctx['token']}"},
        timeout=20,
    )
    assert r.status_code == 200
    rows = [row for row in r.json()["rows"] if row["user_id"] == ctx["employee"]["user_id"]]
    assert rows
    for row in rows:
        assert row.get("department") == "Finance"
        assert row.get("user_name") == "Overtime Owen"


# --------------------------------------------------------------------------
# Admin overview: offices + schedule + holidays
# --------------------------------------------------------------------------

def test_admin_overview_returns_shape(admin_bearer):
    token, _ = admin_bearer
    r = requests.get(
        f"{BASE_URL}/api/admin/overview",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    assert r.status_code == 200
    body = r.json()
    for key in ("settings", "offices", "schedule", "requests", "holidays"):
        assert key in body, f"missing key {key} in overview response"
    assert isinstance(body["offices"], list)
    assert isinstance(body["holidays"], list)
    assert "check_in" in body["schedule"] and "check_out" in body["schedule"]


def test_admin_overview_forbidden_for_employee(employee_bearer):
    token, _ = employee_bearer
    r = requests.get(
        f"{BASE_URL}/api/admin/overview",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    assert r.status_code == 403
