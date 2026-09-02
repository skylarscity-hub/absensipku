# PKUCity Attendance App PRD

## Problem statement
Build a mobile attendance app where employees sign in with verified Google accounts, check in and out with a face photo and realtime location, are rejected when outside the office boundary or when the liveness check fails, and admins control attendance rules such as work schedules.

## Architecture
- Expo SDK 54 React Native mobile app with Expo Router entry and a single authenticated workspace flow.
- FastAPI backend on port 8001 with MongoDB persistence for users, sessions, attendance, office settings, schedules, and admin requests.
- Emergent-managed Google OAuth session exchange through the backend; session tokens are stored in SecureStore on native and localStorage on web.
- Native camera and foreground location permissions through `expo-camera` and `expo-location`.

## User personas
- Employee: verifies identity, checks current shift/location status, records check-in/out, reviews history, and requests admin access.
- Administrator: reviews access requests, manages office coordinates/radius, and edits the shared weekly schedule.

## Core requirements (static)
- Verified Google login.
- Attendance check-in and check-out with face capture and realtime location.
- Office geofence rejection using an adjustable radius.
- Face liveness rejection flow.
- Attendance history with verification state and distance.
- Admin approval workflow, geofence controls, and one weekly schedule.
- PKUCity red and white visual identity with accessible mobile touch targets.

## Implemented (2026-09-02)
- Built PKUCity login experience with Emergent Google callback parsing, secure session persistence, authenticated API requests, and logout.
- Added backend user/session storage, indexes, dashboard, attendance, history, admin requests, admin approval, geofence settings, and weekly schedule endpoints.
- Added mobile attendance dashboard, location permission/status, guided front-camera selfie capture, history, profile, request-admin flow, and admin control tabs.
- Added camera/location iOS usage descriptions and Android permissions in `app.json`.
- Added regression test IDs and fixed mobile auth-screen horizontal overflow.

## Prioritized backlog
- P0: supply the initial administrator Google email through `PKUCITY_ADMIN_EMAIL`; verify OAuth in a real device session; replace the guided liveness heuristic with a production-grade face/liveness provider before production use.
- P1: add employee roster and team-level permissions; add holidays and schedule exceptions; add admin attendance reports/export.
- P2: add push reminders for missed check-in/out; add audit log filtering; add optional organization branding asset upload.

## Next tasks
1. Configure the initial admin Google identity.
2. Run authenticated device tests for permission prompts, accepted/rejected geofence results, and admin updates.
3. Decide on a production-grade liveness/anti-spoof verification service or a native on-device ML implementation.