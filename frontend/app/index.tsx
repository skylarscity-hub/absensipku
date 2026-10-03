import { Ionicons } from "@expo/vector-icons";
import * as Camera from "expo-camera";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { BlurView } from "expo-blur";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

WebBrowser.maybeCompleteAuthSession();

type User = { user_id: string; email: string; name: string; role: "employee" | "admin"; email_verified: boolean; full_name?: string | null; department?: string | null; employee_id?: string | null; phone?: string | null; address?: string | null; emergency_contact_name?: string | null; emergency_contact_phone?: string | null; annual_leave_quota?: number; profile_complete?: boolean; avatar?: string | null; account_status?: "pending" | "approved" | "rejected"; password_set?: boolean };
type Office = { office_id: string; office_name: string; latitude: number; longitude: number; radius_meters: number; active: boolean };
type Holiday = { holiday_id: string; date: string; label: string };
type SupportAttachmentMeta = { file_name?: string; mime_type?: string; size_bytes?: number };
type Leave = { leave_id: string; user_id: string; user_name?: string; user_email?: string; department?: string; leave_type?: "annual" | "sick" | "permission" | "business_trip"; start_date: string; end_date: string; days: number; reason: string; attachment?: SupportAttachmentMeta | null; attachment_url?: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; created_at?: string };
type AttendanceCorrection = { correction_id: string; user_id: string; user_name?: string; user_email?: string; department?: string; date: string; action: "check_in" | "check_out"; requested_time: string; reason: string; attachment?: SupportAttachmentMeta | null; attachment_url?: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; created_at?: string };
type LeaveBalance = { year: number; quota: number; used: number; remaining: number };
type MyMonthlySummary = { year: number; month: number; late_days: number; late_minutes: number; absent_days: number; work_time: WorkTime };
type CompanyAnnouncement = { announcement_id: string; title: string; body: string; active: boolean; created_at?: string };
type CompanyPolicy = { policy_id: string; title: string; body: string; active: boolean; created_at?: string };
type CompanyInfo = { announcements: CompanyAnnouncement[]; policies: CompanyPolicy[]; holidays: Holiday[] };
type WorkTime = {
  year: number;
  month: number;
  completed_minutes: number;
  completed_regular_minutes?: number;
  completed_overtime_minutes?: number;
  active_minutes: number;
  active_regular_minutes?: number;
  active_overtime_minutes?: number;
  regular_minutes?: number;
  overtime_minutes?: number;
  total_minutes: number;
  completed_seconds?: number;
  completed_regular_seconds?: number;
  completed_overtime_seconds?: number;
  active_seconds?: number;
  active_regular_seconds?: number;
  active_overtime_seconds?: number;
  regular_seconds?: number;
  overtime_seconds?: number;
  total_seconds?: number;
  counting_now?: boolean;
  counting_until?: string | null;
  active: boolean;
  active_since?: string | null;
  missing_checkout?: boolean;
  overtime_approved_until?: string | null;
  days_worked: number;
};

type Dashboard = {
  user: User;
  settings: Office;
  offices: Office[];
  schedule: {
    check_in: string;
    break_start?: string;
    break_end?: string;
    check_out: string;
    grace_minutes: number;
  };
  today?: {
    action?: string;
    created_at?: string;
  };
  today_attendance?: {
    clock_in_at?: string | null;
    clock_out_at?: string | null;
    clock_in_wib?: string | null;
    clock_out_wib?: string | null;
    status: "not_started" | "clocked_in" | "clocked_out";
  };
  work_time?: WorkTime;
  pending_attendance?: AttendanceApproval | null;
  overtime_request?: LemburRequest | null;
  early_leave_request?: EarlyLeaveRequest | null;
  missing_checkout?: {
    date: string;
    check_in_at?: string | null;
    correction_pending: boolean;
    correction_id?: string | null;
  } | null;
  holiday?: {
    label: string;
  } | null;
  on_leave?: Leave | null;
  unread_notifications?: number;
  server_time?: string;
};
type RecordItem = { attendance_id: string; date: string; action: string; distance_meters: number; verification: string; created_at: string; office_name?: string; time_wib?: string | null };
type AttendanceApproval = { request_id: string; user_id: string; user_name?: string; user_email?: string; department?: string; date: string; action: "check_in" | "check_out"; distance_meters: number; office_name?: string; radius_meters?: number; requested_at: string; status: "pending" | "approved" | "rejected" };
type LemburRequest = { request_id: string; user_id: string; user_name?: string; user_email?: string; department?: string; date: string; end_time?: string; reason: string; requested_at: string; status: "pending" | "approved" | "rejected" };
type EarlyLeaveRequest = { request_id: string; user_id: string; user_name?: string; user_email?: string; employee_id?: string; department?: string; date: string; reason: string; requested_at: string; status: "pending" | "approved" | "rejected" | "cancelled" };
type AdminOverview = { settings: Office; offices: Office[]; schedule: Dashboard["schedule"]; requests: { request_id: string; name: string; email: string }[]; account_requests: User[]; attendance_requests: AttendanceApproval[]; overtime_requests: LemburRequest[]; early_leave_requests: EarlyLeaveRequest[]; holidays: Holiday[] };
type HRLeaveBalanceItem = { user_id: string; name: string; email?: string; employee_id?: string; department?: string; quota: number; used: number; remaining: number };
type HRDashboard = {
  date: string;
  year: number;
  is_workday: boolean;
  total_employees: number;
  present_today: number;
  late_today: number;
  on_leave_today: number;
  absent_today: number;
  pending: { accounts: number; attendance: number; overtime: number; early_leave?: number; leaves: number; corrections: number };
  leave_balances: HRLeaveBalanceItem[];
};
type LivenessSession = { liveness_session_id: string; steps: string[]; rgb_sequence?: string[]; expires_in: number };
type ReportSummary = { user_id: string; name: string; email?: string; check_ins: number; check_outs: number; overtime_minutes?: number; last_action?: string; last_at?: string };
type ReportRow = { attendance_id: string; date: string; action: string; user_name?: string; user_email?: string; department?: string; distance_meters?: number; office_name?: string; created_at?: string; has_photo?: boolean; time_wib?: string; actual_time_wib?: string };
type ReportPayload = { date_from: string; date_to: string; total_rows: number; summary: ReportSummary[]; rows: ReportRow[]; schedule?: { check_out: string; grace_minutes: number } };
type StatsDay = { date: string; on_time: number; late: number; on_leave: number; holiday: boolean };
type StatsPayload = { year: number; month: number; schedule: { check_in: string; grace_minutes: number }; totals: { on_time: number; late: number; on_leave: number; days_in_month: number }; days: StatsDay[] };
type AdminWorkTimeItem = WorkTime & {
  user_id: string;
  name: string;
  email?: string;
  department?: string;
  employee_id?: string;
};

type AdminWorkTimePayload = {
  year: number;
  month: number;
  server_time?: string;
  items: AdminWorkTimeItem[];
};
type Notification = { notification_id: string; title: string; body: string; category: string; related_id?: string; read: boolean; created_at: string };
type NotificationList = { unread: number; items: Notification[] };

// Frontend contract: EXPO_PUBLIC_BACKEND_URL is supplied by frontend/.env.
const backendUrl = ((Constants.expoConfig?.extra as { backendUrl?: string } | undefined)?.backendUrl || process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
const tokenKey = "pkucity_session_token";
const deviceKey = "pkucity_device_id";
const usedSessionIds = new Set<string>();


const RGB_FLASH_COLORS: Record<string, string> = {
  red: "rgba(255, 20, 20, 0.92)",
  green: "rgba(20, 255, 80, 0.90)",
  blue: "rgba(25, 90, 255, 0.93)",
};
const RGB_FLASH_SOLID: Record<string, string> = {
  red: "#FF3B30",
  green: "#34C759",
  blue: "#0A84FF",
};

async function saveToken(token: string) {
  if (Platform.OS === "web") window.localStorage.setItem(tokenKey, token);
  else await SecureStore.setItemAsync(tokenKey, token);
}

async function readToken() {
  if (Platform.OS === "web") return window.localStorage.getItem(tokenKey);
  return SecureStore.getItemAsync(tokenKey);
}

async function clearToken() {
  if (Platform.OS === "web") window.localStorage.removeItem(tokenKey);
  else await SecureStore.deleteItemAsync(tokenKey);
}

async function getOrCreateDeviceId() {
  const existing = Platform.OS === "web"
    ? window.localStorage.getItem(deviceKey)
    : await SecureStore.getItemAsync(deviceKey);
  if (existing) return existing;

  const generated = `dev_${Platform.OS}_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  if (Platform.OS === "web") window.localStorage.setItem(deviceKey, generated);
  else await SecureStore.setItemAsync(deviceKey, generated);
  return generated;
}

function sessionIdFromUrl(url: string | null) {
  if (!url) return null;
  const match = url.match(/[?#&]session_id=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function formatWibTime(value?: string | null) {
  if (!value) return "—";

  // Mongo/FastAPI may serialize a UTC datetime without a timezone suffix.
  // Treat a timezone-less value as UTC, never as the phone's local timezone.
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasTimezone ? value : `${value}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "—";

  const wib = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
  const hh = String(wib.getUTCHours()).padStart(2, "0");
  const mm = String(wib.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function getWibNow(baseMs = Date.now()) {
  return new Date(baseMs + 7 * 60 * 60 * 1000);
}

function formatWibClock(baseMs = Date.now()) {
  const d = getWibNow(baseMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} WIB`;
}

function formatWibDate(baseMs = Date.now()) {
  const d = getWibNow(baseMs);
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][d.getUTCDay()];
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"][d.getUTCMonth()];
  return `${hari}, ${d.getUTCDate()} ${bulan} ${d.getUTCFullYear()}`;
}

function formatIndonesianDate(value?: string | null) {
  if (!value) return "—";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return value;
  return `${day} ${bulan[month - 1]} ${year}`;
}


function formatWorkMinutes(totalMinutes: number) {
  const minutes = Math.max(
    0,
    Math.floor(totalMinutes || 0)
  );

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes
    .toString()
    .padStart(2, "0")}m`;
}

function formatWorkSeconds(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}j ${String(minutes).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}d`;
}

function apiUrl(path: string) { return `${backendUrl}/api${path}`; }

function translateUiMessage(message?: string | null) {
  if (!message) return "Terjadi kesalahan pada server.";

  const exact: Record<string, string> = {
    "Authentication required": "Sesi login diperlukan.",
    "Invalid or expired session": "Sesi login sudah berakhir. Silakan login kembali.",
    "Admin access required": "Akses admin diperlukan.",
    "Request not found": "Data permintaan tidak ditemukan.",
    "Pending account not found": "Akun yang menunggu persetujuan tidak ditemukan.",
    "Month must be between 1 and 12": "Bulan harus berada antara 1 sampai 12.",
    "You may only view your own profile": "Anda hanya dapat melihat profil sendiri.",
  };
  if (exact[message]) return exact[message];

  const lower = message.toLowerCase();
  if (lower.includes("something went wrong")) return "Terjadi kesalahan pada server.";
  if (lower.includes("timeout") || lower.includes("timed out")) return "Proses terlalu lama. Silakan coba lagi.";
  if (lower.includes("not found")) return "Data tidak ditemukan.";
  if (lower.includes("network")) return "Koneksi jaringan bermasalah. Silakan coba lagi.";
  if (lower.includes("permission")) return "Izin yang diperlukan belum diberikan.";
  if (lower.includes("authentication") || lower.includes("unauthorized")) return "Sesi login tidak valid. Silakan login kembali.";
  if (lower.includes("forbidden")) return "Anda tidak memiliki izin untuk melakukan tindakan ini.";
  return message;
}

async function apiRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(translateUiMessage((await response.json().catch(() => null))?.detail || "Terjadi kesalahan pada server"));
  return response.json();
}

async function apiRequestText(path: string, token: string): Promise<string> {
  const response = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(translateUiMessage((await response.json().catch(() => null))?.detail || "Terjadi kesalahan pada server"));
  return response.text();
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <View style={compact ? styles.brandCompact : styles.brand}><View style={styles.brandIcon}><Ionicons name="shield-checkmark" size={compact ? 18 : 25} color="#fff" /></View><Text style={compact ? styles.brandTextCompact : styles.brandText}>PKUCITY</Text></View>;
}

function LoadingScreen() {
  return <View style={styles.loading}><BrandMark /><ActivityIndicator color="#DC2626" size="large" /><Text style={styles.actionCaption}>Menyiapkan aplikasi…</Text></View>;
}

function AuthScreen({ onLogin, busy, error }: { onLogin: () => void; busy: boolean; error: string }) {
  return <View style={[styles.authRoot, { overflow: "hidden" }]}>
    <View style={styles.authTop}><View style={styles.redOrb} /><BrandMark /><Text style={styles.eyebrow}>ABSENSI TERVERIFIKASI</Text><Text style={styles.authTitle}>Mulai hari kerja{`\n`}dengan lebih mudah.</Text><Text style={styles.authBody}>Absensi aman dengan verifikasi wajah dan lokasi.</Text></View>
    <View style={styles.authCard}>
      <View style={styles.secureRow}><Ionicons name="lock-closed" size={16} color="#16A34A" /><Text style={styles.secureText}>Dilindungi verifikasi Google</Text></View>
      {!!error && <View style={styles.errorBanner}><Ionicons name="alert-circle" size={18} color="#B91C1C" /><Text style={styles.errorText}>{error}</Text></View>}
      <Pressable testID="google-login-button" accessibilityRole="button" onPress={onLogin} disabled={busy} style={({ pressed }) => [styles.googleButton, pressed && styles.pressed, busy && styles.disabled]}>
        {busy ? <ActivityIndicator color="#DC2626" /> : <><View style={styles.googleBadge}><Text style={styles.googleG}>G</Text></View><Text style={styles.googleButtonText}>Lanjutkan dengan Google</Text><Ionicons name="arrow-forward" size={18} color="#111827" /></>}
      </Pressable>
      <Text style={styles.legal}>Dengan melanjutkan, Anda menyetujui kebijakan absensi perusahaan.</Text>
    </View>
  </View>;
}

function StatusPill({ label, tone = "success" }: { label: string; tone?: "success" | "warning" | "neutral" }) {
  return <View style={[styles.statusPill, tone === "warning" ? styles.warningPill : tone === "neutral" ? styles.neutralPill : styles.successPill]}><View style={[styles.pillDot, tone === "warning" ? styles.warningDot : tone === "neutral" ? styles.neutralDot : styles.successDot]} /><Text style={[styles.pillText, tone === "warning" ? styles.warningText : tone === "neutral" ? styles.neutralText : styles.successText]}>{label}</Text></View>;
}

function HomeScreen({ dashboard, token, onRefresh, onOpenCapture, onOpenNotifications }: { dashboard: Dashboard | null; token: string; onRefresh: () => void; onOpenCapture: (action: "check_in" | "check_out") => void; onOpenNotifications: () => void }) {
  const [locationState, setLocationState] = useState("Mencari lokasi Anda…");
  const [distance, setDistance] = useState<number | null>(null);
  const [locating, setLocating] = useState(true);
  const [nearestName, setNearestName] = useState<string>("");
const [clockNow, setClockNow] = useState(Date.now());
const [serverOffsetMs, setServerOffsetMs] = useState(0);
const [overtimeOpen, setLemburOpen] = useState(false);
const [overtimeAlasan, setLemburAlasan] = useState("");
const [overtimeBusy, setLemburBusy] = useState(false);
const [earlyLeaveOpen, setEarlyLeaveOpen] = useState(false);
const [earlyLeaveReason, setEarlyLeaveReason] = useState("");
const [earlyLeaveBusy, setEarlyLeaveBusy] = useState(false);
const insets = useSafeAreaInsets();

useEffect(() => {
  const interval = setInterval(() => {
    setClockNow(Date.now());
  }, 1000);

  return () => clearInterval(interval);
}, []);

useEffect(() => {
  if (!dashboard?.server_time) return;
  setServerOffsetMs(
    new Date(dashboard.server_time).getTime() - Date.now()
  );
}, [dashboard?.server_time]);
  const offices = useMemo(() => dashboard?.offices || (dashboard?.settings ? [dashboard.settings] : []), [dashboard]);
  const getLocation = useCallback(async () => {
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) { setLocationState("Izin lokasi diperlukan"); setDistance(null); return; }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!offices.length) { setLocationState("Belum ada kantor yang dikonfigurasi"); setDistance(null); return; }
      let best: { meters: number; office: Office } | null = null;
      for (const office of offices) {
        const dLat = (position.coords.latitude - office.latitude) * 111320;
        const dLon = (position.coords.longitude - office.longitude) * 111320 * Math.cos(position.coords.latitude * Math.PI / 180);
        const meters = Math.round(Math.sqrt(dLat * dLat + dLon * dLon));
        if (!best || meters < best.meters) best = { meters, office };
      }
      if (best) {
        setDistance(best.meters);
        setNearestName(best.office.office_name);
        setLocationState(best.meters <= best.office.radius_meters ? "Di dalam area absensi" : "Di luar area absensi");
      }
    } catch { setLocationState("Lokasi tidak tersedia"); setDistance(null); }
    finally { setLocating(false); }
  }, [offices]);
  useEffect(() => { getLocation(); }, [getLocation]);
  const workTime = dashboard?.work_time;
  const pendingAttendance = dashboard?.pending_attendance || null;
  const overtimeRequest = dashboard?.overtime_request || null;
  const earlyLeaveRequest = dashboard?.early_leave_request || null;
  const missingCheckout = dashboard?.missing_checkout || null;
  const todayAttendance = dashboard?.today_attendance;
  const completed = dashboard?.today?.action;

  const submitLembur = async () => {
    if (!overtimeAlasan.trim()) {
      Alert.alert("Alasan required", "Silakan isi alasan lembur.");
      return;
    }
    setLemburBusy(true);
    try {
      const result = await apiRequest<{ message?: string }>("/overtime-requests", token, {
        method: "POST",
        body: JSON.stringify({ reason: overtimeAlasan.trim() }),
      });
      setLemburOpen(false);
      setLemburAlasan("");
      Alert.alert("Lembur request", result.message || "Lembur request sent to admin.");
      onRefresh();
    } catch (error) {
      Alert.alert("Tidak dapat mengajukan lembur", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setLemburBusy(false);
    }
  };
  const submitEarlyLeave = async () => {
    if (!earlyLeaveReason.trim()) {
      Alert.alert("Alasan wajib diisi", "Silakan isi alasan izin pulang cepat.");
      return;
    }
    setEarlyLeaveBusy(true);
    try {
      const result = await apiRequest<{ message?: string }>("/early-leave-requests", token, {
        method: "POST",
        body: JSON.stringify({ reason: earlyLeaveReason.trim() }),
      });
      setEarlyLeaveOpen(false);
      setEarlyLeaveReason("");
      Alert.alert("Izin pulang cepat", result.message || "Pengajuan izin pulang cepat dikirim ke admin.");
      onRefresh();
    } catch (error) {
      Alert.alert("Tidak dapat mengajukan izin pulang cepat", error instanceof Error ? error.message : "Silakan coba lagi.");
    } finally {
      setEarlyLeaveBusy(false);
    }
  };

  const canCheckIn = !workTime?.active;
  const nearestOffice = offices.find((o) => o.office_name === nearestName) || offices[0];
  const inRange = distance !== null && nearestOffice ? distance <= nearestOffice.radius_meters : false;
  const holiday = dashboard?.holiday;
  const onLeave = dashboard?.on_leave || null;
  // Compute lateness if today has a check-in record past scheduled check_in + grace
  const scheduledCheckIn = dashboard?.schedule.check_in || "08:00";
  const graceMinutes = dashboard?.schedule.grace_minutes ?? 0;
  const todayRecord = dashboard?.today;
  let lateMinutes = 0;
  if (todayRecord?.action === "check_in" && todayRecord.created_at) {
    const created = new Date(todayRecord.created_at);
    const [ch, cm] = scheduledCheckIn.split(":").map(Number);
    const scheduledStart = ch * 60 + cm + graceMinutes;
    const actualStart = created.getHours() * 60 + created.getMinutes();
    if (actualStart > scheduledStart) lateMinutes = actualStart - scheduledStart;
  }
  // Backend is authoritative for break overlap, work-end cap and approved overtime.
  // Use second-precision totals from the backend, then tick locally only while
  // the backend explicitly marks the current interval as countable.
  const baseWorkSeconds = workTime?.total_seconds ?? Math.floor((workTime?.total_minutes || 0) * 60);
  let displayedWorkSeconds = baseWorkSeconds;
  if (workTime?.active && workTime?.counting_now && dashboard?.server_time) {
    const serverSnapshotMs = new Date(dashboard.server_time).getTime();
    if (Number.isFinite(serverSnapshotMs)) {
      let estimatedServerNowMs = clockNow + serverOffsetMs;
      if (workTime.counting_until) {
        const countingUntilMs = new Date(workTime.counting_until).getTime();
        if (Number.isFinite(countingUntilMs)) estimatedServerNowMs = Math.min(estimatedServerNowMs, countingUntilMs);
      }
      displayedWorkSeconds += Math.max(0, Math.floor((estimatedServerNowMs - serverSnapshotMs) / 1000));
    }
  }

  const workTimerLabel = formatWorkSeconds(displayedWorkSeconds);
  const captureDisabled =
    locating ||
    !!onLeave ||
    !!pendingAttendance ||
    (!!missingCheckout && canCheckIn);
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 32 }]} showsVerticalScrollIndicator={false}>
    <View style={styles.profileHeaderCard}>
      <View style={styles.profileHeaderLeft}>
        {dashboard?.user && <AvatarView user={dashboard.user} size={58} />}
        <View style={{ flex: 1 }}>
          <Text style={styles.profileHeaderHello}>Selamat datang</Text>
          <Text style={styles.profileHeaderName}>{dashboard?.user.full_name || dashboard?.user.name || "Pengguna"}</Text>
          <Text style={styles.profileHeaderMeta}>Jabatan: {dashboard?.user.department || "—"}</Text>
          <Text style={styles.profileHeaderMeta}>ID Karyawan: {dashboard?.user.employee_id || "—"}</Text>
        </View>
      </View>
      <Pressable testID="notifications-bell-button" onPress={onOpenNotifications} style={styles.bellButton}>
        <Ionicons name="notifications-outline" size={22} color="#111827" />
        {(dashboard?.unread_notifications || 0) > 0 && <View testID="notifications-badge" style={styles.bellBadge}><Text style={styles.bellBadgeText}>{Math.min(dashboard?.unread_notifications || 0, 9)}</Text></View>}
      </Pressable>
    </View>

    <View style={styles.dateTimeCard}>
      <View style={styles.dateTimeIcon}><Ionicons name="time-outline" size={22} color="#DC2626" /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.dateTimeLabel}>WAKTU SEKARANG</Text>
        <Text style={styles.dateTimeValue}>{formatWibClock(clockNow + serverOffsetMs)}</Text>
        <Text style={styles.dateTimeDate}>{formatWibDate(clockNow + serverOffsetMs)}</Text>
      </View>
    </View>
    {!!onLeave && <View testID="on-leave-banner" style={styles.leaveBanner}><Ionicons name="airplane" size={18} color="#1D4ED8" /><Text style={styles.leaveText}>Cuti Anda disetujui sampai {onLeave.end_date}. Absensi tidak diperlukan hari ini.</Text></View>}
    {!!holiday && <View testID="holiday-banner" style={styles.holidayBanner}><Ionicons name="sparkles" size={18} color="#B45309" /><Text style={styles.holidayText}>Hari ini libur · {holiday.label}. Absensi tidak diwajibkan.</Text></View>}
    {lateMinutes > 0 && <View testID="late-banner" style={styles.lateBanner}><Ionicons name="time-outline" size={18} color="#B91C1C" /><Text style={styles.lateText}>Anda terlambat {lateMinutes} menit dari jadwal {scheduledCheckIn}. Usahakan hadir tepat waktu besok.</Text></View>}
    {!!missingCheckout && canCheckIn && (
      <View testID="missing-checkout-banner" style={styles.missingCheckoutBanner}>
        <Ionicons name="alert-circle" size={20} color="#B91C1C" />
        <View style={{ flex: 1 }}>
          <Text style={styles.missingCheckoutTitle}>Clock In terkunci</Text>
          <Text style={styles.missingCheckoutText}>
            Anda belum Clock Out pada {missingCheckout.date}. {missingCheckout.correction_pending
              ? "Koreksi Clock Out sedang menunggu persetujuan admin."
              : "Ajukan Koreksi Absensi untuk Clock Out dari menu Profil, lalu tunggu persetujuan admin."}
          </Text>
        </View>
      </View>
    )}
    <View testID="home-top-attendance-action" style={styles.topAttendanceAction}>
      <Pressable
        testID="attendance-primary-button"
        onPress={() => onOpenCapture(canCheckIn ? "check_in" : "check_out")}
        disabled={captureDisabled}
        style={({ pressed }) => [styles.primaryButton, styles.topAttendanceButton, pressed && styles.pressed, captureDisabled && styles.disabled]}
      >
        <Ionicons name={canCheckIn ? "log-in-outline" : "log-out-outline"} size={22} color="#fff" />
        <Text style={styles.primaryButtonText}>
          {missingCheckout && canCheckIn
            ? "Clock In terkunci"
            : pendingAttendance
              ? "Menunggu persetujuan admin"
              : canCheckIn
                ? "Clock In sekarang"
                : "Clock Out sekarang"}
        </Text>
      </Pressable>
      <Text style={styles.actionCaption}>
        {missingCheckout && canCheckIn
          ? "Selesaikan koreksi Clock Out terlebih dahulu"
          : onLeave
            ? "Anda sedang cuti, tidak perlu absensi"
            : pendingAttendance
              ? `Pengajuan ${pendingAttendance.action === "check_in" ? "Clock In" : "Clock Out"} sedang menunggu persetujuan admin`
              : !inRange
                ? "Di luar radius kantor · perlu persetujuan admin"
                : "Wajah dan lokasi akan diverifikasi"}
      </Text>
    </View>
    <View style={styles.liveCard}>
  <View style={styles.cardTop}>
    <View style={{ flex: 1 }}>
      <Text style={styles.cardKicker}>
        ABSENSI HARI INI
      </Text>

      <Text style={styles.cardTitle}>
        {pendingAttendance
          ? "Menunggu persetujuan admin"
          : todayAttendance?.status === "clocked_out"
            ? `Sudah Clock Out (${todayAttendance.clock_out_wib || "—"} WIB)`
            : todayAttendance?.status === "clocked_in" || workTime?.active
              ? `Sudah Clock In (${todayAttendance?.clock_in_wib || "—"} WIB)`
              : "Belum Clock In"}
      </Text>
      <View style={styles.todayStatusRows}>
        <Text style={styles.todayStatusText}>Clock In: {todayAttendance?.clock_in_wib ? `${todayAttendance.clock_in_wib} WIB` : "Belum"}</Text>
        <Text style={styles.todayStatusText}>Clock Out: {todayAttendance?.clock_out_wib ? `${todayAttendance.clock_out_wib} WIB` : "Belum"}</Text>
      </View>
    </View>

    <StatusPill
      label={
        pendingAttendance
          ? "Menunggu"
          : todayAttendance?.status === "clocked_out"
            ? "Selesai"
            : workTime?.active || todayAttendance?.status === "clocked_in"
              ? "Bekerja"
              : "Belum mulai"
      }
      tone={
        pendingAttendance
          ? "warning"
          : workTime?.active || completed
            ? "success"
            : "neutral"
      }
    />
  </View>

  <View style={styles.rule} />

  <View style={styles.workTimerRow}>
    <View>
      <Text style={styles.miniLabel}>
        WAKTU KERJA BULAN INI
      </Text>

      <Text style={styles.workTimerValue}>
        {workTimerLabel}
      </Text>
    </View>

    {workTime?.active && (
      <View style={styles.timerLiveBadge}>
        <View style={styles.timerLiveDot} />
        <Text style={styles.timerLiveText}>
          LIVE
        </Text>
      </View>
    )}
  </View>

  <View style={styles.rule} />

  <View style={styles.scheduleRow}>
    <View>
      <Text style={styles.miniLabel}>
        JADWAL KERJA
      </Text>

      <Text style={styles.scheduleValue}>
        {dashboard?.schedule.check_in || "08:00"}
        {" — "}
        {dashboard?.schedule.check_out || "17:00"}
      </Text>
    </View>

    <View style={styles.scheduleDivider} />

    <View style={{ flex: 1 }}>
      <Text style={styles.miniLabel}>
        KANTOR TERDEKAT
      </Text>

      <Text style={styles.scheduleValue}>
        {nearestOffice?.office_name || "—"}
      </Text>
    </View>
  </View>
</View>
    <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Verifikasi</Text><Pressable onPress={onRefresh} hitSlop={8}><Ionicons name="refresh" size={20} color="#DC2626" /></Pressable></View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="location" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>Lokasi kantor</Text><Text style={styles.verifySub}>{locating ? locationState : distance === null ? locationState : `${distance} m · ${locationState}`}</Text></View>{locating ? <ActivityIndicator color="#DC2626" /> : <Ionicons name={inRange ? "checkmark-circle" : "alert-circle"} size={22} color={inRange ? "#16A34A" : "#CA8A04"} />}</View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="videocam" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>RGB Flash</Text><Text style={styles.verifySub}>Verifikasi wajah RGB aktif · multi-frame · tanpa mikrofon</Text></View><Ionicons name="shield-checkmark-outline" size={22} color="#16A34A" /></View>
    <Text style={styles.helper}>Di dalam radius {nearestOffice?.radius_meters || 100} meter, absensi tercatat otomatis. Di luar radius kantor, Clock In/Clock Out memerlukan persetujuan admin.</Text>

    {workTime?.active && (
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>Izin Pulang Cepat</Text>
        {earlyLeaveRequest?.status === "pending" ? (
          <>
            <Text style={styles.formHint}>Menunggu persetujuan admin. Anda belum dapat Clock Out sebelum jadwal pulang.</Text>
            <Text style={styles.verifySub}>{earlyLeaveRequest.reason}</Text>
          </>
        ) : earlyLeaveRequest?.status === "approved" ? (
          <>
            <Text style={[styles.formHint, { color: "#15803D" }]}>Disetujui. Anda dapat Clock Out sebelum pukul {dashboard?.schedule.check_out || "17:00"} WIB.</Text>
            <Text style={styles.verifySub}>{earlyLeaveRequest.reason}</Text>
          </>
        ) : earlyLeaveOpen ? (
          <>
            <Text style={styles.formHint}>Ajukan jika Anda perlu pulang sebelum jadwal selesai. Clock Out lebih awal hanya aktif setelah admin menyetujui.</Text>
            <Field label="Alasan" value={earlyLeaveReason} onChangeText={setEarlyLeaveReason} />
            <View style={styles.officeActions}>
              <Pressable onPress={() => setEarlyLeaveOpen(false)} disabled={earlyLeaveBusy} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Batal</Text></Pressable>
              <Pressable testID="submit-early-leave-button" onPress={submitEarlyLeave} disabled={earlyLeaveBusy || !earlyLeaveReason.trim()} style={[styles.primaryButton, { flex: 1 }, !earlyLeaveReason.trim() && styles.disabled]}>
                {earlyLeaveBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Kirim pengajuan</Text>}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.formHint}>Perlu pulang sebelum pukul {dashboard?.schedule.check_out || "17:00"} WIB?</Text>
            <Pressable testID="request-early-leave-button" onPress={() => setEarlyLeaveOpen(true)} style={styles.outlineButton}><Ionicons name="exit-outline" size={18} color="#DC2626" /><Text style={styles.outlineText}>Ajukan izin pulang cepat</Text></Pressable>
          </>
        )}
      </View>
    )}
    {workTime?.active && (
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>Lembur</Text>
        {overtimeRequest?.status === "pending" ? (
          <>
            <Text style={styles.formHint}>Menunggu persetujuan admin. If approved, overtime will count until you check out, up to 06:00 WIB the next day.</Text>
            <Text style={styles.verifySub}>{overtimeRequest.reason}</Text>
          </>
        ) : overtimeRequest?.status === "approved" ? (
          <>
            <Text style={styles.formHint}>Disetujui. Waktu setelah {dashboard?.schedule.check_out || "17:00"} akan dihitung sebagai lembur sampai Anda check-out, maksimal pukul 06.00 WIB hari berikutnya.</Text>
            <Text style={styles.verifySub}>{overtimeRequest.reason}</Text>
          </>
        ) : overtimeOpen ? (
          <>
            <Text style={styles.formHint}>Tidak perlu Clock In kedua. Jika admin menyetujui, lembur dihitung sampai Anda check-out, maksimal pukul 06.00 WIB hari berikutnya.</Text>
            <Field label="Alasan" value={overtimeAlasan} onChangeText={setLemburAlasan} />
            <View style={styles.officeActions}>
              <Pressable onPress={() => setLemburOpen(false)} disabled={overtimeBusy} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Batal</Text></Pressable>
              <Pressable testID="submit-overtime-button" onPress={submitLembur} disabled={overtimeBusy || !overtimeAlasan.trim()} style={[styles.primaryButton, { flex: 1 }, (!overtimeAlasan.trim()) && styles.disabled]}>
                {overtimeBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Kirim pengajuan</Text>}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.formHint}>Perlu bekerja setelah {dashboard?.schedule.check_out || "17:00"}? Ajukan persetujuan sebelum waktu lembur dihitung.</Text>
            <Pressable testID="request-overtime-button" onPress={() => setLemburOpen(true)} style={styles.outlineButton}><Ionicons name="time-outline" size={18} color="#DC2626" /><Text style={styles.outlineText}>Ajukan lembur</Text></Pressable>
          </>
        )}
      </View>
    )}
  </ScrollView>;
}

function CaptureScreen({ action, token, onDone, onBatal }: { action: "check_in" | "check_out"; token: string; onDone: (message: string) => void; onBatal: () => void }) {
  const cameraRef = useRef<Camera.CameraView>(null);
  const [cameraPermission, requestCamera] = Camera.useCameraPermissions();
  const [liveness, setLiveness] = useState<LivenessSession | null>(null);
  const [step, setStep] = useState<"ready" | "recording" | "verifying">("ready");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState(0);
  const [rgbIndex, setRgbIndex] = useState(-1);
  const [retryPreparing, setRetryPreparing] = useState(false);
  const insets = useSafeAreaInsets();

  const issueLivenessSession = useCallback(async (preserveNotice = false) => {
    try {
      if (!preserveNotice) setNotice("");
      setProgress(0);
      setRgbIndex(-1);

      // Keep the current camera screen visible while requesting the next
      // one-time liveness session.
      const session = await apiRequest<LivenessSession>("/liveness/session", token, { method: "POST" });
      setLiveness(session);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Tidak dapat memulai verifikasi RGB Flash.");
    }
  }, [token]);

  useEffect(() => {
    if (cameraPermission?.granted && Platform.OS !== "web") issueLivenessSession();
  }, [cameraPermission?.granted, issueLivenessSession]);

  const capture = async () => {
    if (!cameraRef.current || !liveness || step !== "ready") return;
    setStep("recording");
    setNotice("");
    setProgress(0);

    const rgbSequence = liveness.rgb_sequence || ["red", "green", "blue"];
    setRgbIndex(-1);

    const preRollMs = 500;
    const phaseMs = 950;
    const captureMs = preRollMs + rgbSequence.length * phaseMs + 250;
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      setProgress(Math.min(1, (Date.now() - startedAt) / captureMs));
    }, 80);

    let colorIndex = -1;
    let colorTimer: ReturnType<typeof setInterval> | null = null;
    const firstColorTimer = setTimeout(() => {
      colorIndex = 0;
      setRgbIndex(0);
      colorTimer = setInterval(() => {
        colorIndex += 1;
        if (colorIndex < rgbSequence.length) setRgbIndex(colorIndex);
        else if (colorTimer) {
          clearInterval(colorTimer);
          colorTimer = null;
          setRgbIndex(-1);
        }
      }, phaseMs);
    }, preRollMs);

    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 3.7, maxFileSize: 7_000_000 });
      clearInterval(progressTimer);
      clearTimeout(firstColorTimer);
      if (colorTimer) clearInterval(colorTimer);
      setRgbIndex(-1);
      setProgress(1);
      if (!video?.uri) throw new Error("Video verifikasi wajah tidak berhasil direkam.");

      setStep("verifying");
      setNotice("Memeriksa respons RGB…");
      const uploadPromise = FileSystem.uploadAsync(apiUrl("/liveness/verify"), video.uri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "video",
        mimeType: "video/mp4",
        parameters: { liveness_session_id: liveness.liveness_session_id },
        headers: { Authorization: `Bearer ${token}` },
      });

      const uploadResult = await Promise.race([
        uploadPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Verifikasi wajah habis waktu. Silakan coba lagi.")), 22000);
        }),
      ]);

      let verification: { passed?: boolean; reason?: string; rgb_score?: number } = {};
      try { verification = JSON.parse(uploadResult.body || "{}"); } catch {}
      if (uploadResult.status < 200 || uploadResult.status >= 300 || !verification.passed) {
        const reason = verification.reason || "verification_failed";
        if (reason === "rgb_too_dark") throw new Error("Wajah terlalu gelap. Cari pencahayaan yang lebih baik lalu coba lagi.");
        if (reason === "rgb_face_region_blurry") throw new Error("Wajah terlihat blur. Tahan HP lebih stabil lalu coba lagi.");
        if (reason === "rgb_sequence_not_detected") throw new Error("Respons RGB belum terbaca. Pastikan brightness layar tinggi dan wajah tetap di dalam oval.");
        if (reason === "rgb_frame_missing") throw new Error("Video RGB tidak terbaca dengan baik. Silakan coba lagi.");
        throw new Error("Verifikasi RGB gagal. Silakan coba lagi.");
      }

      setNotice("Wajah berhasil diverifikasi. Memeriksa lokasi…");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const result = await apiRequest<{ accepted: boolean; message: string }>("/attendance", token, {
        method: "POST",
        body: JSON.stringify({ action, latitude: position.coords.latitude, longitude: position.coords.longitude, liveness_session_id: liveness.liveness_session_id }),
      });
      if (!result.accepted) throw new Error(result.message);
      onDone(result.message);
    } catch (error) {
      clearInterval(progressTimer);
      clearTimeout(firstColorTimer);
      if (colorTimer) clearInterval(colorTimer);
      setRgbIndex(-1);
      const message = error instanceof Error ? error.message : "Verifikasi failed. Please try again.";
      setStep("ready");
      setProgress(0);
      setNotice(message);

      // A failed attempt consumes the one-time liveness session.
      // Refresh it in-place instead of switching back to "Menyiapkan verifikasi wajah".
      setRetryPreparing(true);
      await issueLivenessSession(true);
      setRetryPreparing(false);
      setNotice(message);
    }
  };

  if (Platform.OS === "web") return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><Pressable onPress={onBatal} style={styles.backButton}><Ionicons name="arrow-back" size={22} color="#111827" /></Pressable><BrandMark compact /><View style={styles.permissionState}><View style={styles.bigIcon}><Ionicons name="phone-portrait-outline" size={32} color="#DC2626" /></View><Text style={styles.captureTitle}>Use a real device</Text><Text style={styles.captureBody}>RGB Flash requires the native front camera on iOS or Android.</Text></View></View>;
  if (!cameraPermission?.granted) return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><Pressable onPress={onBatal} style={styles.backButton}><Ionicons name="arrow-back" size={22} color="#111827" /></Pressable><BrandMark compact /><View style={styles.permissionState}><View style={styles.bigIcon}><Ionicons name="camera" size={32} color="#DC2626" /></View><Text style={styles.captureTitle}>Camera access needed</Text><Text style={styles.captureBody}>RGB Flash uses a short silent front-camera capture. Microphone/audio is not used.</Text><Pressable testID="camera-permission-button" onPress={requestCamera} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Allow camera</Text></Pressable></View></View>;
  if (!liveness) return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><BrandMark compact /><View style={styles.permissionState}><ActivityIndicator color="#DC2626" size="large" /><Text style={styles.captureTitle}>Preparing face check</Text><Text style={styles.captureBody}>{notice || "Starting RGB Flash…"}</Text></View></View>;

  const isRecording = step === "recording";
  const isVerifying = step === "verifying";
  const rgbSequence = liveness.rgb_sequence || ["red", "green", "blue"];
  const activeRgb = isRecording && rgbIndex >= 0 ? rgbSequence[rgbIndex] : null;
  const progressWidth = `${Math.round(progress * 100)}%` as `${number}%`;

  return <View style={styles.captureRoot}>
    <View style={styles.cameraFrame}>
      <Camera.CameraView ref={cameraRef} facing="front" mode="video" mute videoQuality="480p" style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={styles.cameraShade} />
      <View pointerEvents="none" style={styles.cameraTopShade} />
      <View pointerEvents="none" style={styles.cameraBottomShade} />
      {!!activeRgb && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: RGB_FLASH_COLORS[activeRgb] || "transparent" }]} />}

      <View style={[styles.captureTop, { paddingTop: insets.top + 14 }]}>
        <Pressable onPress={onBatal} disabled={isVerifying} style={[styles.cameraBack, isVerifying && { opacity: 0.45 }]}><Ionicons name="close" size={24} color="#fff" /></Pressable>
        <View style={styles.cameraHeadingWrap}>
          <Text style={styles.cameraTitle}>Verifikasi wajah</Text>
          <Text style={styles.cameraSubtitle}>{action === "check_in" ? "CLOCK IN" : "CLOCK OUT"}</Text>
        </View>
        <View style={styles.secureCameraBadge}><Ionicons name="shield-checkmark" size={16} color="#fff" /></View>
      </View>

      <View pointerEvents="none" style={[styles.faceGuide, isRecording && styles.faceGuideActive]}>
        <View style={styles.faceGuideInner} />
      </View>

      <View pointerEvents="none" style={styles.faceHintWrap}>
        <View style={styles.liveBadge}><View style={[styles.liveDot, isRecording && styles.liveDotActive]} /><Text style={styles.liveBadgeText}>{isRecording ? "MEREKAM" : isVerifying ? "MEMVERIFIKASI" : "RGB FLASH"}</Text></View>
      </View>

      <View style={[styles.captureBottom, { paddingBottom: insets.bottom + 20 }]}>
        <BlurView intensity={38} tint="dark" style={styles.capturePanel}>
          <View style={styles.capturePanelHeader}>
            <View style={styles.capturePanelIcon}><Ionicons name={isVerifying ? "scan" : "person"} size={20} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              {!!activeRgb && <View style={[styles.rgbActiveBadge, { borderColor: RGB_FLASH_SOLID[activeRgb] || "#fff" }]}><View style={[styles.rgbDot, { backgroundColor: RGB_FLASH_SOLID[activeRgb] || "#fff" }]} /><Text style={styles.rgbActiveText}>{activeRgb.toUpperCase()}</Text></View>}
      <Text style={styles.capturePanelTitle}>{isVerifying ? "Memeriksa wajah…" : isRecording ? "Tahan posisi" : notice ? "Verifikasi failed" : "Posisikan wajah di tengah"}</Text>
              <Text style={styles.capturePanelBody}>{isVerifying ? "Mengecek respons warna merah, hijau, dan biru pada wajah." : isRecording ? "Tetap lihat kamera. Layar akan berkedip merah, hijau, dan biru." : notice ? (retryPreparing ? "Preparing a fresh retry…" : "Baca pesan di bawah, lalu coba lagi.") : "Brightness tinggi · wajah di dalam oval"}</Text>
            </View>
          </View>

          {(isRecording || isVerifying) && <View style={styles.scanProgressTrack}><View style={[styles.scanProgressFill, { width: isVerifying ? "100%" : progressWidth }]} /></View>}
          {step === "ready" && !!notice && <View style={styles.cameraError}><Ionicons name="alert-circle" size={16} color="#FECACA" /><Text style={styles.cameraErrorText}>{notice}</Text></View>}

          <View style={styles.captureActionRow}>
            <View style={styles.passiveChip}><Ionicons name="eye-outline" size={15} color="#D1FAE5" /><Text style={styles.passiveChipText}>RGB Aktif</Text></View>
            {step === "ready" ? (
              <Pressable testID="camera-shutter-button" onPress={capture} disabled={retryPreparing} style={({ pressed }) => [styles.scanButton, pressed && styles.pressed, retryPreparing && { opacity: 0.55 }]}>
                {retryPreparing ? <ActivityIndicator color="#fff" /> : <Ionicons name={notice ? "refresh" : "scan"} size={25} color="#fff" />}
              </Pressable>
            ) : (
              <View style={styles.scanButton}>{isVerifying ? <ActivityIndicator color="#fff" /> : <View style={styles.scanPulse} />}</View>
            )}
            <View style={styles.noMicChip}><Ionicons name="mic-off-outline" size={15} color="#E5E7EB" /><Text style={styles.noMicChipText}>Tanpa mikrofon</Text></View>
          </View>
        </BlurView>
      </View>
    </View>
  </View>;
}

function PasswordGateScreen({ mode, token, user, onUnlocked, onLogout }: { mode: "setup" | "unlock"; token: string; user: User; onUnlocked: () => Promise<void>; onLogout: () => void }) {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (password.length < 6) { setError("Kata sandi minimal 10 karakter."); return; }
    if (mode === "setup" && password !== confirm) { setError("Kata sandi tidak sama."); return; }
    setBusy(true); setError("");
    try {
      await apiRequest(mode === "setup" ? "/auth/password/setup" : "/auth/password/verify", token, { method: "POST", body: JSON.stringify({ password }) });
      setPassword(""); setConfirm("");
      await onUnlocked();
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat membuka akun"); }
    finally { setBusy(false); }
  };
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 40 }]}>
      <BrandMark />
      <Text style={styles.eyebrow}>{mode === "setup" ? "AMANKAN AKUN ANDA" : "SELAMAT DATANG KEMBALI"}</Text>
      <Text style={styles.heading}>{mode === "setup" ? "Buat kata sandi" : "Masukkan kata sandi"}</Text>
      <Text style={styles.subheading}>{mode === "setup" ? "This password is required after Google sign-in and whenever PKUCITY has been inactive for 10 minutes." : `Unlock ${user.email}. PKUCITY locks again after 10 minutes away from the app.`}</Text>
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>{mode === "setup" ? "Kata sandi baru" : "Kata sandi akun"}</Text>
        <TextInput testID="account-password-input" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Minimal 6 karakter" placeholderTextColor="#9CA3AF" style={styles.input} />
        {mode === "setup" && <TextInput testID="account-password-confirm" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Konfirmasi kata sandi" placeholderTextColor="#9CA3AF" style={[styles.input, { marginTop: 12 }]} />}
        {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
        <Pressable testID="account-password-submit" onPress={submit} disabled={busy || password.length < 6 || (mode === "setup" && confirm.length < 6)} style={[styles.primaryButton, (busy || password.length < 6 || (mode === "setup" && confirm.length < 6)) && styles.disabled]}>
          {busy ? <ActivityIndicator color="#fff" /> : <><Ionicons name="lock-open-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>{mode === "setup" ? "Simpan kata sandi" : "Buka"}</Text></>}
        </Pressable>
        <Pressable onPress={onLogout} style={[styles.outlineButton, { marginTop: 10 }]}><Text style={styles.outlineText}>Keluar</Text></Pressable>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function HistoryScreen({ records, loading }: { records: RecordItem[]; loading: boolean }) {
  const insets = useSafeAreaInsets();
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]}><Text style={styles.heading}>Riwayat absensi</Text><Text style={styles.subheading}>Riwayat absensi yang telah terverifikasi</Text>{loading ? <ActivityIndicator color="#DC2626" style={{ marginTop: 42 }} /> : records.length === 0 ? <View style={styles.empty}><Ionicons name="calendar-outline" size={35} color="#DC2626" /><Text style={styles.emptyTitle}>Belum ada riwayat</Text><Text style={styles.emptyBody}>Riwayat Clock In dan Clock Out akan tampil di sini.</Text></View> : records.map((record) => <View style={styles.historyCard} key={record.attendance_id}><View style={styles.historyIcon}><Ionicons name={record.action === "check_in" ? "log-in-outline" : "log-out-outline"} size={20} color="#DC2626" /></View><View style={styles.historyCopy}><Text style={styles.historyDate}>{record.date}</Text><Text style={styles.historyTime}>{record.action === "check_in" ? "Clock In" : "Clock Out"} · {record.time_wib || formatWibTime(record.created_at)}{record.office_name ? ` · ${record.office_name}` : ""}</Text></View><View style={styles.historyRight}><StatusPill label="Terverifikasi" /><Text style={styles.distance}>{record.distance_meters}m away</Text></View></View>)}</ScrollView>;
}

// ------------------ Onboarding --------------------------------------------------

function OnboardingScreen({ user, token, onDone }: { user: User; token: string; onDone: (updated: User) => void }) {
  const insets = useSafeAreaInsets();
  const [fullName, setFullName] = useState(user.full_name || user.name || "");
  const [department, setDepartment] = useState(user.department || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!fullName.trim() || !department.trim()) { setError("Silakan lengkapi kedua kolom."); return; }
    setSaving(true); setError("");
    try {
      const updated = await apiRequest<User>("/profile", token, { method: "PATCH", body: JSON.stringify({ full_name: fullName.trim(), department: department.trim() }) });
      onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak dapat menyimpan profil");
    } finally { setSaving(false); }
  };
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
      <BrandMark />
      <Text style={[styles.eyebrow, { marginTop: 30 }]}>WELCOME TO PKUCITY</Text>
      <Text style={styles.heading}>Complete your profile</Text>
      <Text style={styles.subheading}>Tell us your full name and job department so attendance records show the right details.</Text>
      <View style={styles.formCard}>
        <Field label="Nama lengkap" value={fullName} onChangeText={setFullName} />
        <Field label="Departemen / bidang pekerjaan" value={department} onChangeText={setDepartment} />
        {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
        <Pressable testID="onboarding-submit-button" onPress={submit} disabled={saving} style={[styles.primaryButton, saving && styles.disabled]}>
          {saving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="arrow-forward" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Save and continue</Text></>}
        </Pressable>
      </View>
      <Text style={styles.actionCaption}>Signed in as {user.email}</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

// ------------------ Admin -------------------------------------------------------

type AdminTab =
  | "hr"
  | "access"
  | "attendance"
  | "offices"
  | "users"
  | "leaves"
  | "corrections"
  | "company"
  | "holidays"
  | "schedule"
  | "stats"
  | "worktime"
  | "reports";

function AdminScreen({ token }: { token: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tab, setTab] = useState<AdminTab>("hr");
  const [message, setMessage] = useState("");
  const insets = useSafeAreaInsets();
  const load = useCallback(async () => {
    try {
      const data = await apiRequest<AdminOverview>("/admin/overview", token);
      setOverview(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tidak dapat memuat panel admin");
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  const approve = async (id: string) => {
    try { await apiRequest(`/admin/requests/${id}/approve`, token, { method: "POST" }); setMessage("Permintaan admin disetujui."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Tidak dapat menyetujui permintaan"); }
  };
  const tabs: [AdminTab, string][] = [
  ["hr", "HR"],
  ["access", "Akses"],
  ["attendance", "Persetujuan Absensi"],
  ["offices", "Kantor"],
  ["users", "Karyawan"],
  ["leaves", "Cuti"],
  ["corrections", "Koreksi Absensi"],
  ["company", "Perusahaan"],
  ["schedule", "Jadwal"],
  ["holidays", "Hari Libur"],
  ["stats", "Statistik"],
  ["worktime", "Waktu Kerja"],
  ["reports", "Laporan"],
];
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]}>
      <Text style={styles.heading}>Panel Admin</Text>
      <Text style={styles.subheading}>Kelola aturan dan data absensi PKUCITY.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
        {tabs.map(([key, label]) => (
          <Pressable testID={`admin-tab-${key}`} key={key} onPress={() => { setTab(key); setMessage(""); }} style={[styles.segmentChip, tab === key && styles.segmentChipActive]}>
            <Text style={[styles.segmentText, tab === key && styles.segmentTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {!!message && (() => {
        const isError = /terjadi kesalahan|tidak dapat|gagal|error|failed|wrong|timeout/i.test(message);
        return (
          <View style={isError ? styles.adminErrorBanner : styles.successBanner}>
            <Ionicons name={isError ? "alert-circle" : "checkmark-circle"} size={18} color={isError ? "#B91C1C" : "#15803D"} />
            <Text style={isError ? styles.adminErrorBannerText : styles.successBannerText}>{message}</Text>
          </View>
        );
      })()}
      {tab === "hr" && <HRAdminTab token={token} onMessage={setMessage} />}
      {tab === "access" && <AccessTab token={token} overview={overview} onSetujui={approve} onChange={load} onMessage={setMessage} />}
      {tab === "attendance" && <AttendanceApprovalsTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "offices" && <OfficesTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "users" && <UsersTab token={token} onMessage={setMessage} />}
      {tab === "leaves" && <LeavesAdminTab token={token} onMessage={setMessage} />}
      {tab === "corrections" && <CorrectionsAdminTab token={token} onMessage={setMessage} />}
      {tab === "company" && <CompanyAdminTab token={token} onMessage={setMessage} />}
      {tab === "schedule" && <ScheduleTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "holidays" && <HolidaysTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "stats" && <StatsTab token={token} />}
      {tab === "worktime" && <WorkTimeTab token={token} />}
      {tab === "reports" && <ReportsTab token={token} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}


// Tampilan memakai Bahasa Indonesia. Kontrak API tetap standar:
// `check_in`, `check_out`, `employee_id`, `pending`, `approved`, dll. jangan diterjemahkan.
function HRAdminTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [data, setData] = useState<HRDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiRequest<HRDashboard>("/admin/hr-dashboard", token)); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memuat dashboard HR"); }
    finally { setLoading(false); }
  }, [token, onMessage]);
  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  if (!data) return <View style={styles.emptySmall}><Text style={styles.emptyTitle}>Data HR tidak tersedia</Text></View>;

  const pendingTotal = Object.values(data.pending).reduce((sum, value) => sum + value, 0);

  return <View>
    <View style={styles.formCard}>
      <View style={styles.officeRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.formTitle}>Ringkasan HR · {formatIndonesianDate(data.date)}</Text>
          <Text style={styles.formHint}>{data.is_workday ? "Hari kerja aktif" : "Hari libur / bukan hari kerja"} · status absensi realtime</Text>
        </View>
        <Pressable onPress={load} style={styles.outlineButton}><Ionicons name="refresh" size={17} color="#DC2626" /></Pressable>
      </View>

      <View style={styles.hrStatsGrid}>
        <View style={styles.hrStatCard}><Text style={styles.statsTotalValue}>{data.total_employees}</Text><Text style={styles.hrStatLabel}>Karyawan</Text></View>
        <View style={styles.hrStatCard}><Text style={[styles.statsTotalValue, { color: "#15803D" }]}>{data.present_today}</Text><Text style={styles.hrStatLabel}>Hadir</Text></View>
        <View style={styles.hrStatCard}><Text style={[styles.statsTotalValue, { color: "#B91C1C" }]}>{data.late_today}</Text><Text style={styles.hrStatLabel}>Terlambat</Text></View>
        <View style={styles.hrStatCard}><Text style={[styles.statsTotalValue, { color: "#1D4ED8" }]}>{data.on_leave_today}</Text><Text style={styles.hrStatLabel}>Cuti</Text></View>
        <View style={[styles.hrStatCard, styles.hrStatCardWide]}><Text style={[styles.statsTotalValue, { color: "#B45309" }]}>{data.absent_today}</Text><Text style={styles.hrStatLabel}>Tidak hadir</Text></View>
      </View>
    </View>

    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Menunggu tindakan</Text>
      <Text style={styles.formHint}>{pendingTotal} item menunggu tindakan admin.</Text>
      <Text style={styles.verifySub}>Akun baru: {data.pending.accounts}</Text>
      <Text style={styles.verifySub}>Absensi di luar kantor: {data.pending.attendance}</Text>
      <Text style={styles.verifySub}>Lembur: {data.pending.overtime}</Text><Text style={styles.verifySub}>Izin pulang cepat: {data.pending.early_leave || 0}</Text>
      <Text style={styles.verifySub}>Cuti / izin: {data.pending.leaves}</Text>
      <Text style={styles.verifySub}>Koreksi absensi: {data.pending.corrections}</Text>
    </View>

    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Saldo cuti tahunan · {data.year}</Text>
      <Text style={styles.formHint}>Kuota dapat diubah melalui Admin → Karyawan.</Text>
      {data.leave_balances.length === 0 ? <Text style={styles.verifySub}>Belum ada karyawan.</Text> : data.leave_balances.map((item) => (
        <View key={item.user_id} style={[styles.leaveItem, { alignItems: "center" }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.verifyTitle}>{item.name}{item.employee_id ? ` · ${item.employee_id}` : ""}</Text>
            <Text style={styles.verifySub}>{item.department || "—"} · terpakai {item.used} / {item.quota} hari</Text>
          </View>
          <View style={[styles.leaveStatus, item.remaining > 0 ? styles.statusSetujuid : styles.statusTolaked]}>
            <Text style={[styles.leaveStatusText, { color: item.remaining > 0 ? "#15803D" : "#991B1B" }]}>{item.remaining} SISA</Text>
          </View>
        </View>
      ))}
    </View>
  </View>;
}

function AccessTab({ token, overview, onSetujui, onChange, onMessage }: { token: string; overview: AdminOverview | null; onSetujui: (id: string) => void; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const resolveEarlyLeave = async (requestId: string, action: "approve" | "reject") => {
    setBusyId(requestId);
    try {
      await apiRequest(`/admin/early-leave-requests/${requestId}/${action}`, token, { method: "POST" });
      onMessage(`Izin pulang cepat ${action === "approve" ? "disetujui" : "ditolak"}.`);
      await onChange();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Tidak dapat memproses izin pulang cepat");
    } finally { setBusyId(null); }
  };

  if (!overview) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  const accounts = overview.account_requests || [];
  const resolveAccount = async (userId: string, action: "approve" | "reject") => {
    setBusyId(userId);
    try {
      await apiRequest(`/admin/account-requests/${userId}/${action}`, token, { method: "POST" });
      onMessage(`Akun baru ${action === "approve" ? "approved" : "rejected"}.`);
      await onChange();
    } catch (error) { onMessage(error instanceof Error ? error.message : `Tidak dapat ${action === "approve" ? "menyetujui" : "menolak"} akun`); }
    finally { setBusyId(null); }
  };
  if (!overview.requests.length && !accounts.length) return <View style={styles.emptySmall}><Ionicons name="checkmark-done" size={25} color="#16A34A" /><Text style={styles.emptyTitle}>Semua sudah diproses</Text><Text style={styles.emptyBody}>Tidak ada permintaan akun atau akses admin yang menunggu.</Text></View>;
  return <View>
    {accounts.length > 0 && <Text style={[styles.formTitle, { marginBottom: 10 }]}>Persetujuan akun baru</Text>}
    {accounts.map((item) => <View style={styles.requestCard} key={item.user_id}>
      <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(item.name || item.email)}</Text></View>
      <View style={styles.requestCopy}><Text style={styles.verifyTitle}>{item.name || item.email}</Text><Text style={styles.verifySub}>{item.email} · Akun baru</Text></View>
      <View style={{ gap: 6 }}>
        <Pressable onPress={() => resolveAccount(item.user_id, "approve")} disabled={busyId === item.user_id} style={styles.approve}><Text style={styles.approveText}>Setujui</Text></Pressable>
        <Pressable onPress={() => resolveAccount(item.user_id, "reject")} disabled={busyId === item.user_id} style={[styles.approve, styles.dangerButton]}><Text style={styles.approveText}>Tolak</Text></Pressable>
      </View>
    </View>)}
    {overview.requests.length > 0 && <Text style={[styles.formTitle, { marginTop: 14, marginBottom: 10 }]}>Permintaan akses admin</Text>}
    {overview.requests.map((item) => <View style={styles.requestCard} key={item.request_id}>
      <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(item.name)}</Text></View>
      <View style={styles.requestCopy}><Text style={styles.verifyTitle}>{item.name}</Text><Text style={styles.verifySub}>{item.email}</Text></View>
      <Pressable testID={`approve-${item.request_id}`} onPress={() => onSetujui(item.request_id)} style={styles.approve}><Text style={styles.approveText}>Setujui</Text></Pressable>
    </View>)}
  </View>;
}

function AttendanceApprovalsTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const requests = overview?.attendance_requests || [];
  const overtimeRequests = overview?.overtime_requests || [];
  const earlyLeaveRequests = overview?.early_leave_requests || [];

  const resolveAttendance = async (requestId: string, action: "approve" | "reject") => {
    setBusyId(requestId);
    try {
      await apiRequest(`/admin/attendance-requests/${requestId}/${action}`, token, { method: "POST" });
      onMessage(`Permintaan absensi ${action === "approve" ? "disetujui" : "ditolak"}.`);
      await onChange();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : `Tidak dapat ${action === "approve" ? "menyetujui" : "menolak"} permintaan absensi`);
    } finally { setBusyId(null); }
  };

  const resolveLembur = async (requestId: string, action: "approve" | "reject") => {
    setBusyId(requestId);
    try {
      await apiRequest(`/admin/overtime-requests/${requestId}/${action}`, token, { method: "POST" });
      onMessage(`Pengajuan lembur ${action === "approve" ? "disetujui" : "ditolak"}.`);
      await onChange();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : `Tidak dapat ${action === "approve" ? "menyetujui" : "menolak"} pengajuan lembur`);
    } finally { setBusyId(null); }
  };

  if (!overview) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  if (!requests.length && !overtimeRequests.length && !earlyLeaveRequests.length) {
    return <View style={styles.emptySmall}><Ionicons name="checkmark-done" size={25} color="#16A34A" /><Text style={styles.emptyTitle}>Tidak ada persetujuan tertunda</Text><Text style={styles.emptyBody}>Permintaan absensi di luar kantor, lembur, dan izin pulang cepat akan tampil di sini.</Text></View>;
  }

  return <View>
    {requests.map((item) => (
      <View testID={`attendance-approval-${item.request_id}`} style={styles.formCard} key={item.request_id}>
        <Text style={styles.formTitle}>{item.user_name || item.user_email || item.user_id}</Text>
        <Text style={styles.formHint}>{item.department || "—"} · {item.action === "check_in" ? "Clock In" : "Clock Out"} · {new Date(item.requested_at).toLocaleString()}</Text>
        <Text style={styles.verifySub}>{item.distance_meters} m dari {item.office_name || "kantor terdekat"}{item.radius_meters ? ` · radius yang diizinkan ${item.radius_meters} m` : ""}</Text>
        <View style={styles.officeActions}>
          <Pressable testID={`attendance-approve-${item.request_id}`} onPress={() => resolveAttendance(item.request_id, "approve")} disabled={busyId === item.request_id} style={[styles.primaryButton, { flex: 1 }]}>
            {busyId === item.request_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Setujui</Text></>}
          </Pressable>
          <Pressable testID={`attendance-reject-${item.request_id}`} onPress={() => resolveAttendance(item.request_id, "reject")} disabled={busyId === item.request_id} style={[styles.outlineButton, styles.dangerOutline, { flex: 1 }]}>
            <Ionicons name="close" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Tolak</Text>
          </Pressable>
        </View>
      </View>
    ))}
    {earlyLeaveRequests.map((item) => (
      <View testID={`early-leave-approval-${item.request_id}`} style={styles.formCard} key={item.request_id}>
        <Text style={styles.formTitle}>{item.user_name || item.user_email || item.user_id} · Izin Pulang Cepat</Text>
        <Text style={styles.formHint}>{item.department || "—"} · ID Karyawan {item.employee_id || "—"} · {item.date}</Text>
        <Text style={styles.verifySub}>{item.reason}</Text>
        <View style={styles.officeActions}>
          <Pressable onPress={() => resolveEarlyLeave(item.request_id, "approve")} disabled={busyId === item.request_id} style={[styles.primaryButton, { flex: 1 }]}>
            {busyId === item.request_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Setujui</Text></>}
          </Pressable>
          <Pressable onPress={() => resolveEarlyLeave(item.request_id, "reject")} disabled={busyId === item.request_id} style={[styles.outlineButton, styles.dangerOutline, { flex: 1 }]}>
            <Ionicons name="close" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Tolak</Text>
          </Pressable>
        </View>
      </View>
    ))}
    {overtimeRequests.map((item) => (
      <View testID={`overtime-approval-${item.request_id}`} style={styles.formCard} key={item.request_id}>
        <Text style={styles.formTitle}>{item.user_name || item.user_email || item.user_id} · Lembur</Text>
        <Text style={styles.formHint}>{item.department || "—"} · {item.date} · until employee checks out</Text>
        <Text style={styles.verifySub}>{item.reason}</Text>
        <View style={styles.officeActions}>
          <Pressable testID={`overtime-approve-${item.request_id}`} onPress={() => resolveLembur(item.request_id, "approve")} disabled={busyId === item.request_id} style={[styles.primaryButton, { flex: 1 }]}>
            {busyId === item.request_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Setujui overtime</Text></>}
          </Pressable>
          <Pressable testID={`overtime-reject-${item.request_id}`} onPress={() => resolveLembur(item.request_id, "reject")} disabled={busyId === item.request_id} style={[styles.outlineButton, styles.dangerOutline, { flex: 1 }]}>
            <Ionicons name="close" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Tolak</Text>
          </Pressable>
        </View>
      </View>
    ))}
  </View>;
}

function OfficesTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [form, setForm] = useState({ office_name: "", latitude: "", longitude: "", radius_meters: "100" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const useCurrentGps = async () => {
    setBusyId("gps");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        onMessage("Izin lokasi diperlukan untuk menggunakan posisi GPS saat ini.");
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setForm((prev) => ({
        ...prev,
        latitude: position.coords.latitude.toFixed(6),
        longitude: position.coords.longitude.toFixed(6),
      }));
      onMessage("Posisi GPS saat ini telah dimasukkan ke koordinat kantor.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Tidak dapat mengambil posisi GPS saat ini");
    } finally {
      setBusyId(null);
    }
  };
  const submit = async () => {
    setBusyId("new");
    try {
      await apiRequest("/admin/offices", token, {
        method: "POST",
        body: JSON.stringify({ office_name: form.office_name.trim(), latitude: Number(form.latitude), longitude: Number(form.longitude), radius_meters: Number(form.radius_meters), active: true }),
      });
      onMessage(`Office "${form.office_name}" added.`);
      setForm({ office_name: "", latitude: "", longitude: "", radius_meters: "100" });
      await onChange();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Tidak dapat menambah kantor");
    } finally { setBusyId(null); }
  };
  const toggleActive = async (office: Office) => {
    setBusyId(office.office_id);
    try { await apiRequest(`/admin/offices/${office.office_id}`, token, { method: "PATCH", body: JSON.stringify({ active: !office.active }) }); onMessage(`Office "${office.office_name}" ${office.active ? "deactivated" : "activated"}.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Tidak dapat memperbarui kantor"); }
    finally { setBusyId(null); }
  };
  const remove = async (office: Office) => {
    setBusyId(office.office_id);
    try { await apiRequest(`/admin/offices/${office.office_id}`, token, { method: "DELETE" }); onMessage(`Office "${office.office_name}" deleted.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Tidak dapat menghapus kantor"); }
    finally { setBusyId(null); }
  };
  return <View>
    {(overview?.offices || []).map((office) => (
      <View testID={`office-card-${office.office_id}`} style={styles.formCard} key={office.office_id}>
        <View style={styles.officeRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.formTitle}>{office.office_name}</Text>
            <Text style={styles.formHint}>{office.latitude.toFixed(5)}, {office.longitude.toFixed(5)} · {office.radius_meters}m radius</Text>
          </View>
          <View style={[styles.activeBadge, office.active ? styles.activeBadgeOn : styles.activeBadgeOff]}>
            <Text style={[styles.activeBadgeText, office.active ? styles.activeBadgeTextOn : styles.activeBadgeTextOff]}>{office.active ? "AKTIF" : "NONAKTIF"}</Text>
          </View>
        </View>
        <View style={styles.officeActions}>
          <Pressable testID={`office-toggle-${office.office_id}`} onPress={() => toggleActive(office)} disabled={busyId === office.office_id} style={styles.outlineButton}>
            {busyId === office.office_id ? <ActivityIndicator color="#DC2626" /> : <><Ionicons name={office.active ? "pause" : "play"} size={16} color="#DC2626" /><Text style={styles.outlineText}>{office.active ? "Nonaktifkan" : "Aktifkan"}</Text></>}
          </Pressable>
          <Pressable testID={`office-delete-${office.office_id}`} onPress={() => remove(office)} disabled={busyId === office.office_id} style={[styles.outlineButton, styles.dangerOutline]}>
            <Ionicons name="trash-outline" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Hapus</Text>
          </Pressable>
        </View>
      </View>
    ))}
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Tambah kantor lain</Text>
      <Text style={styles.formHint}>Gunakan posisi GPS saat ini atau masukkan lintang dan bujur secara manual.</Text>
      <Pressable testID="office-use-current-gps" onPress={useCurrentGps} disabled={busyId === "gps"} style={styles.outlineButton}>
        {busyId === "gps" ? <ActivityIndicator color="#DC2626" /> : <><Ionicons name="locate-outline" size={18} color="#DC2626" /><Text style={styles.outlineText}>Gunakan posisi GPS saat ini</Text></>}
      </Pressable>
      <Field label="Nama kantor" value={form.office_name} onChangeText={(v) => setForm({ ...form, office_name: v })} />
      <Field label="Lintang" value={form.latitude} onChangeText={(v) => setForm({ ...form, latitude: v })} keyboardType="numeric" />
      <Field label="Bujur" value={form.longitude} onChangeText={(v) => setForm({ ...form, longitude: v })} keyboardType="numeric" />
      <Field label="Radius (meter)" value={form.radius_meters} onChangeText={(v) => setForm({ ...form, radius_meters: v })} keyboardType="numeric" />
      <Pressable testID="add-office-button" onPress={submit} disabled={busyId === "new" || !form.office_name || !form.latitude || !form.longitude} style={[styles.primaryButton, (!form.office_name || !form.latitude || !form.longitude) && styles.disabled]}>
        {busyId === "new" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add" size={20} color="#fff" /><Text style={styles.primaryButtonText}>Tambah kantor</Text></>}
      </Pressable>
    </View>
  </View>;
}

// UI labels are Indonesian, but internal API field names stay English
// (`check_in`, `break_start`, `break_end`, `check_out`, `grace_minutes`).
// Do not translate these keys because the FastAPI schema depends on them.
function ScheduleTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [schedule, setSchedule] = useState({ check_in: "", break_start: "12:00", break_end: "13:00", check_out: "", grace_minutes: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (overview?.schedule) setSchedule({
      check_in: overview.schedule.check_in,
      break_start: overview.schedule.break_start || "12:00",
      break_end: overview.schedule.break_end || "13:00",
      check_out: overview.schedule.check_out,
      grace_minutes: String(overview.schedule.grace_minutes ?? 15),
    });
  }, [overview?.schedule]);
  const save = async () => {
    const grace = Number(schedule.grace_minutes);
    if (!schedule.check_in || !schedule.break_start || !schedule.break_end || !schedule.check_out) {
      onMessage("Semua waktu jadwal wajib diisi.");
      return;
    }
    if (!Number.isFinite(grace) || grace < 0 || grace > 120) {
      onMessage("Toleransi keterlambatan harus berupa angka 0–120 menit.");
      return;
    }

    setSaving(true);
    try {
      await apiRequest("/admin/schedule", token, {
        method: "PATCH",
        body: JSON.stringify({
          check_in: schedule.check_in,
          break_start: schedule.break_start,
          break_end: schedule.break_end,
          check_out: schedule.check_out,
          grace_minutes: grace,
        }),
      });
      onMessage("Jadwal kerja berhasil diperbarui.");
      await onChange();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Tidak dapat menyimpan jadwal kerja");
    } finally {
      setSaving(false);
    }
  };
  return <View style={styles.formCard}>
    <Text style={styles.formTitle}>Jadwal kerja mingguan</Text>
    <Text style={styles.formHint}>Berlaku untuk seluruh karyawan. Gunakan format HH:MM.</Text>
    <Field label="Clock In" value={schedule.check_in} onChangeText={(v) => setSchedule({ ...schedule, check_in: v })} />
    <Field label="Mulai istirahat" value={schedule.break_start} onChangeText={(v) => setSchedule({ ...schedule, break_start: v })} />
    <Field label="Selesai istirahat" value={schedule.break_end} onChangeText={(v) => setSchedule({ ...schedule, break_end: v })} />
    <Field label="Clock Out" value={schedule.check_out} onChangeText={(v) => setSchedule({ ...schedule, check_out: v })} />
    <Field label="Toleransi keterlambatan (menit)" value={schedule.grace_minutes} onChangeText={(v) => setSchedule({ ...schedule, grace_minutes: v })} keyboardType="numeric" />
    <Pressable testID="save-schedule-button" onPress={save} disabled={saving} style={styles.primaryButton}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Simpan jadwal kerja</Text>}</Pressable>
  </View>;
}

function HolidaysTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [form, setForm] = useState({ date: "", label: "" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const add = async () => {
    setBusyId("new");
    try { await apiRequest("/admin/holidays", token, { method: "POST", body: JSON.stringify(form) }); onMessage(`Hari libur "${form.label}" ditambahkan.`); setForm({ date: "", label: "" }); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Tidak dapat menambah hari libur"); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string, label: string) => {
    setBusyId(id);
    try { await apiRequest(`/admin/holidays/${id}`, token, { method: "DELETE" }); onMessage(`Hari libur "${label}" dihapus.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Tidak dapat menghapus hari libur"); }
    finally { setBusyId(null); }
  };
  const holidays = overview?.holidays || [];
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Tambah hari libur</Text>
      <Text style={styles.formHint}>Pada tanggal ini, absensi tidak diwajibkan dan dilewati oleh aturan sistem.</Text>
      <Field label="Tanggal (YYYY-MM-DD)" value={form.date} onChangeText={(v) => setForm({ ...form, date: v })} />
      <Field label="Nama hari libur (mis. Tahun Baru)" value={form.label} onChangeText={(v) => setForm({ ...form, label: v })} />
      <Pressable testID="add-holiday-button" onPress={add} disabled={busyId === "new" || !form.date || !form.label} style={[styles.primaryButton, (!form.date || !form.label) && styles.disabled]}>
        {busyId === "new" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="calendar" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Tambah hari libur</Text></>}
      </Pressable>
    </View>
    {holidays.length === 0 ? (
      <View style={styles.emptySmall}><Ionicons name="calendar-clear-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>Belum ada hari libur</Text><Text style={styles.emptyBody}>Tambahkan tanggal ketika karyawan tidak diwajibkan melakukan absensi.</Text></View>
    ) : holidays.map((holiday) => (
      <View testID={`holiday-card-${holiday.holiday_id}`} style={styles.requestCard} key={holiday.holiday_id}>
        <View style={styles.holidayIcon}><Ionicons name="sparkles" size={18} color="#B45309" /></View>
        <View style={styles.requestCopy}>
          <Text style={styles.verifyTitle}>{holiday.label}</Text>
          <Text style={styles.verifySub}>{holiday.date}</Text>
        </View>
        <Pressable testID={`holiday-delete-${holiday.holiday_id}`} onPress={() => remove(holiday.holiday_id, holiday.label)} disabled={busyId === holiday.holiday_id} style={[styles.approve, styles.dangerButton]}>
          {busyId === holiday.holiday_id ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Hapus</Text>}
        </Pressable>
      </View>
    ))}
  </View>;
}

function UsersTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  type UserDraft = {
    full_name: string;
    department: string;
    employee_id: string;
    phone: string;
    address: string;
    emergency_contact_name: string;
    emergency_contact_phone: string;
    annual_leave_quota: string;
  };
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Record<string, UserDraft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await apiRequest<User[]>("/admin/users", token)); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memuat data karyawan"); }
    finally { setLoading(false); }
  }, [token, onMessage]);
  useEffect(() => { load(); }, [load]);

  const startEdit = (u: User) => setEditing((prev) => ({
    ...prev,
    [u.user_id]: {
      full_name: u.full_name || u.name || "",
      department: u.department || "",
      employee_id: u.employee_id || "",
      phone: u.phone || "",
      address: u.address || "",
      emergency_contact_name: u.emergency_contact_name || "",
      emergency_contact_phone: u.emergency_contact_phone || "",
      annual_leave_quota: String(u.annual_leave_quota ?? 12),
    },
  }));
  const cancelEdit = (id: string) => setEditing((prev) => { const next = { ...prev }; delete next[id]; return next; });

  const save = async (u: User) => {
    const draft = editing[u.user_id];
    if (!draft || !draft.full_name.trim() || !draft.department.trim()) { onMessage("Nama lengkap dan departemen wajib diisi"); return; }
    const quota = Number(draft.annual_leave_quota);
    if (!Number.isFinite(quota) || quota < 0 || quota > 365) { onMessage("Kuota cuti harus antara 0 dan 365"); return; }
    setBusyId(u.user_id);
    try {
      await apiRequest(`/admin/users/${u.user_id}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          full_name: draft.full_name.trim(),
          department: draft.department.trim(),
          employee_id: draft.employee_id.trim() || null,
          phone: draft.phone.trim(),
          address: draft.address.trim(),
          emergency_contact_name: draft.emergency_contact_name.trim(),
          emergency_contact_phone: draft.emergency_contact_phone.trim(),
          annual_leave_quota: Math.floor(quota),
        }),
      });
      onMessage(`Data ${draft.full_name.trim()} berhasil diperbarui.`);
      cancelEdit(u.user_id);
      await load();
    } catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat menyimpan data karyawan"); }
    finally { setBusyId(null); }
  };

  const normalized = query.trim().toLowerCase();
  const visibleUsers = users.filter((u) => !normalized || [
    u.full_name, u.name, u.email, u.employee_id, u.department, u.phone
  ].some((value) => String(value || "").toLowerCase().includes(normalized)));

  if (loading && !users.length) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Direktori karyawan</Text>
      <Text style={styles.formHint}>Kelola identitas karyawan, kontak, kontak darurat, dan kuota cuti.</Text>
      <Field label="Cari karyawan" value={query} onChangeText={setQuery} placeholder="Nama, ID, email, departemen..." />
    </View>

    {!visibleUsers.length ? (
      <View style={styles.emptySmall}>
        <Ionicons name="people-outline" size={25} color="#DC2626" />
        <Text style={styles.emptyTitle}>Karyawan tidak ditemukan.</Text>
      </View>
    ) : visibleUsers.map((u) => {
      const draft = editing[u.user_id];
      const expanded = expandedUserId === u.user_id;

      return (
        <View testID={`user-card-${u.user_id}`} style={styles.employeeListCard} key={u.user_id}>
          <Pressable
            testID={`user-expand-${u.user_id}`}
            onPress={() => {
              if (expanded) {
                setExpandedUserId(null);
                cancelEdit(u.user_id);
              } else {
                setExpandedUserId(u.user_id);
              }
            }}
            style={({ pressed }) => [styles.employeeListHeader, pressed && styles.pressed]}
          >
            <AvatarView user={u} size={48} />
            <Text numberOfLines={2} style={styles.employeeListName}>{u.full_name || u.name || u.email}</Text>
            <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={22} color="#6B7280" />
          </Pressable>

          {expanded && !draft && (
            <View style={styles.employeeDropdown}>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Nama lengkap</Text><Text style={styles.employeeDetailValue}>{u.full_name || u.name || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Jabatan</Text><Text style={styles.employeeDetailValue}>{u.department || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>ID Karyawan</Text><Text style={styles.employeeDetailValue}>{u.employee_id || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Email</Text><Text style={styles.employeeDetailValue}>{u.email || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Nomor telepon</Text><Text style={styles.employeeDetailValue}>{u.phone || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Alamat</Text><Text style={styles.employeeDetailValue}>{u.address || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Kontak darurat</Text><Text style={styles.employeeDetailValue}>{u.emergency_contact_name || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Nomor kontak darurat</Text><Text style={styles.employeeDetailValue}>{u.emergency_contact_phone || "—"}</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Kuota cuti tahunan</Text><Text style={styles.employeeDetailValue}>{u.annual_leave_quota ?? 12} hari</Text></View>
              <View style={styles.employeeDetailRow}><Text style={styles.employeeDetailLabel}>Peran akun</Text><Text style={styles.employeeDetailValue}>{u.role === "admin" ? "Administrator" : "Karyawan"}</Text></View>

              <Pressable
                testID={`user-edit-btn-${u.user_id}`}
                onPress={() => startEdit(u)}
                style={[styles.primaryButton, { marginTop: 14 }]}
              >
                <Ionicons name="create-outline" size={17} color="#fff" />
                <Text style={styles.primaryButtonText}>Ubah data karyawan</Text>
              </Pressable>
            </View>
          )}

          {expanded && draft && (
            <View testID={`user-edit-${u.user_id}`} style={styles.employeeDropdown}>
              <Text style={styles.formTitle}>Ubah data karyawan</Text>
              <Text style={styles.formHint}>{u.email}</Text>
              <Field label="Nama lengkap" value={draft.full_name} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, full_name: v } }))} />
              <Field label="Departemen / Posisi" value={draft.department} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, department: v } }))} />
              <Field label="ID Karyawan" value={draft.employee_id} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, employee_id: v } }))} />
              <Field label="Nomor telepon" value={draft.phone} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, phone: v } }))} />
              <Field label="Alamat" value={draft.address} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, address: v } }))} multiline />
              <Field label="Nama kontak darurat" value={draft.emergency_contact_name} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, emergency_contact_name: v } }))} />
              <Field label="Nomor kontak darurat" value={draft.emergency_contact_phone} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, emergency_contact_phone: v } }))} />
              <Field label="Kuota cuti tahunan (hari)" value={draft.annual_leave_quota} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, annual_leave_quota: v } }))} keyboardType="numeric" />
              <View style={styles.officeActions}>
                <Pressable testID={`user-cancel-${u.user_id}`} onPress={() => cancelEdit(u.user_id)} style={[styles.outlineButton, { flex: 1 }]}>
                  <Text style={styles.outlineText}>Batal</Text>
                </Pressable>
                <Pressable testID={`user-save-${u.user_id}`} onPress={() => save(u)} disabled={busyId === u.user_id} style={[styles.primaryButton, { flex: 1 }]}>
                  {busyId === u.user_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Simpan</Text></>}
                </Pressable>
              </View>
            </View>
          )}
        </View>
      );
    })}
  </View>;
}

function LeavesAdminTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "cancelled">("pending");
  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await apiRequest<Leave[]>(`/admin/leaves?status=${filter}`, token); setLeaves(data); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memuat data cuti"); }
    finally { setLoading(false); }
  }, [token, filter, onMessage]);
  useEffect(() => { load(); }, [load]);
  const resolve = async (leaveId: string, action: "approve" | "reject") => {
    setBusyId(leaveId);
    try { await apiRequest(`/admin/leaves/${leaveId}/${action}`, token, { method: "POST" }); onMessage(`Pengajuan cuti ${action === "approve" ? "disetujui" : "ditolak"}.`); await load(); }
    catch (err) { onMessage(err instanceof Error ? err.message : `Tidak dapat ${action === "approve" ? "menyetujui" : "menolak"} pengajuan cuti`); }
    finally { setBusyId(null); }
  };
  const filters: ("pending" | "approved" | "rejected" | "cancelled")[] = ["pending", "approved", "rejected", "cancelled"];
  return <View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
      {filters.map((f) => (
        <Pressable testID={`leave-filter-${f}`} key={f} onPress={() => setFilter(f)} style={[styles.segmentChip, filter === f && styles.segmentChipActive]}>
          <Text style={[styles.segmentText, filter === f && styles.segmentTextActive]}>{{ pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak", cancelled: "Dibatalkan" }[f]}</Text>
        </Pressable>
      ))}
    </ScrollView>
    {loading && <ActivityIndicator color="#DC2626" style={{ marginTop: 16 }} />}
    {!loading && leaves.length === 0 && (
      <View style={styles.emptySmall}><Ionicons name="airplane-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>{filter === "pending" ? "Tidak ada pengajuan cuti yang menunggu" : filter === "approved" ? "Tidak ada cuti yang disetujui" : filter === "rejected" ? "Tidak ada cuti yang ditolak" : "Tidak ada cuti yang dibatalkan"}</Text><Text style={styles.emptyBody}>Pengajuan karyawan akan muncul di sini.</Text></View>
    )}
    {leaves.map((leave) => (
      <View testID={`admin-leave-${leave.leave_id}`} style={styles.formCard} key={leave.leave_id}>
        <Text style={styles.formTitle}>{leave.user_name || leave.user_email}</Text>
        <Text style={styles.formHint}>{leave.department || "—"} · {(leave.leave_type || "annual").replace("_", " ").toUpperCase()} · {leave.start_date} → {leave.end_date} · {leave.days} hari</Text>
        <Text style={[styles.verifySub, { marginBottom: 8 }]}>{leave.reason}</Text>
        {!!leave.attachment && <Text style={styles.verifySub}>Lampiran: {leave.attachment.file_name}</Text>}
        {!!leave.attachment_url && <Pressable onPress={() => Linking.openURL(leave.attachment_url!)}><Text style={[styles.verifySub, { color: "#DC2626" }]}>Buka dokumen pendukung</Text></Pressable>}
        {leave.status === "pending" ? (
          <View style={styles.officeActions}>
            <Pressable testID={`leave-approve-${leave.leave_id}`} onPress={() => resolve(leave.leave_id, "approve")} disabled={busyId === leave.leave_id} style={[styles.primaryButton, { flex: 1 }]}>
              {busyId === leave.leave_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Setujui</Text></>}
            </Pressable>
            <Pressable testID={`leave-reject-${leave.leave_id}`} onPress={() => resolve(leave.leave_id, "reject")} disabled={busyId === leave.leave_id} style={[styles.outlineButton, styles.dangerOutline, { flex: 1 }]}>
              <Ionicons name="close" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Tolak</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.leaveStatus, leave.status === "approved" ? styles.statusSetujuid : leave.status === "cancelled" ? styles.statusMenunggu : styles.statusTolaked]}>
            <Text style={[styles.leaveStatusText, leave.status === "approved" ? { color: "#15803D" } : leave.status === "cancelled" ? { color: "#A16207" } : { color: "#991B1B" }]}>{{ pending: "MENUNGGU", approved: "DISETUJUI", rejected: "DITOLAK", cancelled: "DIBATALKAN" }[leave.status]}</Text>
          </View>
        )}
      </View>
    ))}
  </View>;
}


function CorrectionsAdminTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [items, setItems] = useState<AttendanceCorrection[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "cancelled">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await apiRequest<AttendanceCorrection[]>(`/admin/attendance-corrections?status=${filter}`, token)); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memuat koreksi absensi"); }
    finally { setLoading(false); }
  }, [token, filter, onMessage]);
  useEffect(() => { load(); }, [load]);

  const resolve = async (id: string, action: "approve" | "reject") => {
    setBusyId(id);
    try {
      await apiRequest(`/admin/attendance-corrections/${id}/${action}`, token, { method: "POST" });
      onMessage(`Koreksi absensi ${action === "approve" ? "disetujui" : "ditolak"}.`);
      await load();
    } catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memproses koreksi absensi"); }
    finally { setBusyId(null); }
  };

  const filters: ("pending" | "approved" | "rejected" | "cancelled")[] = ["pending", "approved", "rejected", "cancelled"];
  return <View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
      {filters.map((f) => <Pressable key={f} onPress={() => setFilter(f)} style={[styles.segmentChip, filter === f && styles.segmentChipActive]}><Text style={[styles.segmentText, filter === f && styles.segmentTextActive]}>{{ pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak", cancelled: "Dibatalkan" }[f]}</Text></Pressable>)}
    </ScrollView>
    {loading && <ActivityIndicator color="#DC2626" style={{ marginTop: 20 }} />}
    {!loading && !items.length && <View style={styles.emptySmall}><Ionicons name="checkmark-done" size={26} color="#16A34A" /><Text style={styles.emptyTitle}>{filter === "pending" ? "Tidak ada koreksi absensi yang menunggu" : filter === "approved" ? "Tidak ada koreksi absensi yang disetujui" : filter === "rejected" ? "Tidak ada koreksi absensi yang ditolak" : "Tidak ada koreksi absensi yang dibatalkan"}</Text></View>}
    {items.map((item) => <View style={styles.formCard} key={item.correction_id}>
      <Text style={styles.formTitle}>{item.user_name || item.user_email || "Karyawan"}</Text>
      <Text style={styles.formHint}>{item.date} · {item.action.replace("_", " ")} · diajukan pukul {item.requested_time} WIB</Text>
      <Text style={styles.verifySub}>{item.reason}</Text>
      {!!item.attachment && <Text style={styles.verifySub}>Lampiran: {item.attachment.file_name}</Text>}
      {!!item.attachment_url && <Pressable onPress={() => Linking.openURL(item.attachment_url!)}><Text style={[styles.verifySub, { color: "#DC2626" }]}>Buka dokumen pendukung</Text></Pressable>}
      {item.status === "pending" ? <View style={styles.officeActions}>
        <Pressable onPress={() => resolve(item.correction_id, "approve")} disabled={busyId === item.correction_id} style={[styles.primaryButton, { flex: 1 }]}><Text style={styles.primaryButtonText}>Setujui</Text></Pressable>
        <Pressable onPress={() => resolve(item.correction_id, "reject")} disabled={busyId === item.correction_id} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Tolak</Text></Pressable>
      </View> : <View style={[styles.leaveStatus, item.status === "approved" ? styles.statusSetujuid : item.status === "cancelled" ? styles.statusMenunggu : styles.statusTolaked]}><Text style={[styles.leaveStatusText, { color: item.status === "approved" ? "#15803D" : item.status === "cancelled" ? "#A16207" : "#991B1B" }]}>{{ pending: "MENUNGGU", approved: "DISETUJUI", rejected: "DITOLAK", cancelled: "DIBATALKAN" }[item.status]}</Text></View>}
    </View>)}
  </View>;
}

function CompanyAdminTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [info, setInfo] = useState<{ announcements: CompanyAnnouncement[]; policies: CompanyPolicy[] }>({ announcements: [], policies: [] });
  const [kind, setKind] = useState<"announcement" | "policy">("announcement");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(async () => {
    try { setInfo(await apiRequest("/admin/company-info", token)); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memuat informasi perusahaan"); }
  }, [token, onMessage]);
  useEffect(() => { load(); }, [load]);
  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    try {
      const endpoint = kind === "announcement" ? "/admin/company-info/announcements" : "/admin/company-info/policies";
      await apiRequest(endpoint, token, { method: "POST", body: JSON.stringify({ title: title.trim(), body: body.trim(), active: true }) });
      setTitle(""); setBody(""); await load(); onMessage(`${kind === "announcement" ? "Announcement" : "Policy"} published.`);
    } catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat memublikasikan"); }
  };
  const remove = async (kindName: "announcements" | "policies", id: string) => {
    try { await apiRequest(`/admin/company-info/${kindName}/${id}`, token, { method: "DELETE" }); await load(); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Tidak dapat menghapus"); }
  };
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Informasi perusahaan</Text>
      <View style={styles.officeActions}>
        <Pressable onPress={() => setKind("announcement")} style={[styles.outlineButton, kind === "announcement" && styles.segmentChipActive, { flex: 1 }]}><Text style={styles.outlineText}>Announcement</Text></Pressable>
        <Pressable onPress={() => setKind("policy")} style={[styles.outlineButton, kind === "policy" && styles.segmentChipActive, { flex: 1 }]}><Text style={styles.outlineText}>Policy / Regulation</Text></Pressable>
      </View>
      <Field label="Judul" value={title} onChangeText={setTitle} />
      <Field label="Isi" value={body} onChangeText={setBody} multiline />
      <Pressable onPress={submit} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Publikasikan</Text></Pressable>
    </View>
    {info.announcements.map((item) => <View style={styles.formCard} key={item.announcement_id}><Text style={styles.formTitle}>{item.title}</Text><Text style={styles.verifySub}>{item.body}</Text><Pressable onPress={() => remove("announcements", item.announcement_id)}><Text style={[styles.verifySub, { color: "#B91C1C" }]}>Hapus</Text></Pressable></View>)}
    {info.policies.map((item) => <View style={styles.formCard} key={item.policy_id}><Text style={styles.formTitle}>{item.title}</Text><Text style={styles.verifySub}>{item.body}</Text><Pressable onPress={() => remove("policies", item.policy_id)}><Text style={[styles.verifySub, { color: "#B91C1C" }]}>Hapus</Text></Pressable></View>)}
  </View>;
}

function StatsTab({ token }: { token: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await apiRequest<StatsPayload>(`/admin/stats?year=${year}&month=${month}`, token); setStats(data); }
    catch {}
    finally { setLoading(false); }
  }, [token, year, month]);
  useEffect(() => { load(); }, [load]);
  const step = (delta: number) => {
    let y = year, m = month + delta;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setYear(y); setMonth(m);
  };
  const maxVal = stats ? Math.max(1, ...stats.days.map((d) => Math.max(d.on_time + d.late, d.on_leave))) : 1;
  return <View>
    <View style={styles.formCard}>
      <View style={styles.officeRow}>
        <Pressable testID="stats-prev-button" onPress={() => step(-1)} style={styles.outlineButton}><Ionicons name="chevron-back" size={16} color="#DC2626" /></Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.formTitle}>{new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</Text>
          <Text style={styles.formHint}>Tepat waktu vs terlambat per hari</Text>
        </View>
        <Pressable testID="stats-next-button" onPress={() => step(1)} style={styles.outlineButton}><Ionicons name="chevron-forward" size={16} color="#DC2626" /></Pressable>
      </View>
      {loading ? <ActivityIndicator color="#DC2626" style={{ marginTop: 16 }} /> : stats && <>
        <View style={styles.statsTotalsRow}>
          <View style={styles.statsTotal}><Text style={styles.statsTotalValue}>{stats.totals.on_time}</Text><Text style={styles.statsTotalLabel}>Tepat waktu</Text></View>
          <View style={styles.statsTotal}><Text style={[styles.statsTotalValue, { color: "#B91C1C" }]}>{stats.totals.late}</Text><Text style={styles.statsTotalLabel}>Terlambat</Text></View>
          <View style={styles.statsTotal}><Text style={[styles.statsTotalValue, { color: "#1D4ED8" }]}>{stats.totals.on_leave}</Text><Text style={styles.statsTotalLabel}>Cuti</Text></View>
        </View>
        <View testID="stats-chart" style={styles.chart}>
          {stats.days.map((day) => {
            const dayNumber = parseInt(day.date.slice(8), 10);
            const totalHeight = 100;
            const onTimeH = Math.round((day.on_time / maxVal) * totalHeight);
            const lateH = Math.round((day.late / maxVal) * totalHeight);
            const leaveH = Math.round((day.on_leave / maxVal) * totalHeight);
            return <View key={day.date} style={styles.chartCol}>
              <View style={styles.chartBars}>
                {leaveH > 0 && <View style={[styles.chartBar, { height: leaveH, backgroundColor: "#3B82F6" }]} />}
                {lateH > 0 && <View style={[styles.chartBar, { height: lateH, backgroundColor: "#DC2626" }]} />}
                {onTimeH > 0 && <View style={[styles.chartBar, { height: onTimeH, backgroundColor: "#16A34A" }]} />}
              </View>
              <Text style={[styles.chartLabel, day.holiday && { color: "#B45309" }]}>{dayNumber}</Text>
            </View>;
          })}
        </View>
        <View style={styles.chartLegend}>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#16A34A" }]} /><Text style={styles.legendText}>Tepat waktu</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#DC2626" }]} /><Text style={styles.legendText}>Terlambat</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#3B82F6" }]} /><Text style={styles.legendText}>Cuti</Text></View>
        </View>
        <Text style={styles.formHint}>Grace period: check-in until {stats.schedule.check_in} (+{stats.schedule.grace_minutes}m) is on time.</Text>
      </>}
    </View>
  </View>;
}

function WorkTimeTab({ token }: { token: string }) {
  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const [year, setYear] = useState(nowWib.getUTCFullYear());
  const [month, setMonth] = useState(nowWib.getUTCMonth() + 1);
  const [data, setData] = useState<AdminWorkTimePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());
  const receivedAtRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await apiRequest<AdminWorkTimePayload>(
        `/admin/work-time?year=${year}&month=${month}`,
        token
      );
      receivedAtRef.current = Date.now();
      setData(result);
      setError("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Tidak dapat memuat waktu kerja";
      setError(message);
      if (!silent) setData(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [token, year, month]);

  useEffect(() => { load(false); }, [load]);

  // Backend stays authoritative. Refresh every 5s; the UI ticks the already-authorized
  // active interval locally every second, so we do not hammer MongoDB once per second.
  useEffect(() => {
    const currentWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const isCurrentMonth = year === currentWib.getUTCFullYear() && month === currentWib.getUTCMonth() + 1;
    if (!isCurrentMonth) return;
    const interval = setInterval(() => { load(true); }, 5000);
    return () => clearInterval(interval);
  }, [year, month, load]);

  const step = (delta: number) => {
    let nextYear = year;
    let nextMonth = month + delta;
    if (nextMonth < 1) { nextMonth = 12; nextYear -= 1; }
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    setYear(nextYear);
    setMonth(nextMonth);
  };

  const displaySeconds = useCallback((employee: AdminWorkTimeItem, field: "total" | "overtime" = "total") => {
    const base = field === "total"
      ? (employee.total_seconds ?? Math.floor((employee.total_minutes || 0) * 60))
      : (employee.overtime_seconds ?? Math.floor((employee.overtime_minutes || 0) * 60));

    if (!employee.active || !employee.counting_now || !data?.server_time) return base;

    const serverMs = new Date(data.server_time).getTime();
    if (!Number.isFinite(serverMs)) return base;
    let effectiveNow = clockNow;
    if (employee.counting_until) {
      const untilMs = new Date(employee.counting_until).getTime();
      if (Number.isFinite(untilMs)) effectiveNow = Math.min(effectiveNow, untilMs);
    }
    const extra = Math.max(0, Math.floor((effectiveNow - serverMs) / 1000));

    // Only overtime grows in the overtime field.
    if (field === "overtime" && (employee.active_overtime_seconds || 0) <= 0) return base;
    return base + extra;
  }, [clockNow, data?.server_time]);

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <View>
      <View style={styles.formCard}>
        <View style={styles.officeRow}>
          <Pressable testID="worktime-prev-button" onPress={() => step(-1)} style={styles.outlineButton}>
            <Ionicons name="chevron-back" size={16} color="#DC2626" />
          </Pressable>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={styles.formTitle}>{monthLabel}</Text>
            <Text style={styles.formHint}>Waktu kerja karyawan · realtime hingga detik</Text>
          </View>
          <Pressable testID="worktime-next-button" onPress={() => step(1)} style={styles.outlineButton}>
            <Ionicons name="chevron-forward" size={16} color="#DC2626" />
          </Pressable>
        </View>

        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#B91C1C" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color="#DC2626" style={{ marginTop: 20 }} />
        ) : !data || data.items.length === 0 ? (
          <View style={styles.emptySmall}>
            <Ionicons name="time-outline" size={28} color="#DC2626" />
            <Text style={styles.emptyTitle}>Belum ada data karyawan</Text>
            <Text style={styles.emptyBody}>Akun karyawan akan muncul di sini meskipun belum menyelesaikan Clock Out.</Text>
          </View>
        ) : (
          data.items.map((employee) => {
            const totalSeconds = displaySeconds(employee, "total");
            const overtimeSeconds = displaySeconds(employee, "overtime");
            return (
              <View key={employee.user_id} style={styles.workTimeEmployee}>
                <View style={styles.workTimeEmployeeIcon}><Text style={styles.avatarText}>{initials(employee.name)}</Text></View>
                <View style={styles.workTimeEmployeeCopy}>
                  <View style={styles.workTimeNameRow}>
                    <Text style={styles.verifyTitle}>{employee.name}</Text>
                    {employee.active && (
                      <View style={styles.workTimeActiveBadge}>
                        <View style={styles.timerLiveDotSmall} />
                        <Text style={styles.workTimeActiveText}>
                          {employee.missing_checkout ? "BELUM CLOCK OUT" : (employee.active_overtime_seconds || 0) > 0 ? "LEMBUR" : "BEKERJA"}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.verifySub}>{employee.department || employee.email || "—"}</Text>
                  <Text style={styles.workTimeTotal}>{formatWorkSeconds(totalSeconds)}</Text>
                  {overtimeSeconds > 0 && <Text style={styles.verifySub}>Lembur {formatWorkSeconds(overtimeSeconds)}</Text>}
                  <Text style={styles.verifySub}>{employee.days_worked} hari kerja{employee.active ? " · aktif" : ""}</Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

function ReportsTab({ token }: { token: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date().toISOString().slice(0, 8) + "01";
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(today);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [photoRow, setPhotoRow] = useState<ReportRow | null>(null);
  const [photoUri, setPhotoUri] = useState<string>("");
  const [photoLoading, setPhotoLoading] = useState(false);

  const employeeRecordTables = useMemo(() => {
    if (!report) return [] as Array<{ key: string; name: string; email: string; days: Array<{ date: string; checkIn?: ReportRow; checkOut?: ReportRow; office: string }> }>;
    const employees = new Map<string, { key: string; name: string; email: string; days: Map<string, { date: string; checkIn?: ReportRow; checkOut?: ReportRow; office: string }> }>();
    for (const row of report.rows) {
      const key = row.user_email || row.user_name || "unknown";
      let employee = employees.get(key);
      if (!employee) {
        employee = { key, name: row.user_name || row.user_email || "—", email: row.user_email || "", days: new Map() };
        employees.set(key, employee);
      }
      let day = employee.days.get(row.date);
      if (!day) {
        day = { date: row.date, office: row.office_name || "—" };
        employee.days.set(row.date, day);
      }
      if (row.action === "check_in" && !day.checkIn) day.checkIn = row;
      if (row.action === "check_out") day.checkOut = row;
      if (row.office_name) day.office = row.office_name;
    }
    return Array.from(employees.values()).map((employee) => ({
      key: employee.key,
      name: employee.name,
      email: employee.email,
      days: Array.from(employee.days.values()).sort((a, b) => b.date.localeCompare(a.date)),
    }));
  }, [report]);

  const openProofPhoto = useCallback(async (row?: ReportRow) => {
    if (!row?.has_photo) return;
    setPhotoRow(row);
    setPhotoUri("");
    setPhotoLoading(true);
    try {
      const url = apiUrl(`/admin/attendance/${row.attendance_id}/photo`);
      if (Platform.OS === "web") {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) throw new Error("Photo unavailable");
        const blob = await resp.blob();
        setPhotoUri(window.URL.createObjectURL(blob));
      } else {
        const target = `${FileSystem.cacheDirectory}proof-${row.attendance_id}.jpg`;
        const dl = await FileSystem.downloadAsync(url, target, { headers: { Authorization: `Bearer ${token}` } });
        if (dl.status !== 200) throw new Error("Photo unavailable");
        setPhotoUri(dl.uri);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo unavailable");
      setPhotoRow(null);
    } finally {
      setPhotoLoading(false);
    }
  }, [token]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await apiRequest<ReportPayload>(`/admin/reports?date_from=${dateFrom}&date_to=${dateTo}`, token);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak dapat memuat laporan");
    } finally { setLoading(false); }
  }, [token, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);
  const shareCsv = async () => {
    try {
      const csv = await apiRequestText(`/admin/reports/export?date_from=${dateFrom}&date_to=${dateTo}`, token);
      await Share.share({ title: `PKUCITY attendance ${dateFrom} to ${dateTo}`, message: csv });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak dapat membagikan CSV");
    }
  };
  const sharePdf = async () => {
    try {
      setError("");
      if (Platform.OS === "web") {
        // Web: download via fetch + blob URL.
        const response = await fetch(apiUrl(`/admin/reports/summary.pdf?date_from=${dateFrom}&date_to=${dateTo}`), { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error("Could not build PDF");
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = window.document.createElement("a");
        link.href = url;
        link.download = `pkucity-attendance-${dateFrom}-to-${dateTo}.pdf`;
        link.click();
        window.URL.revokeObjectURL(url);
        return;
      }
      const target = `${FileSystem.cacheDirectory}pkucity-attendance-${dateFrom}-to-${dateTo}.pdf`;
      const download = await FileSystem.downloadAsync(apiUrl(`/admin/reports/summary.pdf?date_from=${dateFrom}&date_to=${dateTo}`), target, { headers: { Authorization: `Bearer ${token}` } });
      if (download.status !== 200) throw new Error("Could not build PDF");
      const available = await Sharing.isAvailableAsync();
      if (!available) { setError("Fitur berbagi tidak tersedia di perangkat ini."); return; }
      await Sharing.shareAsync(download.uri, { mimeType: "application/pdf", dialogTitle: `Laporan absensi PKUCITY ${dateFrom} → ${dateTo}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak dapat membagikan PDF");
    }
  };
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Laporan absensi</Text>
      <Text style={styles.formHint}>Rentang merangkum Clock In dan Clock Out yang telah terverifikasi.</Text>
      <Field label="Dari (YYYY-MM-DD)" value={dateFrom} onChangeText={setDateFrom} />
      <Field label="Sampai (YYYY-MM-DD)" value={dateTo} onChangeText={setDateTo} />
      <View style={styles.officeActions}>
        <Pressable testID="report-refresh-button" onPress={load} disabled={loading} style={[styles.outlineButton, { flex: 1 }]}>
          {loading ? <ActivityIndicator color="#DC2626" /> : <><Ionicons name="refresh" size={16} color="#DC2626" /><Text style={styles.outlineText}>Muat ulang</Text></>}
        </Pressable>
        <Pressable testID="report-share-csv-button" onPress={shareCsv} disabled={loading} style={[styles.primaryButton, { flex: 1 }]}>
          <Ionicons name="share-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Bagikan CSV</Text>
        </Pressable>
      </View>
      <Pressable testID="report-share-pdf-button" onPress={sharePdf} disabled={loading} style={[styles.primaryButton, { marginTop: 10 }]}>
        <Ionicons name="document-text-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Bagikan PDF bulanan</Text>
      </Pressable>
      {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
      {report && <Text style={styles.formHint}>{report.total_rows} records · {report.summary.length} employees · work time stops at {report.schedule?.check_out || "17:00"} unless overtime is approved</Text>}
    </View>
    {(report?.summary || []).map((summary) => (
  <View testID={`report-row-${summary.user_id}`} style={styles.requestCard} key={summary.user_id}>
    <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(summary.name)}</Text></View>
    <View style={styles.requestCopy}>
      <Text style={styles.verifyTitle}>{summary.name}</Text>
      <Text style={styles.verifySub}>{summary.email || summary.user_id}</Text>
      {(summary.overtime_minutes ?? 0) > 0 && <Text testID={`overtime-${summary.user_id}`} style={styles.overtimeText}>+{Math.floor((summary.overtime_minutes || 0) / 60)}h {(summary.overtime_minutes || 0) % 60}m overtime</Text>}
    </View>
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      <Text style={styles.reportMetric}>{summary.check_ins} masuk</Text>
      <Text style={styles.reportMetricMuted}>{summary.check_outs} pulang</Text>
      <Pressable
        testID={`user-pdf-${summary.user_id}`}
        onPress={async () => {
          try {
            const url = apiUrl(`/admin/reports/user/${summary.user_id}/daily.pdf?date_from=${dateFrom}&date_to=${dateTo}`);
            if (Platform.OS === "web") {
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              const blob = await resp.blob();
              const objUrl = window.URL.createObjectURL(blob);
              const link = window.document.createElement("a");
              link.href = objUrl; link.download = `pkucity-${summary.name}.pdf`; link.click();
              window.URL.revokeObjectURL(objUrl);
              return;
            }
            const target = `${FileSystem.cacheDirectory}pkucity-${summary.user_id}.pdf`;
            const dl = await FileSystem.downloadAsync(url, target, { headers: { Authorization: `Bearer ${token}` } });
            await Sharing.shareAsync(dl.uri, { mimeType: "application/pdf", dialogTitle: `Absensi ${summary.name}` });
          } catch (err) {
            setError(err instanceof Error ? err.message : "Tidak dapat mengekspor PDF");
          }
        }}
        style={{ paddingHorizontal: 8, paddingVertical: 4 }}
      >
        <Ionicons name="document-text-outline" size={18} color="#DC2626" />
      </Pressable>
    </View>
  </View>
))}
    {report && report.rows.length > 0 && (
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>Riwayat per karyawan</Text>
        <Text style={styles.formHint}>Riwayat dikelompokkan per karyawan. Ketuk baris dengan ikon foto untuk melihat bukti absensi.</Text>
        {employeeRecordTables.map((employee) => (
          <View key={employee.key} style={styles.employeeRecordTable}>
            <View style={styles.employeeRecordHeader}>
              <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(employee.name)}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.verifyTitle}>{employee.name}</Text>
                {!!employee.email && <Text style={styles.verifySub}>{employee.email}</Text>}
              </View>
            </View>
            <View style={styles.recordTableHead}>
              <Text style={[styles.recordTableHeadText, { flex: 0.85 }]}>DATE</Text>
              <Text style={[styles.recordTableHeadText, { flex: 1.05 }]}>IN</Text>
              <Text style={[styles.recordTableHeadText, { flex: 1.05 }]}>OUT</Text>
              <Text style={[styles.recordTableHeadText, { flex: 1.55 }]}>OFFICE</Text>
            </View>
            {employee.days.map((day) => (
              <View
                key={`${employee.key}-${day.date}`}
                testID={`employee-record-${employee.key}-${day.date}`}
                style={styles.recordTableRow}
              >
                <Text style={[styles.recordTableCell, { flex: 0.85 }]}>{day.date.slice(5)}</Text>

                <View style={[styles.recordProofCell, { flex: 1.05 }]}>
                  {!!day.checkIn?.has_photo && (
                    <Pressable
                      testID={`checkin-photo-${day.checkIn.attendance_id}`}
                      onPress={() => openProofPhoto(day.checkIn)}
                      hitSlop={8}
                      style={styles.recordPhotoButton}
                    >
                      <Ionicons name="image-outline" size={15} color="#DC2626" />
                    </Pressable>
                  )}
                  <Text numberOfLines={1} style={styles.recordProofTime}>{day.checkIn?.time_wib || "—"}</Text>
                </View>

                <View style={[styles.recordProofCell, { flex: 1.05 }]}>
                  {!!day.checkOut?.has_photo && (
                    <Pressable
                      testID={`checkout-photo-${day.checkOut.attendance_id}`}
                      onPress={() => openProofPhoto(day.checkOut)}
                      hitSlop={8}
                      style={styles.recordPhotoButton}
                    >
                      <Ionicons name="image-outline" size={15} color="#DC2626" />
                    </Pressable>
                  )}
                  <Text numberOfLines={1} style={styles.recordProofTime}>{day.checkOut?.time_wib || "—"}</Text>
                </View>

                <View style={[styles.recordOfficeCell, { flex: 1.55 }]}>
                  <Text numberOfLines={1} ellipsizeMode="tail" style={styles.recordOfficeText}>{day.office}</Text>
                </View>
              </View>
            ))}
          </View>
        ))}
      </View>
    )}
    <Modal visible={!!photoRow} transparent animationType="fade" onRequestClose={() => setPhotoRow(null)}>
      <Pressable testID="photo-modal-backdrop" onPress={() => setPhotoRow(null)} style={styles.modalBackdrop}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.formTitle}>Face proof</Text>
          <Text style={styles.formHint}>{photoRow?.user_name} · {photoRow?.date} · {photoRow?.action === "check_in" ? "Clock In" : "Clock Out"}</Text>
          {photoLoading ? <ActivityIndicator color="#DC2626" style={{ marginVertical: 30 }} /> : photoUri ? <Image testID="photo-modal-image" source={{ uri: photoUri }} style={styles.proofImage} resizeMode="cover" /> : <Text style={styles.formHint}>No photo</Text>}
          <Pressable testID="photo-modal-close" onPress={() => setPhotoRow(null)} style={[styles.outlineButton, { marginTop: 12 }]}><Text style={styles.outlineText}>Close</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
    {report && report.summary.length === 0 && !loading && (
      <View style={styles.emptySmall}><Ionicons name="bar-chart-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No records in range</Text><Text style={styles.emptyBody}>Try widening the date window.</Text></View>
    )}
  </View>;
}

function Field({ label, value, onChangeText, keyboardType = "default" }: { label: string; value: string; onChangeText: (value: string) => void; keyboardType?: "default" | "numeric" }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} keyboardType={keyboardType} style={styles.input} placeholderTextColor="#9CA3AF" /></View>;
}

function AvatarView({ user, size = 82 }: { user: User; size?: number }) {
  if (user.avatar && user.avatar.startsWith("data:")) {
    return <Image testID="profile-avatar-img" source={{ uri: user.avatar }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "#FEE2E2" }} />;
  }
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" }}>
    <Text style={{ color: "#991B1B", fontSize: size / 3, fontWeight: "800" }}>{initials(user.full_name || user.name)}</Text>
  </View>;
}

function ProfileScreen({ user, token, onRequestAdmin, onLogout, onUserChange }: { user: User; token: string; onRequestAdmin: () => void; onLogout: () => void; onUserChange: (u: User) => void }) {
  const insets = useSafeAreaInsets();
  const [requestState, setRequestState] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [monthly, setMonthly] = useState<MyMonthlySummary | null>(null);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [showProfilePassword, setShowProfilePassword] = useState(false);
  const [profilePassword, setProfilePassword] = useState("");
  const [profilePasswordBusy, setProfilePasswordBusy] = useState(false);
  const [profilePasswordError, setProfilePasswordError] = useState("");
  const [leaveForm, setLeaveForm] = useState({ leave_type: "annual", start_date: "", end_date: "", reason: "", attachment_url: "" });
  const [correctionForm, setCorrectionForm] = useState({ date: "", action: "check_in", requested_time: "", reason: "", attachment_url: "" });
  const [profileForm, setProfileForm] = useState({
    full_name: user.full_name || user.name || "",
    department: user.department || "",
    phone: user.phone || "",
    address: user.address || "",
    emergency_contact_name: user.emergency_contact_name || "",
    emergency_contact_phone: user.emergency_contact_phone || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [leaveData, correctionData, balanceData, monthlyData, companyData] = await Promise.all([
        apiRequest<Leave[]>("/leaves", token),
        apiRequest<AttendanceCorrection[]>("/attendance-corrections", token),
        apiRequest<LeaveBalance>("/leave-balance", token),
        apiRequest<MyMonthlySummary>("/my-monthly-summary", token),
        apiRequest<CompanyInfo>("/company-info", token),
      ]);
      setLeaves(leaveData); setCorrections(correctionData); setBalance(balanceData); setMonthly(monthlyData); setCompany(companyData);
    } catch {}
  }, [token]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const pickAvatar = async () => {
    setAvatarBusy(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { setRequestState("Izin galeri foto ditolak"); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.5, base64: true });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const updated = await apiRequest<User>("/profile/avatar", token, { method: "PATCH", body: JSON.stringify({ image_base64: `data:image/jpeg;base64,${result.assets[0].base64}` }) });
      onUserChange(updated); setRequestState("Foto profil diperbarui.");
    } catch (err) { setRequestState(err instanceof Error ? err.message : "Tidak dapat memperbarui foto"); }
    finally { setAvatarBusy(false); }
  };

  const requestProfileEdit = () => {
    setProfilePassword("");
    setProfilePasswordError("");
    setShowProfilePassword(true);
  };

  const verifyProfileEditPassword = async () => {
    if (!profilePassword.trim()) {
      setProfilePasswordError("Masukkan kata sandi akun.");
      return;
    }
    setProfilePasswordBusy(true);
    setProfilePasswordError("");
    try {
      await apiRequest("/auth/profile-edit/verify", token, {
        method: "POST",
        body: JSON.stringify({ password: profilePassword }),
      });
      setProfilePassword("");
      setShowProfilePassword(false);
      setShowProfileEdit(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kata sandi salah.";
      setProfilePasswordError(
        /incorrect password/i.test(message) ? "Kata sandi salah." : message
      );
    } finally {
      setProfilePasswordBusy(false);
    }
  };

  const saveProfile = async () => {
    setBusy(true); setError("");
    try {
      const updated = await apiRequest<User>("/profile", token, { method: "PATCH", body: JSON.stringify(profileForm) });
      onUserChange(updated); setShowProfileEdit(false); setRequestState("Profil diperbarui.");
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat memperbarui profil"); }
    finally { setBusy(false); }
  };

  const submitLeave = async () => {
    if (!leaveForm.start_date || !leaveForm.end_date || !leaveForm.reason) { setError("Tanggal dan alasan cuti wajib diisi"); return; }
    setBusy(true); setError("");
    try {
      await apiRequest("/leaves", token, { method: "POST", body: JSON.stringify({ ...leaveForm, attachment_url: leaveForm.attachment_url.trim() || null }) });
      setLeaveForm({ leave_type: "annual", start_date: "", end_date: "", reason: "", attachment_url: "" });
      setShowLeaveForm(false); await loadAll();
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat mengajukan cuti"); }
    finally { setBusy(false); }
  };

  const submitCorrection = async () => {
    if (!correctionForm.date || !correctionForm.requested_time || !correctionForm.reason) { setError("Tanggal, waktu, dan alasan koreksi wajib diisi"); return; }
    setBusy(true); setError("");
    try {
      await apiRequest("/attendance-corrections", token, { method: "POST", body: JSON.stringify({ ...correctionForm, attachment_url: correctionForm.attachment_url.trim() || null }) });
      setCorrectionForm({ date: "", action: "check_in", requested_time: "", reason: "", attachment_url: "" });
      setShowCorrectionForm(false); await loadAll();
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat mengajukan koreksi"); }
    finally { setBusy(false); }
  };

  const cancelRequest = async (kind: "leaves" | "attendance-corrections" | "overtime-requests", id: string) => {
    try { await apiRequest(`/${kind}/${id}/cancel`, token, { method: "POST" }); await loadAll(); }
    catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat membatalkan permintaan"); }
  };

  const monthlyWork = monthly?.work_time?.total_seconds ?? Math.floor((monthly?.work_time?.total_minutes || 0) * 60);

  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Profil</Text>
      <Text style={styles.subheading}>Akun PKUCITY Anda telah terverifikasi</Text>

      <View style={styles.profileCard}>
        <Pressable testID="avatar-change-button" onPress={pickAvatar} disabled={avatarBusy} style={{ marginBottom: 15 }}>
          <AvatarView user={user} size={92} />
          <View style={styles.avatarEdit}>{avatarBusy ? <ActivityIndicator color="#fff" /> : <Ionicons name="camera" size={16} color="#fff" />}</View>
        </Pressable>
        <Text style={styles.profileName}>{user.full_name || user.name}</Text>
        <Text style={styles.profileEmail}>{user.email}</Text>
        {!!user.employee_id && <Text style={styles.profileEmail}>ID: {user.employee_id}</Text>}
        {!!user.department && <Text style={styles.profileEmail}>{user.department}</Text>}
        <View style={styles.roleBadge}><Text style={styles.roleText}>{user.role === "admin" ? "ADMIN" : "KARYAWAN"}</Text></View>
      </View>

      <View style={styles.profileAction}>
        <View style={styles.officeRow}><View style={{ flex: 1 }}><Text style={styles.formTitle}>Ringkasan bulan ini</Text><Text style={styles.formHint}>Ringkasan absensi bulan berjalan.</Text></View></View>
        <Text style={styles.verifySub}>Waktu kerja: {formatWorkSeconds(monthlyWork)}</Text>
        <Text style={styles.verifySub}>Terlambat: {monthly?.late_days ?? 0} hari · {monthly?.late_minutes ?? 0} menit</Text>
        <Text style={styles.verifySub}>Tidak hadir: {monthly?.absent_days ?? 0} hari</Text>
        <Text style={styles.verifySub}>Cuti tahunan: {balance?.remaining ?? "—"} tersisa / {balance?.quota ?? "—"} total</Text>
      </View>

      <View style={styles.profileAction}>
        <View style={styles.officeRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.formTitle}>Informasi pribadi</Text>
            <Text style={styles.formHint}>Data diri akun karyawan.</Text>
          </View>
          <Pressable
            testID="profile-edit-button"
            onPress={() => {
              if (showProfileEdit) {
                setShowProfileEdit(false);
                setError("");
              } else {
                requestProfileEdit();
              }
            }}
            style={styles.approve}
          >
            <Text style={styles.approveText}>{showProfileEdit ? "Tutup" : "Ubah"}</Text>
          </Pressable>
        </View>

        {!showProfileEdit && (
          <View style={styles.personalInfoList}>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Nama lengkap</Text><Text style={styles.personalInfoValue}>{user.full_name || user.name || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Jabatan</Text><Text style={styles.personalInfoValue}>{user.department || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>ID Karyawan</Text><Text style={styles.personalInfoValue}>{user.employee_id || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Email</Text><Text style={styles.personalInfoValue}>{user.email || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Nomor telepon</Text><Text style={styles.personalInfoValue}>{user.phone || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Alamat</Text><Text style={styles.personalInfoValue}>{user.address || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Kontak darurat</Text><Text style={styles.personalInfoValue}>{user.emergency_contact_name || "—"}</Text></View>
            <View style={styles.personalInfoRow}><Text style={styles.personalInfoLabel}>Nomor kontak darurat</Text><Text style={styles.personalInfoValue}>{user.emergency_contact_phone || "—"}</Text></View>
          </View>
        )}

        {showProfileEdit && (
          <View style={{ marginTop: 10 }}>
            <Field label="Nama lengkap" value={profileForm.full_name} onChangeText={(v) => setProfileForm({ ...profileForm, full_name: v })} />
            <Field label="Departemen / Posisi" value={profileForm.department} onChangeText={(v) => setProfileForm({ ...profileForm, department: v })} />
            <Field label="Nomor telepon" value={profileForm.phone} onChangeText={(v) => setProfileForm({ ...profileForm, phone: v })} />
            <Field label="Alamat" value={profileForm.address} onChangeText={(v) => setProfileForm({ ...profileForm, address: v })} multiline />
            <Field label="Nama kontak darurat" value={profileForm.emergency_contact_name} onChangeText={(v) => setProfileForm({ ...profileForm, emergency_contact_name: v })} />
            <Field label="Nomor kontak darurat" value={profileForm.emergency_contact_phone} onChangeText={(v) => setProfileForm({ ...profileForm, emergency_contact_phone: v })} />
            <Pressable onPress={saveProfile} disabled={busy} style={styles.primaryButton}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Simpan profil</Text>}
            </Pressable>
          </View>
        )}

        {showProfilePassword && (
          <View style={styles.profilePasswordGate}>
            <Text style={styles.verifyTitle}>Verifikasi kata sandi</Text>
            <Text style={styles.formHint}>Masukkan kata sandi akun untuk mengubah informasi pribadi.</Text>
            <TextInput
              testID="profile-edit-password-input"
              value={profilePassword}
              onChangeText={setProfilePassword}
              placeholder="Kata sandi akun"
              placeholderTextColor="#9CA3AF"
              secureTextEntry
              autoCapitalize="none"
              style={styles.input}
              editable={!profilePasswordBusy}
              onSubmitEditing={verifyProfileEditPassword}
            />
            {!!profilePasswordError && <Text style={styles.profilePasswordError}>{profilePasswordError}</Text>}
            <View style={styles.officeActions}>
              <Pressable
                onPress={() => {
                  setShowProfilePassword(false);
                  setProfilePassword("");
                  setProfilePasswordError("");
                }}
                disabled={profilePasswordBusy}
                style={[styles.outlineButton, { flex: 1 }]}
              >
                <Text style={styles.outlineText}>Batal</Text>
              </Pressable>
              <Pressable
                testID="profile-edit-password-submit"
                onPress={verifyProfileEditPassword}
                disabled={profilePasswordBusy || !profilePassword.trim()}
                style={[styles.primaryButton, { flex: 1 }, (!profilePassword.trim() || profilePasswordBusy) && styles.disabled]}
              >
                {profilePasswordBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Verifikasi</Text>}
              </Pressable>
            </View>
          </View>
        )}
      </View>

      <View style={styles.profileAction}>
        <View style={styles.officeRow}><View style={{ flex: 1 }}><Text style={styles.formTitle}>Pengajuan cuti & izin saya</Text><Text style={styles.formHint}>Cuti tahunan, sakit, izin, atau perjalanan dinas.</Text></View><Pressable onPress={() => setShowLeaveForm(v => !v)} style={styles.approve}><Text style={styles.approveText}>{showLeaveForm ? "Tutup" : "Baru"}</Text></Pressable></View>
        {showLeaveForm && <View style={{ marginTop: 10 }}>
          <Text style={styles.miniLabel}>JENIS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
            {(["annual","sick","permission","business_trip"] as const).map(t => <Pressable key={t} onPress={() => setLeaveForm({ ...leaveForm, leave_type: t })} style={[styles.segmentChip, leaveForm.leave_type === t && styles.segmentChipActive]}><Text style={[styles.segmentText, leaveForm.leave_type === t && styles.segmentTextActive]}>{t.replace("_"," ")}</Text></Pressable>)}
          </ScrollView>
          <Field label="Tanggal mulai (YYYY-MM-DD)" value={leaveForm.start_date} onChangeText={(v) => setLeaveForm({ ...leaveForm, start_date: v })} />
          <Field label="Tanggal selesai (YYYY-MM-DD)" value={leaveForm.end_date} onChangeText={(v) => setLeaveForm({ ...leaveForm, end_date: v })} />
          <Field label="Alasan" value={leaveForm.reason} onChangeText={(v) => setLeaveForm({ ...leaveForm, reason: v })} multiline />
          <Field label="URL dokumen pendukung (PDF/Gambar, opsional)" value={leaveForm.attachment_url} onChangeText={(v) => setLeaveForm({ ...leaveForm, attachment_url: v })} />
          <Pressable onPress={submitLeave} disabled={busy} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Submit request</Text></Pressable>
        </View>}
        {leaves.map(leave => <View key={leave.leave_id} style={styles.leaveItem}><View style={{ flex: 1 }}><Text style={styles.verifyTitle}>{(leave.leave_type || "annual").replace("_"," ").toUpperCase()} · {leave.start_date} → {leave.end_date}</Text><Text style={styles.verifySub}>{leave.reason}</Text>{leave.status === "pending" && <Pressable onPress={() => cancelRequest("leaves", leave.leave_id)}><Text style={[styles.verifySub, { color: "#B91C1C" }]}>Batalkan pengajuan yang menunggu</Text></Pressable>}</View><Text style={styles.verifySub}>{{ pending: "MENUNGGU", approved: "DISETUJUI", rejected: "DITOLAK", cancelled: "DIBATALKAN" }[leave.status]}</Text></View>)}
      </View>

      <View style={styles.profileAction}>
        <View style={styles.officeRow}><View style={{ flex: 1 }}><Text style={styles.formTitle}>Koreksi absensi</Text><Text style={styles.formHint}>Gunakan jika lupa Clock In/Clock Out atau terjadi kesalahan sistem.</Text></View><Pressable onPress={() => setShowCorrectionForm(v => !v)} style={styles.approve}><Text style={styles.approveText}>{showCorrectionForm ? "Tutup" : "Baru"}</Text></Pressable></View>
        {showCorrectionForm && <View style={{ marginTop: 10 }}>
          <View style={styles.officeActions}><Pressable onPress={() => setCorrectionForm({ ...correctionForm, action: "check_in" })} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Clock In</Text></Pressable><Pressable onPress={() => setCorrectionForm({ ...correctionForm, action: "check_out" })} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Clock Out</Text></Pressable></View>
          <Field label="Tanggal (YYYY-MM-DD)" value={correctionForm.date} onChangeText={(v) => setCorrectionForm({ ...correctionForm, date: v })} />
          <Field label="Requested time (HH:MM WIB)" value={correctionForm.requested_time} onChangeText={(v) => setCorrectionForm({ ...correctionForm, requested_time: v })} />
          <Field label="Alasan" value={correctionForm.reason} onChangeText={(v) => setCorrectionForm({ ...correctionForm, reason: v })} multiline />
          <Field label="URL dokumen pendukung (PDF/Gambar, opsional)" value={correctionForm.attachment_url} onChangeText={(v) => setCorrectionForm({ ...correctionForm, attachment_url: v })} />
          <Pressable onPress={submitCorrection} disabled={busy} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Submit correction</Text></Pressable>
        </View>}
        {corrections.map(item => <View key={item.correction_id} style={styles.leaveItem}><View style={{ flex: 1 }}><Text style={styles.verifyTitle}>{item.date} · {item.action.replace("_"," ")} · {item.requested_time}</Text><Text style={styles.verifySub}>{item.reason}</Text>{item.status === "pending" && <Pressable onPress={() => cancelRequest("attendance-corrections", item.correction_id)}><Text style={[styles.verifySub, { color: "#B91C1C" }]}>Withdraw pending correction</Text></Pressable>}</View><Text style={styles.verifySub}>{{ pending: "MENUNGGU", approved: "DISETUJUI", rejected: "DITOLAK", cancelled: "DIBATALKAN" }[item.status]}</Text></View>)}
      </View>

      <View style={styles.profileAction}>
        <Text style={styles.formTitle}>Informasi perusahaan</Text>
        <Text style={styles.formHint}>Pengumuman, hari libur, dan peraturan yang dibagikan HR/Admin.</Text>
        {(company?.announcements || []).map(item => <View key={item.announcement_id} style={{ marginTop: 12 }}><Text style={styles.verifyTitle}>{item.title}</Text><Text style={styles.verifySub}>{item.body}</Text></View>)}
        {(company?.holidays || []).map(item => <View key={item.holiday_id} style={{ marginTop: 8 }}><Text style={styles.verifyTitle}>{item.date}</Text><Text style={styles.verifySub}>{item.label}</Text></View>)}
        {(company?.policies || []).map(item => <View key={item.policy_id} style={{ marginTop: 12 }}><Text style={styles.verifyTitle}>{item.title}</Text><Text style={styles.verifySub}>{item.body}</Text></View>)}
        {!company?.announcements?.length && !company?.policies?.length && !company?.holidays?.length && <Text style={styles.verifySub}>Belum ada informasi perusahaan yang dipublikasikan.</Text>}
      </View>

      {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
      {!!requestState && <Text style={styles.verifySub}>{requestState}</Text>}
      <Pressable testID="logout-button" onPress={onLogout} style={styles.logoutButton}><Ionicons name="log-out-outline" size={20} color="#DC2626" /><Text style={styles.logoutText}>Keluar</Text></Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function NotificationsModal({ visible, token, onClose, onChange }: { visible: boolean; token: string; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<NotificationList | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { const result = await apiRequest<NotificationList>("/notifications", token); setData(result); }
    catch {}
    finally { setBusy(false); }
  }, [token]);
  useEffect(() => { if (visible) load(); }, [visible, load]);
  const markRead = async (id: string) => {
    try { await apiRequest(`/notifications/${id}/read`, token, { method: "POST" }); await load(); onChange(); } catch {}
  };
  const markAll = async () => {
    try { await apiRequest("/notifications/read-all", token, { method: "POST" }); await load(); onChange(); } catch {}
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable testID="notifications-backdrop" onPress={onClose} style={styles.modalBackdrop}>
      <Pressable style={[styles.modalCard, { maxHeight: "80%" }]} onPress={() => {}}>
        <View style={styles.officeRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.formTitle}>Notifications</Text>
            <Text style={styles.formHint}>{data?.unread ? `${data.unread} unread` : "You're all caught up"}</Text>
          </View>
          {(data?.unread || 0) > 0 && <Pressable testID="mark-all-read-button" onPress={markAll} style={styles.approve}><Text style={styles.approveText}>Mark all</Text></Pressable>}
        </View>
        <ScrollView style={{ marginTop: 12 }} contentContainerStyle={{ paddingBottom: 20 }}>
          {busy && <ActivityIndicator color="#DC2626" style={{ marginVertical: 20 }} />}
          {!busy && (data?.items.length || 0) === 0 && <View style={styles.emptySmall}><Ionicons name="notifications-off-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No notifications</Text><Text style={styles.emptyBody}>Approvals and updates will appear here.</Text></View>}
          {data?.items.map((item) => (
            <Pressable testID={`notification-${item.notification_id}`} key={item.notification_id} onPress={() => !item.read && markRead(item.notification_id)} style={[styles.notifCard, !item.read && styles.notifUnread]}>
              <View style={[styles.notifIcon, item.category === "leave_approved" ? { backgroundColor: "#DCFCE7" } : item.category === "leave_rejected" ? { backgroundColor: "#FEE2E2" } : { backgroundColor: "#FEF3C7" }]}>
                <Ionicons name={item.category === "leave_approved" ? "checkmark-circle" : item.category === "leave_rejected" ? "close-circle" : "information-circle"} size={20} color={item.category === "leave_approved" ? "#16A34A" : item.category === "leave_rejected" ? "#B91C1C" : "#B45309"} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.verifyTitle}>{item.title}</Text>
                <Text style={styles.verifySub}>{item.body}</Text>
                <Text style={[styles.formHint, { marginTop: 4, marginBottom: 0 }]}>{new Date(item.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Text>
              </View>
              {!item.read && <View style={styles.notifDot} />}
            </Pressable>
          ))}
        </ScrollView>
        <Pressable testID="notifications-close" onPress={onClose} style={[styles.outlineButton, { marginTop: 4 }]}><Text style={styles.outlineText}>Close</Text></Pressable>
      </Pressable>
    </Pressable>
  </Modal>;
}

function BottomBar({ active, onChange, isAdmin }: { active: string; onChange: (value: string) => void; isAdmin: boolean }) {
  const tabs = [{ key: "home", label: "Beranda", icon: "home-outline" }, { key: "history", label: "Riwayat", icon: "time-outline" }, ...(isAdmin ? [{ key: "admin", label: "Admin", icon: "settings-outline" }] : []), { key: "profile", label: "Profil", icon: "person-outline" }];
  return <BlurView intensity={80} tint="light" style={styles.bottomBar}>{tabs.map((tab) => <Pressable testID={`tab-${tab.key}`} key={tab.key} onPress={() => onChange(tab.key)} style={({ pressed }) => [styles.tab, pressed && styles.pressed]}><Ionicons name={tab.icon as keyof typeof Ionicons.glyphMap} size={22} color={active === tab.key ? "#DC2626" : "#6B7280"} /><Text style={[styles.tabLabel, active === tab.key && styles.tabActive]}>{tab.label}</Text></Pressable>)}</BlurView>;
}

export default function Index() {
  const [authState, setAuthState] = useState<"loading" | "signed_out" | "password_setup" | "locked" | "signed_in">("loading");
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [active, setActive] = useState("home");
  const [captureAction, setCaptureAction] = useState<"check_in" | "check_out" | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const backgroundAtRef = useRef<number | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const insets = useSafeAreaInsets();

  const signOut = useCallback(async () => {
    if (token) {
      try {
        await apiRequest("/auth/logout", token, { method: "POST" });
      } catch {
        // Local sign-out still proceeds. If the backend could not be reached,
        // the account remains bound to this device until its server session expires.
      }
    }
    await clearToken();
    setToken(""); setUser(null); setDashboard(null); setRecords([]); setAuthState("signed_out");
  }, [token]);

  const loadApp = useCallback(async (sessionToken: string) => {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out. Please try again.")), 12000));
    const [me, home, history] = await Promise.race([
      Promise.all([
        apiRequest<User>("/auth/me", sessionToken),
        apiRequest<Dashboard>("/dashboard", sessionToken),
        apiRequest<RecordItem[]>("/attendance", sessionToken),
      ]),
      timeout,
    ]);
    setToken(sessionToken); setUser(me); setDashboard(home); setRecords(history); setAuthState("signed_in");
  }, []);

  const prepareSession = useCallback(async (sessionToken: string, forceLock: boolean) => {
    setToken(sessionToken);
    if (forceLock) await apiRequest("/auth/lock", sessionToken, { method: "POST" }).catch(() => {});
    const status = await apiRequest<{ user: User; password_set: boolean; unlocked: boolean }>("/auth/security-status", sessionToken);
    setUser(status.user);
    if (!status.password_set) { setAuthState("password_setup"); return; }
    if (forceLock || !status.unlocked) { setAuthState("locked"); return; }
    await loadApp(sessionToken);
  }, [loadApp]);

  const afterPassword = useCallback(async () => {
    if (!token) return;
    await loadApp(token);
  }, [token, loadApp]);

  const exchange = useCallback(async (sessionId: string) => {
    if (!sessionId || usedSessionIds.has(sessionId)) return;
    usedSessionIds.add(sessionId); setAuthBusy(true); setAuthError("");
    try {
      const deviceId = await getOrCreateDeviceId();
      const response = await fetch(apiUrl("/auth/session"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, device_id: deviceId }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || "Google verification failed");
      const data = await response.json();
      await saveToken(data.session_token);
      setToken(data.session_token); setUser(data.user);
      await prepareSession(data.session_token, true);
      if (Platform.OS === "web") {
        const cleanUrl = window.location.href.replace(/([?#&])session_id=[^&#]+/, "").replace(/[?&]$/, "");
        window.history.replaceState(window.history.state, "", cleanUrl);
      }
    } catch (error) {
      usedSessionIds.delete(sessionId);
      setAuthError(error instanceof Error ? error.message : "Google verification failed");
      setAuthState("signed_out");
    } finally { setAuthBusy(false); }
  }, [prepareSession]);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | undefined;
    const handleUrl = (url: string) => { const id = sessionIdFromUrl(url); if (id && mounted) void exchange(id); };
    const setup = async () => {
      try {
        const initial = Platform.OS === "web" ? window.location.href : await Linking.getInitialURL();
        const callbackSessionId = sessionIdFromUrl(initial);
        if (callbackSessionId) handleUrl(initial || "");
        else {
          const existing = await readToken();
          if (!mounted) return;
          if (existing) await prepareSession(existing, true);
          else setAuthState("signed_out");
        }
        if (Platform.OS !== "web") {
          const listener = Linking.addEventListener("url", (event) => handleUrl(event.url));
          cleanup = () => listener.remove();
        }
      } catch (error) {
        if (!mounted) return;
        console.warn("Startup bootstrap failed", error);
        await clearToken().catch(() => {});
        setToken(""); setUser(null);
        setAuthError(error instanceof Error ? error.message : "Could not restore the previous session. Please sign in again.");
        setAuthState("signed_out");
      }
    };
    void setup();
    const startupFallback = setTimeout(() => { if (mounted) setAuthState((current) => current === "loading" ? "signed_out" : current); }, 15000);
    return () => { mounted = false; clearTimeout(startupFallback); cleanup?.(); };
  }, [exchange, prepareSession]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === "background" || nextState === "inactive") {
        if (prev === "active") backgroundAtRef.current = Date.now();
        return;
      }
      if (nextState === "active" && backgroundAtRef.current && authState === "signed_in" && token) {
        const awayMs = Date.now() - backgroundAtRef.current;
        backgroundAtRef.current = null;
        if (awayMs >= 10 * 60 * 1000) {
          setCaptureAction(null); setNotifOpen(false); setAuthState("locked");
          void apiRequest("/auth/lock", token, { method: "POST" }).catch(() => {});
        }
      }
    });
    return () => sub.remove();
  }, [authState, token]);

  const login = async () => {
    setAuthBusy(true); setAuthError("");
    try {
      const redirectUrl = Platform.OS === "web" ? `${window.location.origin}/` : Linking.createURL("");
      const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
      if (Platform.OS === "web") window.location.href = authUrl;
      else {
        let linkedUrl: string | null = null;
        const listener = Linking.addEventListener("url", (event) => { linkedUrl = event.url; });
        const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
        listener.remove();
        const callback = result.type === "success" ? result.url : linkedUrl || await Linking.getInitialURL();
        const id = sessionIdFromUrl(callback);
        if (id) await exchange(id); else setAuthError("Google sign-in was cancelled.");
      }
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Could not open Google sign-in"); setAuthBusy(false); }
  };

  const refresh = async () => { if (!token || authState !== "signed_in") return; try { const [home, history] = await Promise.all([apiRequest<Dashboard>("/dashboard", token), apiRequest<RecordItem[]>("/attendance", token)]); setDashboard(home); setRecords(history); } catch (err) { if (err instanceof Error && err.message.toLowerCase().includes("password")) setAuthState("locked"); } };
  useEffect(() => {
    if (!token || authState !== "signed_in") return;
    const interval = setInterval(() => { apiRequest<Dashboard>("/dashboard", token).then(setDashboard).catch((err) => { if (err instanceof Error && err.message.toLowerCase().includes("password")) setAuthState("locked"); }); }, 5000);
    return () => clearInterval(interval);
  }, [token, authState]);

  const done = (message: string) => { setCaptureAction(null); Alert.alert("Absensi berhasil diverifikasi", message); refresh(); };
  if (authState === "loading" || (authBusy && authState === "signed_out")) return <LoadingScreen />;
  if (authState === "signed_out" || !user) return <AuthScreen onLogin={login} busy={authBusy} error={authError} />;
  if (authState === "password_setup") return <PasswordGateScreen mode="setup" token={token} user={user} onUnlocked={afterPassword} onLogout={signOut} />;
  if (authState === "locked") return <PasswordGateScreen mode="unlock" token={token} user={user} onUnlocked={afterPassword} onLogout={signOut} />;
  if (!user.profile_complete) return <OnboardingScreen user={user} token={token} onDone={(updated) => setUser(updated)} />;
  if (captureAction) return <CaptureScreen action={captureAction} token={token} onDone={done} onBatal={() => setCaptureAction(null)} />;
  return <View style={[styles.root, { paddingBottom: insets.bottom }]}>{active === "home" && <HomeScreen dashboard={dashboard} token={token} onRefresh={refresh} onOpenCapture={setCaptureAction} onOpenNotifications={() => setNotifOpen(true)} />}{active === "history" && <HistoryScreen records={records} loading={!records} />}{active === "admin" && user.role === "admin" && <AdminScreen token={token} />}{active === "profile" && <ProfileScreen user={user} token={token} onRequestAdmin={() => setActive("profile")} onLogout={signOut} onUserChange={setUser} />}<BottomBar active={active} onChange={setActive} isAdmin={user.role === "admin"} /><NotificationsModal visible={notifOpen} token={token} onClose={() => setNotifOpen(false)} onChange={refresh} /></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 22, backgroundColor: "#fff" },
  authRoot: { flex: 1, backgroundColor: "#fff", justifyContent: "space-between", paddingHorizontal: 24, paddingTop: 70, paddingBottom: 24 },
  authTop: { alignItems: "flex-start" },
  redOrb: { position: "absolute", width: 280, height: 280, borderRadius: 140, backgroundColor: "#FEF2F2", right: -115, top: -180 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandCompact: { flexDirection: "row", alignItems: "center", gap: 8 },
  brandIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#DC2626" },
  brandText: { fontSize: 27, fontWeight: "800", letterSpacing: -1.2, color: "#111827" },
  brandTextCompact: { fontSize: 20, fontWeight: "800", letterSpacing: -0.8, color: "#111827" },
  eyebrow: { marginTop: 62, color: "#DC2626", fontSize: 12, fontWeight: "800", letterSpacing: 1.8 },
  authTitle: { marginTop: 12, fontSize: 34, lineHeight: 41, color: "#111827", fontWeight: "800", letterSpacing: -1.2 },
  authBody: { marginTop: 16, color: "#6B7280", fontSize: 16, lineHeight: 24, maxWidth: 330 },
  authCard: { borderTopWidth: 1, borderTopColor: "#F3F4F6", paddingTop: 20 },
  secureRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 18 },
  secureText: { color: "#4B5563", fontSize: 13, fontWeight: "600" },
  googleButton: { minHeight: 56, borderRadius: 16, backgroundColor: "#fff", borderWidth: 1, borderColor: "#D1D5DB", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  googleBadge: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  googleG: { fontSize: 19, fontWeight: "800", color: "#4285F4" },
  googleButtonText: { color: "#111827", fontWeight: "700", fontSize: 15, flex: 1 },
  legal: { textAlign: "center", color: "#9CA3AF", fontSize: 11, lineHeight: 16, marginTop: 18 },
  scroll: { paddingHorizontal: 20 },
  profileHeaderCard: { backgroundColor: "#fff", borderRadius: 22, padding: 18, marginBottom: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#F3F4F6", shadowColor: "#111827", shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  profileHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 14, flex: 1 },
  profileHeaderHello: { color: "#6B7280", fontSize: 13, fontWeight: "600", marginBottom: 2 },
  profileHeaderName: { color: "#111827", fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  profileHeaderMeta: { color: "#9CA3AF", fontSize: 12, fontWeight: "600", marginTop: 3 },
  dateTimeCard: { backgroundColor: "#fff", borderRadius: 18, padding: 16, marginBottom: 16, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#F3F4F6" },
  dateTimeIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#FEF2F2" },
  dateTimeLabel: { color: "#9CA3AF", fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  dateTimeValue: { color: "#111827", fontSize: 22, fontWeight: "800", marginTop: 2 },
  dateTimeDate: { color: "#6B7280", fontSize: 13, fontWeight: "600", marginTop: 2 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 22 },
  greeting: { color: "#6B7280", fontSize: 14, marginBottom: 4 },
  heading: { fontSize: 27, lineHeight: 34, fontWeight: "800", letterSpacing: -0.7, color: "#111827" },
  subheading: { color: "#6B7280", fontSize: 15, marginTop: 5, marginBottom: 22 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#991B1B", fontWeight: "800", fontSize: 14 },
  liveCard: { backgroundColor: "#DC2626", borderRadius: 22, padding: 20, shadowColor: "#991B1B", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  cardKicker: { color: "#FECACA", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  todayStatusRows: { marginTop: 10, gap: 4 },
  todayStatusText: { color: "rgba(255,255,255,0.88)", fontSize: 13, fontWeight: "600" },
  cardTitle: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 8 },
  rule: { height: 1, backgroundColor: "rgba(255,255,255,0.22)", marginVertical: 18 },
  scheduleRow: { flexDirection: "row", alignItems: "center" },
  scheduleDivider: { width: 1, height: 30, backgroundColor: "rgba(255,255,255,0.24)", marginHorizontal: 18 },
  miniLabel: { color: "#FECACA", fontSize: 10, fontWeight: "800", letterSpacing: 0.7 },
  scheduleValue: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 5 },
  workTimerRow: {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
},

workTimerValue: {
  color: "#fff",
  fontSize: 30,
  fontWeight: "800",
  marginTop: 5,
  letterSpacing: -0.8,
},

timerLiveBadge: {
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
  backgroundColor: "rgba(255,255,255,0.16)",
  borderRadius: 999,
  paddingHorizontal: 10,
  paddingVertical: 6,
},

timerLiveDot: {
  width: 7,
  height: 7,
  borderRadius: 4,
  backgroundColor: "#fff",
},

timerLiveText: {
  color: "#fff",
  fontSize: 10,
  fontWeight: "800",
  letterSpacing: 0.8,
},
  statusPill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  successPill: { backgroundColor: "#DCFCE7" },
  warningPill: { backgroundColor: "#FEF3C7" },
  neutralPill: { backgroundColor: "#F3F4F6" },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  successDot: { backgroundColor: "#16A34A" },
  warningDot: { backgroundColor: "#CA8A04" },
  neutralDot: { backgroundColor: "#9CA3AF" },
  pillText: { fontSize: 11, fontWeight: "800" },
  successText: { color: "#15803D" },
  warningText: { color: "#A16207" },
  neutralText: { color: "#6B7280" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 28, marginBottom: 13 },
  sectionTitle: { fontSize: 19, fontWeight: "800", color: "#111827" },
  verifyCard: { minHeight: 74, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: "#F3F4F6", padding: 15, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  verifyIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#FEF2F2", alignItems: "center", justifyContent: "center" },
  verifyCopy: { flex: 1 },
  verifyTitle: { fontSize: 15, fontWeight: "800", color: "#111827" },
  verifySub: { fontSize: 12, color: "#6B7280", marginTop: 4 },
  helper: { fontSize: 12, color: "#9CA3AF", lineHeight: 18, marginTop: 4 },
  topAttendanceAction: { alignItems: "center", marginTop: 0, marginBottom: 16 },
  topAttendanceButton: { minWidth: 250 },
  actionArea: { alignItems: "center", marginTop: 30 },
  primaryButton: { minHeight: 52, borderRadius: 15, backgroundColor: "#DC2626", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10, paddingHorizontal: 20 },
  primaryButtonText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  actionCaption: { color: "#9CA3AF", fontSize: 12, marginTop: 10, textAlign: "center", paddingHorizontal: 8 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.5 },
  bottomBar: { minHeight: 70, borderTopWidth: 1, borderTopColor: "rgba(229,231,235,0.85)", flexDirection: "row", alignItems: "center", justifyContent: "space-around", overflow: "hidden" },
  tab: { minWidth: 62, minHeight: 54, alignItems: "center", justifyContent: "center", gap: 3 },
  tabLabel: { fontSize: 11, color: "#6B7280", fontWeight: "600" },
  tabActive: { color: "#DC2626", fontWeight: "800" },
  historyCard: { minHeight: 76, backgroundColor: "#fff", borderRadius: 16, padding: 13, flexDirection: "row", alignItems: "center", marginBottom: 10, borderWidth: 1, borderColor: "#F3F4F6" },
  historyIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#FEF2F2", alignItems: "center", justifyContent: "center", marginRight: 12 },
  historyCopy: { flex: 1 },
  historyDate: { color: "#111827", fontWeight: "800", fontSize: 14 },
  historyTime: { color: "#6B7280", fontSize: 12, marginTop: 4 },
  historyRight: { alignItems: "flex-end", gap: 6 },
  distance: { color: "#9CA3AF", fontSize: 10 },
  empty: { alignItems: "center", paddingTop: 75, paddingHorizontal: 30 },
  emptySmall: { alignItems: "center", paddingTop: 25, paddingBottom: 25, paddingHorizontal: 30 },
  emptyTitle: { color: "#111827", fontSize: 17, fontWeight: "800", marginTop: 15 },
  emptyBody: { color: "#6B7280", textAlign: "center", lineHeight: 20, fontSize: 13, marginTop: 7 },
  captureRoot: { flex: 1, backgroundColor: "#fff", alignItems: "center" },
  cameraFrame: { flex: 1, width: "100%", backgroundColor: "#111827", overflow: "hidden" },
  cameraShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  cameraTopShade: { position: "absolute", top: 0, left: 0, right: 0, height: 170, backgroundColor: "rgba(0,0,0,0.28)" },
  cameraBottomShade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 290, backgroundColor: "rgba(0,0,0,0.20)" },
  captureTop: { position: "absolute", top: 0, left: 18, right: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", zIndex: 4 },
  cameraBack: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(17,24,39,0.48)", borderWidth: 1, borderColor: "rgba(255,255,255,0.16)" },
  cameraHeadingWrap: { alignItems: "center" },
  cameraTitle: { color: "#fff", fontSize: 17, fontWeight: "800", letterSpacing: -0.2 },
  cameraSubtitle: { color: "rgba(255,255,255,0.68)", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginTop: 2 },
  secureCameraBadge: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(22,163,74,0.72)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  recordingBadge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(220,38,38,0.9)", paddingHorizontal: 10, height: 30, borderRadius: 15 },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  recordingText: { color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  faceGuide: { position: "absolute", width: 244, height: 324, borderRadius: 122, top: "20%", left: "50%", marginLeft: -122, borderColor: "rgba(255,255,255,0.88)", borderWidth: 2, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  faceGuideActive: { borderColor: "#34D399", borderWidth: 3 },
  faceGuideInner: { width: 220, height: 298, borderRadius: 110, borderWidth: 1, borderColor: "rgba(255,255,255,0.26)" },
  faceHintWrap: { position: "absolute", top: "17%", left: 0, right: 0, alignItems: "center" },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: "rgba(17,24,39,0.62)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#9CA3AF" },
  liveDotActive: { backgroundColor: "#34D399" },
  liveBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1.25 },
  faceCornerTL: { position: "absolute", width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#fff", top: -2, left: -2, borderTopLeftRadius: 18 },
  faceCornerTR: { position: "absolute", width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", top: -2, right: -2, borderTopRightRadius: 18 },
  faceCornerBL: { position: "absolute", width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#fff", bottom: -2, left: -2, borderBottomLeftRadius: 18 },
  faceCornerBR: { position: "absolute", width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#fff", bottom: -2, right: -2, borderBottomRightRadius: 18 },
  captureBottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16 },
  capturePanel: { overflow: "hidden", borderRadius: 28, borderWidth: 1, borderColor: "rgba(255,255,255,0.16)", paddingHorizontal: 18, paddingTop: 17, paddingBottom: 16, backgroundColor: "rgba(17,24,39,0.54)" },
  capturePanelHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  capturePanelIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: "rgba(220,38,38,0.9)", alignItems: "center", justifyContent: "center" },
  capturePanelTitle: { color: "#fff", fontSize: 16, fontWeight: "800" },
  capturePanelBody: { color: "rgba(255,255,255,0.68)", fontSize: 12, lineHeight: 17, marginTop: 3 },
  scanProgressTrack: { height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.16)", marginTop: 15, overflow: "hidden" },
  scanProgressFill: { height: 4, borderRadius: 2, backgroundColor: "#34D399" },
  cameraError: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(127,29,29,0.55)", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, marginTop: 12 },
  cameraErrorText: { color: "#FEE2E2", flex: 1, fontSize: 11, lineHeight: 15, fontWeight: "600" },
  captureActionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  passiveChip: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 82 },
  passiveChipText: { color: "#D1FAE5", fontSize: 11, fontWeight: "700" },
  noMicChip: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, minWidth: 82 },
  noMicChipText: { color: "#E5E7EB", fontSize: 11, fontWeight: "700" },
  scanButton: { width: 66, height: 66, borderRadius: 33, backgroundColor: "#DC2626", borderWidth: 4, borderColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.30, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  scanPulse: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff" },
  captureInstruction: { color: "#fff", fontSize: 15, fontWeight: "700", marginBottom: 14, textAlign: "center", minHeight: 22 },
  captureNoticeError: { color: "#FCA5A5", fontSize: 12, marginBottom: 12, textAlign: "center" },
  stepsRow: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  stepPill: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
  stepPillActive: { backgroundColor: "#DC2626", borderColor: "#fff" },
  stepPillDone: { backgroundColor: "rgba(22,163,74,0.85)", borderColor: "rgba(255,255,255,0.6)" },
  stepIndex: { color: "#fff", fontSize: 11, fontWeight: "800" },
  stepLabel: { color: "#fff", fontSize: 12, fontWeight: "700" },
  shutter: { width: 76, height: 76, borderRadius: 38, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "rgba(255,255,255,0.4)" },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#DC2626" },
  stopButton: { width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "#fff" },
  stopIcon: { width: 26, height: 26, borderRadius: 4, backgroundColor: "#DC2626" },
  rgbActiveBadge: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 9, backgroundColor: "rgba(0,0,0,0.36)" },
  rgbDot: { width: 9, height: 9, borderRadius: 5 },
  rgbActiveText: { color: "#fff", fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  permissionState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  bigIcon: { width: 74, height: 74, borderRadius: 24, backgroundColor: "#FEF2F2", alignItems: "center", justifyContent: "center" },
  backButton: { position: "absolute", left: 18, top: 18, width: 44, height: 44, alignItems: "center", justifyContent: "center", zIndex: 2 },
  captureTitle: { fontSize: 24, fontWeight: "800", color: "#111827" },
  captureBody: { textAlign: "center", color: "#6B7280", fontSize: 15, lineHeight: 22, marginBottom: 12 },
  adminErrorBanner: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: "#FECACA", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  adminErrorBannerText: { flex: 1, color: "#991B1B", fontSize: 13, fontWeight: "700", lineHeight: 18 },
  successBanner: { backgroundColor: "#F0FDF4", padding: 12, borderRadius: 12, flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 14 },
  successBannerText: { color: "#15803D", fontSize: 13, flex: 1, fontWeight: "600" },
  holidayBanner: { backgroundColor: "#FEF3C7", borderRadius: 12, padding: 12, flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 16 },
  holidayText: { color: "#92400E", fontSize: 12, flex: 1, fontWeight: "700" },
  holidayIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },
  segmentedScroll: { paddingVertical: 4, gap: 8, marginBottom: 16 },
  segmentChip: { minHeight: 36, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: "#F3F4F6", borderWidth: 1, borderColor: "transparent" },
  segmentChipActive: { backgroundColor: "#fff", borderColor: "#DC2626" },
  segmentText: { color: "#6B7280", fontSize: 12, fontWeight: "700" },
  segmentTextActive: { color: "#DC2626" },
  employeeListCard: { backgroundColor: "#fff", borderRadius: 18, marginBottom: 10, borderWidth: 1, borderColor: "#F3F4F6", overflow: "hidden" },
  employeeListHeader: { minHeight: 72, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  employeeListName: { flex: 1, color: "#111827", fontSize: 16, lineHeight: 21, fontWeight: "800" },
  employeeDropdown: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E5E7EB", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  employeeDetailRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#F3F4F6" },
  employeeDetailLabel: { flex: 0.42, color: "#6B7280", fontSize: 12, lineHeight: 17, fontWeight: "600" },
  employeeDetailValue: { flex: 0.58, color: "#111827", fontSize: 12, lineHeight: 17, fontWeight: "700", textAlign: "right" },
  requestCard: { backgroundColor: "#fff", minHeight: 72, borderRadius: 15, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: "#F3F4F6", flexDirection: "row", alignItems: "center", gap: 10 },
  avatarSmall: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  requestCopy: { flex: 1 },
  approve: { minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#DC2626", borderRadius: 10 },
  dangerButton: { backgroundColor: "#B91C1C" },
  approveText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  formCard: { backgroundColor: "#fff", padding: 17, borderRadius: 17, borderWidth: 1, borderColor: "#F3F4F6", marginBottom: 12 },
  formTitle: { color: "#111827", fontSize: 17, fontWeight: "800" },
  formHint: { color: "#6B7280", fontSize: 13, lineHeight: 19, marginTop: 5, marginBottom: 15 },
  field: { marginBottom: 13 },
  fieldLabel: { color: "#4B5563", fontSize: 12, fontWeight: "700", marginBottom: 6 },
  input: { minHeight: 48, borderRadius: 11, backgroundColor: "#F9FAFB", borderWidth: 1, borderColor: "#E5E7EB", paddingHorizontal: 13, color: "#111827", fontSize: 15 },
  officeRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  officeActions: { flexDirection: "row", gap: 8, marginTop: 6 },
  activeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  activeBadgeOn: { backgroundColor: "#DCFCE7" },
  activeBadgeOff: { backgroundColor: "#F3F4F6" },
  activeBadgeText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  activeBadgeTextOn: { color: "#15803D" },
  activeBadgeTextOff: { color: "#6B7280" },
  dangerOutline: { borderColor: "#FCA5A5" },
  profileCard: { alignItems: "center", backgroundColor: "#fff", borderRadius: 20, padding: 25, borderWidth: 1, borderColor: "#F3F4F6" },
  avatarLarge: { width: 82, height: 82, borderRadius: 41, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center", marginBottom: 15 },
  avatarLargeText: { color: "#991B1B", fontSize: 25, fontWeight: "800" },
  profileName: { color: "#111827", fontSize: 21, fontWeight: "800" },
  profileEmail: { color: "#6B7280", fontSize: 13, marginTop: 5 },
  verifiedLabel: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 13 },
  verifiedText: { color: "#15803D", fontSize: 12, fontWeight: "700" },
  roleBadge: { backgroundColor: "#FEF2F2", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginTop: 13 },
  roleText: { color: "#B91C1C", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  personalInfoList: { marginTop: 12 },
  personalInfoRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E5E7EB" },
  personalInfoLabel: { flex: 0.42, color: "#6B7280", fontSize: 13, lineHeight: 18, fontWeight: "600" },
  personalInfoValue: { flex: 0.58, color: "#111827", fontSize: 13, lineHeight: 18, fontWeight: "700", textAlign: "right" },
  profilePasswordGate: { marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: "#FFF7F7", borderWidth: 1, borderColor: "#FECACA" },
  profilePasswordError: { color: "#B91C1C", fontSize: 12, fontWeight: "700", marginTop: -2, marginBottom: 10 },
  profileAction: { backgroundColor: "#fff", borderRadius: 17, padding: 17, marginTop: 14, borderWidth: 1, borderColor: "#F3F4F6" },
  outlineButton: { minHeight: 44, borderWidth: 1, borderColor: "#FCA5A5", borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, paddingHorizontal: 14 },
  outlineText: { color: "#DC2626", fontSize: 13, fontWeight: "800" },
  requestState: { color: "#15803D", fontSize: 12, marginTop: 10 },
  logoutButton: { minHeight: 52, marginTop: 24, borderRadius: 14, backgroundColor: "#FEF2F2", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  logoutText: { color: "#DC2626", fontWeight: "800", fontSize: 15 },
  errorBanner: { backgroundColor: "#FEF2F2", borderRadius: 12, padding: 12, flexDirection: "row", gap: 8, marginBottom: 13, alignItems: "center" },
  errorText: { flex: 1, color: "#991B1B", fontSize: 12, lineHeight: 17 },
  reportMetric: { color: "#111827", fontSize: 14, fontWeight: "800" },
  reportMetricMuted: { color: "#6B7280", fontSize: 12, marginTop: 2 },
  employeeRecordTable: { marginTop: 14, borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 14, overflow: "hidden" },
  employeeRecordHeader: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: "#FAFAFA" },
  recordTableHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#F3F4F6", borderTopWidth: 1, borderTopColor: "#E5E7EB" },
  recordTableHeadText: { flex: 1, color: "#6B7280", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  recordTableRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#F3F4F6" },
  recordTableCell: { color: "#374151", fontSize: 10, fontWeight: "600" },
  recordProofCell: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 },
  recordPhotoButton: { width: 18, height: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  recordProofTime: { color: "#374151", fontSize: 10, fontWeight: "700", flexShrink: 1 },
  recordOfficeCell: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  recordOfficeText: { color: "#374151", fontSize: 10, fontWeight: "600", flexShrink: 1 },
  workTimeEmployee: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#F3F4F6", padding: 13, marginTop: 10, flexDirection: "row", alignItems: "flex-start", gap: 11 },
  workTimeEmployeeIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  workTimeEmployeeCopy: { flex: 1 },
  workTimeNameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  workTimeActiveBadge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: "#FEF2F2" },
  timerLiveDotSmall: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#DC2626" },
  workTimeActiveText: { color: "#B91C1C", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  workTimeTotal: { color: "#111827", fontSize: 22, fontWeight: "800", marginTop: 8, letterSpacing: -0.4 },
  overtimeText: { color: "#B45309", fontSize: 11, fontWeight: "700", marginTop: 4 },
  missingCheckoutBanner: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: "#FECACA", borderRadius: 14, padding: 14, marginBottom: 14 },
  missingCheckoutTitle: { color: "#991B1B", fontSize: 14, fontWeight: "800", marginBottom: 3 },
  missingCheckoutText: { color: "#991B1B", fontSize: 12, lineHeight: 17, fontWeight: "600" },
  lateBanner: { backgroundColor: "#FEF2F2", borderRadius: 12, padding: 12, flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 16, borderWidth: 1, borderColor: "#FCA5A5" },
  lateText: { color: "#991B1B", fontSize: 12, flex: 1, fontWeight: "700" },
  mapContainer: { marginBottom: 15 },
  mapView: { height: 220, borderRadius: 14, overflow: "hidden" },
  mapHint: { color: "#6B7280", fontSize: 12, marginTop: 8, textAlign: "center" },
  mapNotice: { backgroundColor: "#FEF2F2", padding: 16, borderRadius: 14, alignItems: "center", gap: 8, marginBottom: 15 },
  mapNoticeText: { color: "#991B1B", fontSize: 12, textAlign: "center", lineHeight: 18 },
  leaveBanner: { backgroundColor: "#DBEAFE", borderRadius: 12, padding: 12, flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 16 },
  leaveText: { color: "#1E40AF", fontSize: 12, flex: 1, fontWeight: "700" },
  avatarEdit: { position: "absolute", right: -2, bottom: -2, width: 30, height: 30, borderRadius: 15, backgroundColor: "#DC2626", alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#fff" },
  leaveItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#F3F4F6" },
  leaveStatus: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, marginTop: 6 },
  leaveStatusText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  statusSetujuid: { backgroundColor: "#DCFCE7" },
  statusTolaked: { backgroundColor: "#FEE2E2" },
  statusMenunggu: { backgroundColor: "#FEF3C7" },
  hrStatsGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 10, marginVertical: 12 },
  hrStatCard: { width: "48%", minHeight: 86, backgroundColor: "#F9FAFB", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 14, alignItems: "center", justifyContent: "center" },
  hrStatCardWide: { width: "100%" },
  hrStatLabel: { color: "#6B7280", fontSize: 12, lineHeight: 16, fontWeight: "700", marginTop: 4, textAlign: "center" },
  statsTotalsRow: { flexDirection: "row", gap: 10, marginVertical: 12 },
  statsTotal: { flex: 1, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, alignItems: "center" },
  statsTotalValue: { color: "#16A34A", fontSize: 22, fontWeight: "800" },
  statsTotalLabel: { color: "#6B7280", fontSize: 11, fontWeight: "700", marginTop: 2, letterSpacing: 0.5 },
  chart: { flexDirection: "row", alignItems: "flex-end", height: 140, gap: 3, marginTop: 8 },
  chartCol: { flex: 1, alignItems: "center" },
  chartBars: { height: 108, width: "100%", justifyContent: "flex-end", flexDirection: "column-reverse", gap: 1 },
  chartBar: { width: "100%", borderRadius: 2 },
  chartLabel: { color: "#6B7280", fontSize: 9, marginTop: 4 },
  chartLegend: { flexDirection: "row", justifyContent: "center", gap: 14, marginTop: 12, marginBottom: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: "#4B5563", fontSize: 11, fontWeight: "700" },
  rawRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#F3F4F6" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { width: "100%", maxWidth: 400, backgroundColor: "#fff", borderRadius: 20, padding: 20 },
  proofImage: { width: "100%", aspectRatio: 3 / 4, borderRadius: 14, marginTop: 12, backgroundColor: "#F3F4F6" },
  bellButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  bellBadge: { position: "absolute", top: 4, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: "#DC2626", paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#fff" },
  bellBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  notifCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 12, marginBottom: 8, borderRadius: 14, backgroundColor: "#F9FAFB", borderWidth: 1, borderColor: "#F3F4F6" },
  notifUnread: { backgroundColor: "#FEF2F2", borderColor: "#FCA5A5" },
  notifIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  notifDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#DC2626", marginTop: 6 },
});
