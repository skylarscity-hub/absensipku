# PKUCity Attendance App PRD

## Problem statement
Build a mobile attendance app where employees sign in with verified Google accounts, check in and out with face liveness (video challenge) and realtime location, are rejected when outside any active office boundary or when the liveness check fails, and admins control attendance rules such as offices, weekly schedule, and holidays.

## Architecture
- Expo SDK 54 React Native mobile app (`/app/frontend/app/index.tsx`), file-based routing via Expo Router.
- FastAPI backend on port 8001 (`/app/backend/server.py`) with MongoDB persistence.
- Server-side liveness with MediaPipe FaceLandmarker + OpenCV analyzing a short video challenge.
- Emergent-managed Google OAuth session exchange; session token in SecureStore/localStorage.

## Core features
- Verified Google login (admin bootstrap: `skylarscity@gmail.com`).
- 3-step video liveness challenge (blink / turn left / turn right) with randomized order per session.
- Real-time location vs. **any** active office; nearest office within its radius wins.
- Multi-office admin control (add / activate / deactivate / delete).
- Weekly schedule (check-in, check-out, grace minutes).
- Holidays: on listed dates, attendance is optional (rejected server-side with a friendly message).
- Attendance report per date range with CSV share via native share sheet.
- Admin access request/approval workflow.

## Key endpoints
- Auth: `POST /api/auth/session`, `GET /api/auth/me`.
- Employee: `GET /api/dashboard`, `GET /api/attendance`, `POST /api/attendance`, `POST /api/liveness/session`, `POST /api/liveness/verify`, `POST /api/admin/request`.
- Admin: `GET /api/admin/overview`, `GET|POST /api/admin/offices`, `PATCH|DELETE /api/admin/offices/{id}`, `PATCH /api/admin/settings` (legacy first-office), `PATCH /api/admin/schedule`, `GET|POST /api/admin/holidays`, `DELETE /api/admin/holidays/{id}`, `POST /api/admin/requests/{id}/approve`, `GET /api/admin/reports`, `GET /api/admin/reports/export`.

## Data model (Mongo)
- `users`, `user_sessions` (TTL), `admin_requests`, `attendance` (with `office_id`, `office_name`, `user_email`, `user_name`), `liveness_sessions` (TTL), `liveness_results` (single use per attendance), `offices` (multi), `holidays` (unique date), `schedule` (single doc).

## Recent changes (2026-02)
- Refactored single-office `settings` into a multi-office `offices` collection with migration on startup (legacy doc preserved as first active office).
- Attendance now iterates all active offices, picks nearest, and rejects if outside radius or if the date is a holiday.
- Added Holidays management (admin CRUD) and today's holiday banner on Home.
- Added Reports tab with date-range summary + CSV export shared via native Share sheet.
- Rewrote liveness capture UI: explicit "record video" copy, per-step highlighted prompts, REC badge, and stop button. Recording duration auto-adapts to the number of challenges (2.2s each).
- Home shows "Face liveness (video)" and nearest office name instead of the single office.
- **Onboarding**: new users are forced to complete `full_name` + `department` on first sign-in (`PATCH /api/profile`, gated by `profile_complete` flag).
- **Admin Users tab**: admin can list all users (`GET /api/admin/users`) and edit any user's full name and department (`PATCH /api/admin/users/{id}`).
- **Overtime**: reports calculate overtime minutes per user (latest check-out per day minus scheduled `check_out + grace_minutes`). Shown in the Reports card and included as an "Overtime (min)" column in the CSV export.
- **[P0 BUG FIX]** `create_session` now always forces role=admin for the bootstrap email `PKUCITY_ADMIN_EMAIL` even if an existing user doc has role=employee (previously stuck as employee). Verified by testing agent 14/14 pytest cases (`/app/test_reports/iteration_4.json`).
- **Map picker**: Added `src/components/MapPicker.tsx` (native) and `.web.tsx` fallback. Admin dropping/dragging a pin on Google/Apple Maps auto-fills lat/lng in the office form. Requires `react-native-maps`.
- **Monthly PDF report**: `GET /api/admin/reports/export.pdf` returns a one-page A4 PDF (via `reportlab`) with title, period, and per-employee table including overtime. Frontend downloads and shares via `expo-file-system` + `expo-sharing`.
- **Late banner**: Home shows a red "You checked in N min after the scheduled HH:MM" banner if today's check-in is past `check_in + grace_minutes`.

## Backlog
- P1: Add employee roster / teams; per-team schedules; PDF export.
- P2: Audit log filtering; org branding upload.
