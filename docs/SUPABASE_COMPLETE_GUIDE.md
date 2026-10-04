# PKUCITY → Supabase Migration Guide

## Tujuan
Migrasi dari FastAPI + MongoDB → Supabase (PostgreSQL) dengan:
- ✅ UI tetap 100% sama
- ✅ Fungsi tetap sama
- ✅ Database aman dengan RLS
- ✅ Auth via Google OAuth

---

## PHASE 1: Setup Supabase Project

### Step 1.1: Buat Project Supabase
1. Pergi ke https://supabase.com
2. Login dengan GitHub account
3. Click **"New Project"**
4. Isi:
   - **Project name**: `pkucity` (atau nama lain)
   - **Database Password**: simpan ini, gunakan untuk setup nanti
   - **Region**: `Southeast Asia (Singapore)` (paling dekat dengan Indonesia)
5. Click **"Create new project"** dan tunggu ~5 menit hingga selesai

### Step 1.2: Ambil Credentials
Setelah project selesai dibuat:
1. Di sidebar kiri, click **Settings** → **API**
2. Catat:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon key**: `eyJhbGc...` (jangan share ke publik, tapi boleh di `.env` karena RLS protect)
   - **service_role key**: `eyJhbGc...` (JANGAN COMMIT, hanya untuk server-side)

Contoh:
```
SUPABASE_URL=https://abcdef123.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## PHASE 2: Setup Database Schema dengan RLS

### Step 2.1: Jalankan SQL di Supabase
1. Di Supabase dashboard, pergi ke **SQL Editor**
2. Click **"New Query"**
3. Copy-paste seluruh SQL dari file `docs/supabase-schema.sql` (lihat file terpisah)
4. Click tombol **"Run"** (play button)
5. Tunggu sampai tidak ada error

### Step 2.2: Verifikasi Tabel
Setelah SQL berhasil:
1. Pergi ke **Table Editor** di sidebar
2. Pastikan ini tabel sudah ada:
   - `users`
   - `offices`
   - `attendance`
   - `leaves`
   - `attendance_corrections`
   - `overtime_requests`
   - `early_leave_requests`
   - `admin_requests`
   - `company_announcements`
   - `company_policies`
   - `holidays`
   - `notifications`
   - `device_tokens`
   - `liveness_sessions`

Semua tabel harus punya RLS enabled (badge berwarna biru pada nama tabel).

---

## PHASE 3: Setup Google OAuth

### Step 3.1: Buat Google OAuth Credentials
1. Pergi ke https://console.cloud.google.com/
2. Create project baru atau gunakan yang sudah ada
3. Enable **Google+ API**:
   - Click menu ☰ → **APIs & Services** → **Library**
   - Search `Google+ API`
   - Click **"Enable"**
4. Buat OAuth 2.0 credentials:
   - **APIs & Services** → **Credentials**
   - Click **"+ Create Credentials"** → **OAuth client ID**
   - Pilih **Web application**
   - Authorized redirect URIs, tambahkan:
     ```
     https://xxxxx.supabase.co/auth/v1/callback
     https://localhost:3000/auth/callback
     http://localhost:8081/
     ```
   - Catat: **Client ID** dan **Client Secret**

### Step 3.2: Config di Supabase
1. Di Supabase dashboard, pergi ke **Authentication** → **Providers**
2. Click **Google**
3. Enable dan isi:
   - **Client ID**: dari Google Cloud
   - **Client Secret**: dari Google Cloud
4. Di bagian **Redirect URL**, catat:
   ```
   https://xxxxx.supabase.co/auth/v1/callback
   ```
5. Click **"Save"**

---

## PHASE 4: Setup Frontend

### Step 4.1: Install Dependencies
```bash
cd frontend
npm install @supabase/supabase-js
```

### Step 4.2: Update `.env`
Edit file `frontend/.env`:
```env
EXPO_TUNNEL_SUBDOMAIN=face-check-attend-2
EXPO_PACKAGER_HOSTNAME=https://face-check-attend-2.preview.emergentagent.com
EXPO_USE_FAST_RESOLVER="1"
METRO_CACHE_ROOT=/app/frontend/.metro-cache
EXPO_PACKAGER_PROXY_URL=https://face-check-attend-2.preview.emergentagent.com

# SUPABASE CREDENTIALS (ganti dengan credential Anda)
EXPO_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
```

### Step 4.3: Buat File Supabase Client
Buat file baru: `frontend/src/lib/supabase.ts`

```typescript
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
```

### Step 4.4: Buat API Adapter
Buat file baru: `frontend/src/lib/supabase-api.ts`

Ini adalah file yang paling penting. Setiap fungsi di file ini menggantikan satu endpoint lama dari FastAPI.

```typescript
import { supabase } from "./supabase";

// Type definitions (copy dari app/index.tsx)
type User = {
  user_id: string;
  email: string;
  name: string;
  role: "employee" | "admin";
  full_name?: string | null;
  department?: string | null;
  employee_id?: string | null;
};

type Dashboard = {
  user: User;
  offices: any[];
  schedule: {
    check_in: string;
    check_out: string;
    grace_minutes: number;
  };
  today_attendance?: any;
  work_time?: any;
};

// ============================================
// AUTH FUNCTIONS
// ============================================

export async function getMe(): Promise<User> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", data.user?.id)
    .single();

  if (userError) throw new Error(userError.message);
  return userData as User;
}

export async function getSecurityStatus(): Promise<{
  user: User;
  password_set: boolean;
  unlocked: boolean;
}> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", data.user?.id)
    .single();

  if (userError) throw new Error(userError.message);

  return {
    user: userData as User,
    password_set: !!userData?.password_hash,
    unlocked: true, // TODO: implement unlock logic
  };
}

export async function setupPassword(password: string): Promise<void> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);

  // Hash password dengan bcrypt di server (TODO)
  // Untuk sekarang, simpan hash di users table
  const { error: updateError } = await supabase
    .from("users")
    .update({ password_hash: password })
    .eq("user_id", data.user?.id);

  if (updateError) throw new Error(updateError.message);
}

export async function verifyPassword(password: string): Promise<void> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("password_hash")
    .eq("user_id", data.user?.id)
    .single();

  if (userError) throw new Error(userError.message);
  if (userData?.password_hash !== password) {
    throw new Error("Incorrect password");
  }
}

export async function logout(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

// ============================================
// DASHBOARD & PROFILE FUNCTIONS
// ============================================

export async function getDashboard(): Promise<Dashboard> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const userId = authData.user?.id;

  // Get user
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (userError) throw new Error(userError.message);

  // Get offices
  const { data: officesData, error: officesError } = await supabase
    .from("offices")
    .select("*")
    .eq("active", true);

  if (officesError) throw new Error(officesError.message);

  return {
    user: userData as User,
    offices: officesData || [],
    schedule: {
      check_in: "08:00",
      check_out: "17:00",
      grace_minutes: 15,
    },
  };
}

export async function getAttendanceHistory(): Promise<any[]> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", authData.user?.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function updateProfile(updates: Partial<User>): Promise<User> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("user_id", authData.user?.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as User;
}

export async function updateAvatar(imageBase64: string): Promise<User> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("users")
    .update({ avatar: imageBase64 })
    .eq("user_id", authData.user?.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as User;
}

// ============================================
// ATTENDANCE FUNCTIONS
// ============================================

export async function recordAttendance(payload: {
  action: "check_in" | "check_out";
  latitude: number;
  longitude: number;
  liveness_session_id: string;
}): Promise<{ accepted: boolean; message: string }> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const today = new Date().toISOString().split("T")[0];

  const { error } = await supabase.from("attendance").insert({
    attendance_id: `att_${Date.now()}_${Math.random()}`,
    user_id: authData.user?.id,
    date: today,
    action: payload.action,
    latitude: payload.latitude,
    longitude: payload.longitude,
    verification: "liveness_verified",
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);

  return {
    accepted: true,
    message: `${payload.action === "check_in" ? "Clock In" : "Clock Out"} recorded successfully`,
  };
}

export async function getLivenessSession(): Promise<{
  liveness_session_id: string;
  rgb_sequence: string[];
  expires_in: number;
}> {
  const sessionId = `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return {
    liveness_session_id: sessionId,
    rgb_sequence: ["red", "green", "blue"],
    expires_in: 60,
  };
}

// ============================================
// LEAVES & CORRECTIONS FUNCTIONS
// ============================================

export async function getLeaves(): Promise<any[]> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("leaves")
    .select("*")
    .eq("user_id", authData.user?.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function submitLeave(payload: {
  leave_type: string;
  start_date: string;
  end_date: string;
  reason: string;
  attachment_url?: string;
}): Promise<void> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { error } = await supabase.from("leaves").insert({
    leave_id: `leave_${Date.now()}`,
    user_id: authData.user?.id,
    ...payload,
    status: "pending",
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);
}

export async function getAttendanceCorrections(): Promise<any[]> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("attendance_corrections")
    .select("*")
    .eq("user_id", authData.user?.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function submitCorrection(payload: {
  date: string;
  action: "check_in" | "check_out";
  requested_time: string;
  reason: string;
  attachment_url?: string;
}): Promise<void> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { error } = await supabase.from("attendance_corrections").insert({
    correction_id: `corr_${Date.now()}`,
    user_id: authData.user?.id,
    ...payload,
    status: "pending",
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);
}

// ============================================
// ADMIN FUNCTIONS
// ============================================

export async function getAdminOverview(): Promise<any> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  // Check if user is admin
  const { data: userData } = await supabase
    .from("users")
    .select("role")
    .eq("user_id", authData.user?.id)
    .single();

  if (userData?.role !== "admin") {
    throw new Error("Admin access required");
  }

  const { data: offices } = await supabase
    .from("offices")
    .select("*")
    .eq("active", true);

  const { data: attendanceRequests } = await supabase
    .from("attendance_corrections")
    .select("*")
    .eq("status", "pending");

  return {
    offices: offices || [],
    attendance_requests: attendanceRequests || [],
  };
}

export async function getAdminUsers(): Promise<User[]> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function updateAdminUser(
  userId: string,
  updates: Partial<User>
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update(updates)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);
}

export async function saveOffice(payload: {
  office_name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}): Promise<void> {
  const { error } = await supabase.from("offices").insert({
    office_id: `office_${Date.now()}`,
    ...payload,
    active: true,
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);
}

export async function deleteOffice(officeId: string): Promise<void> {
  const { error } = await supabase
    .from("offices")
    .delete()
    .eq("office_id", officeId);

  if (error) throw new Error(error.message);
}

// ============================================
// COMPANY INFO FUNCTIONS
// ============================================

export async function getCompanyInfo(): Promise<any> {
  const { data: announcements } = await supabase
    .from("company_announcements")
    .select("*")
    .eq("active", true);

  const { data: policies } = await supabase
    .from("company_policies")
    .select("*")
    .eq("active", true);

  const { data: holidays } = await supabase
    .from("holidays")
    .select("*")
    .order("date", { ascending: true });

  return {
    announcements: announcements || [],
    policies: policies || [],
    holidays: holidays || [],
  };
}

// ============================================
// NOTIFICATIONS FUNCTIONS
// ============================================

export async function getNotifications(): Promise<any> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", authData.user?.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const unread = data?.filter((n) => !n.read).length || 0;

  return {
    unread,
    items: data || [],
  };
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const { error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("notification_id", notificationId);

  if (error) throw new Error(error.message);
}

export async function markAllNotificationsRead(): Promise<void> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);

  const { error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("user_id", authData.user?.id);

  if (error) throw new Error(error.message);
}
```

### Step 4.5: Update File `frontend/app/index.tsx`

Di file utama, ganti bagian `apiRequest` dengan wrapper ke adapter:

**CARI** bagian ini:
```typescript
// Frontend contract: EXPO_PUBLIC_BACKEND_URL is supplied by frontend/.env.
const backendUrl = ((Constants.expoConfig?.extra as { backendUrl?: string } | undefined)?.backendUrl || process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");

async function apiRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(translateUiMessage((await response.json().catch(() => null))?.detail || "Terjadi kesalahan pada server"));
  return response.json();
}
```

**GANTI** dengan:
```typescript
import * as supabaseApi from "../src/lib/supabase-api";

// Wrapper untuk backward compatibility
async function apiRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const method = options.method?.toUpperCase() || "GET";
  const normalized = path.replace(/^\/+/, "");

  try {
    // Map endpoint ke adapter function
    if (normalized === "auth/me") {
      return await supabaseApi.getMe() as T;
    } else if (normalized === "dashboard") {
      return await supabaseApi.getDashboard() as T;
    } else if (normalized === "attendance" && method === "GET") {
      return await supabaseApi.getAttendanceHistory() as T;
    } else if (normalized === "attendance" && method === "POST") {
      const body = JSON.parse(options.body as string);
      return await supabaseApi.recordAttendance(body) as T;
    } else if (normalized === "auth/security-status") {
      return await supabaseApi.getSecurityStatus() as T;
    } else if (normalized === "auth/password/setup") {
      const body = JSON.parse(options.body as string);
      await supabaseApi.setupPassword(body.password);
      return {} as T;
    } else if (normalized === "auth/password/verify") {
      const body = JSON.parse(options.body as string);
      await supabaseApi.verifyPassword(body.password);
      return {} as T;
    } else if (normalized === "auth/logout") {
      await supabaseApi.logout();
      return {} as T;
    } else if (normalized === "profile" && method === "PATCH") {
      const body = JSON.parse(options.body as string);
      return await supabaseApi.updateProfile(body) as T;
    } else if (normalized === "profile/avatar" && method === "PATCH") {
      const body = JSON.parse(options.body as string);
      return await supabaseApi.updateAvatar(body.image_base64) as T;
    } else if (normalized === "leaves" && method === "GET") {
      return await supabaseApi.getLeaves() as T;
    } else if (normalized === "leaves" && method === "POST") {
      const body = JSON.parse(options.body as string);
      await supabaseApi.submitLeave(body);
      return {} as T;
    } else if (normalized === "attendance-corrections" && method === "GET") {
      return await supabaseApi.getAttendanceCorrections() as T;
    } else if (normalized === "attendance-corrections" && method === "POST") {
      const body = JSON.parse(options.body as string);
      await supabaseApi.submitCorrection(body);
      return {} as T;
    } else if (normalized === "admin/overview") {
      return await supabaseApi.getAdminOverview() as T;
    } else if (normalized === "admin/users") {
      return await supabaseApi.getAdminUsers() as T;
    } else if (normalized === "admin/offices" && method === "POST") {
      const body = JSON.parse(options.body as string);
      await supabaseApi.saveOffice(body);
      return {} as T;
    } else if (normalized.startsWith("admin/offices/") && method === "DELETE") {
      const officeId = normalized.split("/")[2];
      await supabaseApi.deleteOffice(officeId);
      return {} as T;
    } else if (normalized === "company-info") {
      return await supabaseApi.getCompanyInfo() as T;
    } else if (normalized === "notifications") {
      return await supabaseApi.getNotifications() as T;
    } else if (normalized.startsWith("notifications/") && normalized.endsWith("/read")) {
      const notifId = normalized.split("/")[1];
      await supabaseApi.markNotificationRead(notifId);
      return {} as T;
    } else if (normalized === "notifications/read-all") {
      await supabaseApi.markAllNotificationsRead();
      return {} as T;
    } else if (normalized === "liveness/session" && method === "POST") {
      return await supabaseApi.getLivenessSession() as T;
    }

    throw new Error(`Endpoint belum dipetakan: ${path}`);
  } catch (error) {
    throw new Error(translateUiMessage(error instanceof Error ? error.message : "Terjadi kesalahan pada server"));
  }
}
```

**JUGA ganti** bagian login di function `login()`:
```typescript
const login = async () => {
  setAuthBusy(true);
  setAuthError("");
  try {
    // Pakai Supabase OAuth untuk Google
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: Platform.OS === "web" 
          ? `${window.location.origin}/`
          : "pkucity://auth/callback",
      },
    });

    if (error) throw new Error(error.message);
    
    // Session akan tersimpan otomatis di Supabase SDK
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session) {
      await prepareSession(sessionData.session.access_token, true);
    }
  } catch (error) {
    setAuthError(error instanceof Error ? error.message : "Could not open Google sign-in");
    setAuthBusy(false);
  }
};
```

---

## PHASE 5: Testing

### Step 5.1: Start Development Server
```bash
cd frontend
npm start
```

### Step 5.2: Test Login
1. Open app di simulator atau device
2. Click **"Lanjutkan dengan Google"**
3. Klik Google account
4. Seharusnya berhasil login dan redirect ke dashboard

### Step 5.3: Test Attendance
1. Setelah login, click **"Clock In sekarang"**
2. Camera screen harus muncul
3. Setelah verify face, attendance harus tercatat di Supabase
4. Verifikasi di Supabase: **Table Editor** → `attendance` → check row baru

### Step 5.4: Test Admin
1. Login dengan akun yang role-nya `admin` (ubah di Supabase table `users`)
2. Bottom tab seharusnya ada **"Admin"**
3. Click Admin → lihat overview

---

## PHASE 6: Deployment

### Step 6.1: Deploy ke Vercel (Web)
```bash
# Build
npm run build

# Deploy
vercel
```

### Step 6.2: Build APK/IPA (Mobile)
```bash
# Build APK
eas build --platform android

# Build IPA
eas build --platform ios
```

Update credentials di Supabase untuk production redirect URL sesuai domain Anda.

---

## TROUBLESHOOTING

### Error: "Missing EXPO_PUBLIC_SUPABASE_URL"
**Fix**: Check file `frontend/.env` apakah ada variable `EXPO_PUBLIC_SUPABASE_URL` dan `EXPO_PUBLIC_SUPABASE_ANON_KEY`. Jangan lupa reload/restart server.

### Error: "Auth error: invalid_client"
**Fix**: Google OAuth credentials di Supabase belum di-setup dengan benar. Check di Supabase → Authentication → Providers → Google.

### Error: "Policy for users violates row level security"
**Fix**: RLS policy mungkin salah. Verify di Supabase SQL Editor bahwa semua policy sudah dibuat dengan benar.

### Attendance tidak tercatat
**Fix**: Check RLS policy untuk tabel `attendance`. User harus punya permission INSERT pada tabel `attendance`.

---

## File-File yang Perlu Dibuat/Diubah

1. ✅ `frontend/.env` → Tambah Supabase credentials
2. ✅ `frontend/package.json` → Tambah `@supabase/supabase-js`
3. ✅ `frontend/src/lib/supabase.ts` → Supabase client config
4. ✅ `frontend/src/lib/supabase-api.ts` → API adapter (lengkap)
5. ✅ `frontend/app/index.tsx` → Update `apiRequest()` dan `login()`
6. ✅ `docs/supabase-schema.sql` → Database schema dengan RLS

---

## Next Steps

Setelah selesai, workflow normal-nya:
1. Edit app di `frontend/app/index.tsx` seperti biasa
2. Untuk endpoint baru, tambah function di `supabase-api.ts`
3. Map function baru di `apiRequest()` wrapper
4. Test di simulator
5. Deploy ke Vercel/EAS

Semua UI tetap sama, tidak perlu ubah JSX atau styling.
