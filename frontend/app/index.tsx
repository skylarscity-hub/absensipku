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
import MapPicker from "@/src/components/MapPicker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

type User = { user_id: string; email: string; name: string; role: "employee" | "admin"; email_verified: boolean; full_name?: string | null; department?: string | null; profile_complete?: boolean; avatar?: string | null };
type Office = { office_id: string; office_name: string; latitude: number; longitude: number; radius_meters: number; active: boolean };
type Holiday = { holiday_id: string; date: string; label: string };
type Leave = { leave_id: string; user_id: string; user_name?: string; user_email?: string; department?: string; start_date: string; end_date: string; days: number; reason: string; status: "pending" | "approved" | "rejected"; created_at?: string };
type Dashboard = { user: User; settings: Office; offices: Office[]; schedule: { check_in: string; check_out: string; grace_minutes: number }; today?: { action?: string; created_at?: string }; holiday?: { label: string } | null; on_leave?: Leave | null };
type RecordItem = { attendance_id: string; date: string; action: string; distance_meters: number; verification: string; created_at: string; office_name?: string };
type AdminOverview = { settings: Office; offices: Office[]; schedule: Dashboard["schedule"]; requests: { request_id: string; name: string; email: string }[]; holidays: Holiday[] };
type LivenessSession = { liveness_session_id: string; steps: string[]; expires_in: number };
type ReportSummary = { user_id: string; name: string; email?: string; check_ins: number; check_outs: number; overtime_minutes?: number; last_action?: string; last_at?: string };
type ReportRow = { attendance_id: string; date: string; action: string; user_name?: string; user_email?: string; department?: string; distance_meters?: number; office_name?: string; created_at?: string; has_photo?: boolean };
type ReportPayload = { date_from: string; date_to: string; total_rows: number; summary: ReportSummary[]; rows: ReportRow[]; schedule?: { check_out: string; grace_minutes: number } };
type StatsDay = { date: string; on_time: number; late: number; on_leave: number; holiday: boolean };
type StatsPayload = { year: number; month: number; schedule: { check_in: string; grace_minutes: number }; totals: { on_time: number; late: number; on_leave: number; days_in_month: number }; days: StatsDay[] };

// Frontend contract: EXPO_PUBLIC_BACKEND_URL is supplied by frontend/.env.
const backendUrl = ((Constants.expoConfig?.extra as { backendUrl?: string } | undefined)?.backendUrl || process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
const tokenKey = "pkucity_session_token";
const usedSessionIds = new Set<string>();

const CHALLENGE_LABEL: Record<string, string> = {
  blink: "Blink twice",
  turn_left: "Turn head left",
  turn_right: "Turn head right",
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

function sessionIdFromUrl(url: string | null) {
  if (!url) return null;
  const match = url.match(/[?#&]session_id=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function apiUrl(path: string) { return `${backendUrl}/api${path}`; }

async function apiRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || "Something went wrong");
  return response.json();
}

async function apiRequestText(path: string, token: string): Promise<string> {
  const response = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || "Something went wrong");
  return response.text();
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <View style={compact ? styles.brandCompact : styles.brand}><View style={styles.brandIcon}><Ionicons name="shield-checkmark" size={compact ? 18 : 25} color="#fff" /></View><Text style={compact ? styles.brandTextCompact : styles.brandText}>pkucity</Text></View>;
}

function LoadingScreen() {
  return <View style={styles.loading}><BrandMark /><ActivityIndicator color="#DC2626" size="large" /><Text style={styles.actionCaption}>Securing your workspace…</Text></View>;
}

function AuthScreen({ onLogin, busy, error }: { onLogin: () => void; busy: boolean; error: string }) {
  return <View style={[styles.authRoot, { overflow: "hidden" }]}>
    <View style={styles.authTop}><View style={styles.redOrb} /><BrandMark /><Text style={styles.eyebrow}>ATTENDANCE, VERIFIED</Text><Text style={styles.authTitle}>Start your workday{`\n`}with confidence.</Text><Text style={styles.authBody}>A secure place to check in with your face and location verified.</Text></View>
    <View style={styles.authCard}>
      <View style={styles.secureRow}><Ionicons name="lock-closed" size={16} color="#16A34A" /><Text style={styles.secureText}>Protected by Google verification</Text></View>
      {!!error && <View style={styles.errorBanner}><Ionicons name="alert-circle" size={18} color="#B91C1C" /><Text style={styles.errorText}>{error}</Text></View>}
      <Pressable testID="google-login-button" accessibilityRole="button" onPress={onLogin} disabled={busy} style={({ pressed }) => [styles.googleButton, pressed && styles.pressed, busy && styles.disabled]}>
        {busy ? <ActivityIndicator color="#DC2626" /> : <><View style={styles.googleBadge}><Text style={styles.googleG}>G</Text></View><Text style={styles.googleButtonText}>Continue with Google</Text><Ionicons name="arrow-forward" size={18} color="#111827" /></>}
      </Pressable>
      <Text style={styles.legal}>By continuing, you agree to your organization’s attendance policy.</Text>
    </View>
  </View>;
}

function StatusPill({ label, tone = "success" }: { label: string; tone?: "success" | "warning" | "neutral" }) {
  return <View style={[styles.statusPill, tone === "warning" ? styles.warningPill : tone === "neutral" ? styles.neutralPill : styles.successPill]}><View style={[styles.pillDot, tone === "warning" ? styles.warningDot : tone === "neutral" ? styles.neutralDot : styles.successDot]} /><Text style={[styles.pillText, tone === "warning" ? styles.warningText : tone === "neutral" ? styles.neutralText : styles.successText]}>{label}</Text></View>;
}

function HomeScreen({ dashboard, onRefresh, onOpenCapture }: { dashboard: Dashboard | null; onRefresh: () => void; onOpenCapture: (action: "check_in" | "check_out") => void }) {
  const [locationState, setLocationState] = useState("Finding your location…");
  const [distance, setDistance] = useState<number | null>(null);
  const [locating, setLocating] = useState(true);
  const [nearestName, setNearestName] = useState<string>("");
  const insets = useSafeAreaInsets();
  const offices = useMemo(() => dashboard?.offices || (dashboard?.settings ? [dashboard.settings] : []), [dashboard]);
  const getLocation = useCallback(async () => {
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) { setLocationState("Location permission needed"); setDistance(null); return; }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!offices.length) { setLocationState("No office configured"); setDistance(null); return; }
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
        setLocationState(best.meters <= best.office.radius_meters ? "Inside attendance zone" : "Outside attendance zone");
      }
    } catch { setLocationState("Location unavailable"); setDistance(null); }
    finally { setLocating(false); }
  }, [offices]);
  useEffect(() => { getLocation(); }, [getLocation]);
  const completed = dashboard?.today?.action;
  const canCheckIn = !completed || completed === "check_out";
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
  const captureDisabled = !inRange || locating || !!onLeave;
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 32 }]} showsVerticalScrollIndicator={false}>
    <View style={styles.headerRow}><View><Text style={styles.greeting}>Good day</Text><Text style={styles.heading}>{dashboard?.user.name || "Your workspace"}</Text></View><View style={styles.avatar}><Text style={styles.avatarText}>{initials(dashboard?.user.name || "PK")}</Text></View></View>
    {!!onLeave && <View testID="on-leave-banner" style={styles.leaveBanner}><Ionicons name="airplane" size={18} color="#1D4ED8" /><Text style={styles.leaveText}>You are on approved leave until {onLeave.end_date}. Attendance is not required today.</Text></View>}
    {!!holiday && <View testID="holiday-banner" style={styles.holidayBanner}><Ionicons name="sparkles" size={18} color="#B45309" /><Text style={styles.holidayText}>Today is a holiday · {holiday.label}. Attendance is optional.</Text></View>}
    {lateMinutes > 0 && <View testID="late-banner" style={styles.lateBanner}><Ionicons name="time-outline" size={18} color="#B91C1C" /><Text style={styles.lateText}>You checked in {lateMinutes} min after the scheduled {scheduledCheckIn}. Try to arrive on time tomorrow.</Text></View>}
    <View style={styles.liveCard}><View style={styles.cardTop}><View><Text style={styles.cardKicker}>TODAY’S ATTENDANCE</Text><Text style={styles.cardTitle}>{completed ? `Checked ${completed === "check_in" ? "in" : "out"}` : "Ready when you are"}</Text></View><StatusPill label={completed ? "Recorded" : "Not started"} tone={completed ? "success" : "neutral"} /></View><View style={styles.rule} /><View style={styles.scheduleRow}><View><Text style={styles.miniLabel}>SHIFT</Text><Text style={styles.scheduleValue}>{dashboard?.schedule.check_in || "08:00"} — {dashboard?.schedule.check_out || "17:00"}</Text></View><View style={styles.scheduleDivider} /><View><Text style={styles.miniLabel}>NEAREST OFFICE</Text><Text style={styles.scheduleValue}>{nearestOffice?.office_name || "—"}</Text></View></View></View>
    <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Verification</Text><Pressable onPress={onRefresh} hitSlop={8}><Ionicons name="refresh" size={20} color="#DC2626" /></Pressable></View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="location" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>Office location</Text><Text style={styles.verifySub}>{locating ? locationState : distance === null ? locationState : `${distance}m away · ${locationState}`}</Text></View>{locating ? <ActivityIndicator color="#DC2626" /> : <Ionicons name={inRange ? "checkmark-circle" : "alert-circle"} size={22} color={inRange ? "#16A34A" : "#CA8A04"} />}</View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="videocam" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>Face liveness (video)</Text><Text style={styles.verifySub}>Record a short video and follow on-screen prompts</Text></View><Ionicons name="shield-checkmark-outline" size={22} color="#16A34A" /></View>
    <Text style={styles.helper}>You must be within {nearestOffice?.radius_meters || 100}m of an active office to record attendance.</Text>
    <View style={styles.actionArea}><Pressable testID="attendance-primary-button" onPress={() => onOpenCapture(canCheckIn ? "check_in" : "check_out")} disabled={captureDisabled} style={({ pressed }) => [styles.primaryButton, (pressed && styles.pressed), captureDisabled && styles.disabled]}><Ionicons name={canCheckIn ? "log-in-outline" : "log-out-outline"} size={22} color="#fff" /><Text style={styles.primaryButtonText}>{canCheckIn ? "Check in now" : "Check out now"}</Text></Pressable><Text style={styles.actionCaption}>{onLeave ? "You're on leave, no attendance needed" : !inRange ? "Waiting for a valid office location" : "Camera video and location will be checked"}</Text></View>
  </ScrollView>;
}

function CaptureScreen({ action, token, onDone, onCancel }: { action: "check_in" | "check_out"; token: string; onDone: (message: string) => void; onCancel: () => void }) {
  const cameraRef = useRef<Camera.CameraView>(null);
  const [cameraPermission, requestCamera] = Camera.useCameraPermissions();
  const [liveness, setLiveness] = useState<LivenessSession | null>(null);
  const [step, setStep] = useState<"ready" | "recording" | "verifying">("ready");
  const [notice, setNotice] = useState("");
  const [activeStepIndex, setActiveStepIndex] = useState(-1);
  const insets = useSafeAreaInsets();
  const issueLivenessSession = useCallback(async () => {
    try {
      setLiveness(null);
      setActiveStepIndex(-1);
      const session = await apiRequest<LivenessSession>("/liveness/session", token, { method: "POST" });
      setLiveness(session);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start liveness verification.");
    }
  }, [token]);
  useEffect(() => { if (cameraPermission?.granted && Platform.OS !== "web") issueLivenessSession(); }, [cameraPermission?.granted, issueLivenessSession]);
  const capture = async () => {
    if (!cameraRef.current || !liveness) return;
    setStep("recording");
    setNotice("Recording started. Follow the prompt highlighted below.");
    // Animate the prompt sequence: ~2s per challenge
    let stepTimer: ReturnType<typeof setInterval> | null = null;
    setActiveStepIndex(0);
    let idx = 0;
    stepTimer = setInterval(() => {
      idx += 1;
      if (idx < liveness.steps.length) setActiveStepIndex(idx);
      else if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    }, 2200);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: Math.max(8, liveness.steps.length * 2.5), maxFileSize: 12_000_000 });
      if (stepTimer) clearInterval(stepTimer);
      if (!video?.uri) throw new Error("No liveness video was recorded.");
      setStep("verifying"); setNotice("Analyzing your video…");
      const form = new FormData();
      form.append("liveness_session_id", liveness.liveness_session_id);
      form.append("video", { uri: video.uri, name: "pkucity-liveness.mp4", type: "video/mp4" } as any);
      const verificationResponse = await fetch(apiUrl("/liveness/verify"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const verification = await verificationResponse.json().catch(() => ({}));
      if (!verificationResponse.ok || !verification.passed) throw new Error(verification.detail || "Liveness challenge failed. Please try again.");
      setNotice("Liveness passed. Checking your location…");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const result = await apiRequest<{ accepted: boolean; message: string }>("/attendance", token, { method: "POST", body: JSON.stringify({ action, latitude: position.coords.latitude, longitude: position.coords.longitude, liveness_session_id: liveness.liveness_session_id }) });
      if (!result.accepted) throw new Error(result.message);
      onDone(result.message);
    } catch (error) {
      if (stepTimer) clearInterval(stepTimer);
      setStep("ready");
      setActiveStepIndex(-1);
      setNotice(error instanceof Error ? error.message : "Verification failed. Please try again.");
      await issueLivenessSession();
    }
  };
  const stopRecording = () => {
    if (cameraRef.current) cameraRef.current.stopRecording();
  };
  if (Platform.OS === "web") return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><Pressable onPress={onCancel} style={styles.backButton}><Ionicons name="arrow-back" size={22} color="#111827" /></Pressable><BrandMark compact /><View style={styles.permissionState}><View style={styles.bigIcon}><Ionicons name="phone-portrait-outline" size={32} color="#DC2626" /></View><Text style={styles.captureTitle}>Use a real device</Text><Text style={styles.captureBody}>Secure video liveness requires the native front camera on iOS or Android.</Text></View></View>;
  if (!cameraPermission?.granted) return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><Pressable onPress={onCancel} style={styles.backButton}><Ionicons name="arrow-back" size={22} color="#111827" /></Pressable><BrandMark compact /><View style={styles.permissionState}><View style={styles.bigIcon}><Ionicons name="camera" size={32} color="#DC2626" /></View><Text style={styles.captureTitle}>Camera access needed</Text><Text style={styles.captureBody}>PKUCity records a short challenge video and verifies it on the server.</Text><Pressable testID="camera-permission-button" onPress={requestCamera} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Allow camera</Text></Pressable></View></View>;
  if (!liveness) return <View style={[styles.captureRoot, { paddingTop: insets.top + 18 }]}><BrandMark compact /><View style={styles.permissionState}><ActivityIndicator color="#DC2626" size="large" /><Text style={styles.captureTitle}>Preparing secure check</Text><Text style={styles.captureBody}>{notice || "Creating a one-time liveness challenge…"}</Text></View></View>;
  const isRecording = step === "recording";
  const isVerifying = step === "verifying";
  return <View style={styles.captureRoot}><View style={styles.cameraFrame}><Camera.CameraView ref={cameraRef} facing="front" mode="video" style={StyleSheet.absoluteFill} /><View style={styles.cameraShade} />
    <View style={[styles.captureTop, { paddingTop: insets.top + 16 }]}>
      <Pressable onPress={onCancel} style={styles.cameraBack}><Ionicons name="close" size={24} color="#fff" /></Pressable>
      <Text style={styles.cameraTitle}>{action === "check_in" ? "Check in" : "Check out"}</Text>
      {isRecording ? <View style={styles.recordingBadge}><View style={styles.recordingDot} /><Text style={styles.recordingText}>REC</Text></View> : <View style={styles.cameraBack} />}
    </View>
    <View style={styles.faceGuide}><View style={styles.faceCornerTL} /><View style={styles.faceCornerTR} /><View style={styles.faceCornerBL} /><View style={styles.faceCornerBR} /></View>
    <View style={[styles.captureBottom, { paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.stepsRow}>
        {liveness.steps.map((stepKey, index) => (
          <View key={`${stepKey}-${index}`} testID={`liveness-step-${index}`} style={[styles.stepPill, activeStepIndex === index && styles.stepPillActive, activeStepIndex > index && styles.stepPillDone]}>
            <Text style={styles.stepIndex}>{index + 1}</Text>
            <Text style={styles.stepLabel}>{CHALLENGE_LABEL[stepKey] || stepKey}</Text>
          </View>
        ))}
      </View>
      <Text testID="capture-instruction" style={styles.captureInstruction}>
        {step === "ready" && "Tap Record and follow each prompt for ~2 seconds."}
        {isRecording && activeStepIndex >= 0 && `Now: ${CHALLENGE_LABEL[liveness.steps[activeStepIndex]] || liveness.steps[activeStepIndex]}`}
        {isVerifying && (notice || "Analyzing your video…")}
      </Text>
      {step === "ready" && !!notice && <Text style={styles.captureNoticeError}>{notice}</Text>}
      {step === "ready" ? (
        <Pressable testID="camera-shutter-button" onPress={capture} style={({ pressed }) => [styles.shutter, pressed && styles.pressed]}>
          <View style={styles.shutterInner} />
        </Pressable>
      ) : isRecording ? (
        <Pressable testID="camera-stop-button" onPress={stopRecording} style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}>
          <View style={styles.stopIcon} />
        </Pressable>
      ) : (
        <View style={styles.shutter}><ActivityIndicator color="#DC2626" /></View>
      )}
    </View>
  </View></View>;
}

function HistoryScreen({ records, loading }: { records: RecordItem[]; loading: boolean }) {
  const insets = useSafeAreaInsets();
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]}><Text style={styles.heading}>Attendance history</Text><Text style={styles.subheading}>Your verified attendance records</Text>{loading ? <ActivityIndicator color="#DC2626" style={{ marginTop: 42 }} /> : records.length === 0 ? <View style={styles.empty}><Ionicons name="calendar-outline" size={35} color="#DC2626" /><Text style={styles.emptyTitle}>No records yet</Text><Text style={styles.emptyBody}>Your successful check-ins and check-outs will appear here.</Text></View> : records.map((record) => <View style={styles.historyCard} key={record.attendance_id}><View style={styles.historyIcon}><Ionicons name={record.action === "check_in" ? "log-in-outline" : "log-out-outline"} size={20} color="#DC2626" /></View><View style={styles.historyCopy}><Text style={styles.historyDate}>{record.date}</Text><Text style={styles.historyTime}>{record.action === "check_in" ? "Check in" : "Check out"} · {new Date(record.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{record.office_name ? ` · ${record.office_name}` : ""}</Text></View><View style={styles.historyRight}><StatusPill label="Verified" /><Text style={styles.distance}>{record.distance_meters}m away</Text></View></View>)}</ScrollView>;
}

// ------------------ Onboarding --------------------------------------------------

function OnboardingScreen({ user, token, onDone }: { user: User; token: string; onDone: (updated: User) => void }) {
  const insets = useSafeAreaInsets();
  const [fullName, setFullName] = useState(user.full_name || user.name || "");
  const [department, setDepartment] = useState(user.department || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!fullName.trim() || !department.trim()) { setError("Please fill both fields."); return; }
    setSaving(true); setError("");
    try {
      const updated = await apiRequest<User>("/profile", token, { method: "PATCH", body: JSON.stringify({ full_name: fullName.trim(), department: department.trim() }) });
      onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile");
    } finally { setSaving(false); }
  };
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
      <BrandMark />
      <Text style={[styles.eyebrow, { marginTop: 30 }]}>WELCOME TO PKUCITY</Text>
      <Text style={styles.heading}>Complete your profile</Text>
      <Text style={styles.subheading}>Tell us your full name and job department so attendance records show the right details.</Text>
      <View style={styles.formCard}>
        <Field label="Full name" value={fullName} onChangeText={setFullName} />
        <Field label="Department / job area" value={department} onChangeText={setDepartment} />
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

type AdminTab = "access" | "offices" | "users" | "leaves" | "holidays" | "schedule" | "stats" | "reports";

function AdminScreen({ token }: { token: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tab, setTab] = useState<AdminTab>("access");
  const [message, setMessage] = useState("");
  const insets = useSafeAreaInsets();
  const load = useCallback(async () => {
    try {
      const data = await apiRequest<AdminOverview>("/admin/overview", token);
      setOverview(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load admin tools");
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  const approve = async (id: string) => {
    try { await apiRequest(`/admin/requests/${id}/approve`, token, { method: "POST" }); setMessage("Admin request approved."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not approve request"); }
  };
  const tabs: [AdminTab, string][] = [["access", "Access"], ["offices", "Offices"], ["users", "Users"], ["leaves", "Leaves"], ["schedule", "Schedule"], ["holidays", "Holidays"], ["stats", "Stats"], ["reports", "Reports"]];
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]}>
      <Text style={styles.heading}>Admin controls</Text>
      <Text style={styles.subheading}>Keep PKUCity attendance rules accurate.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
        {tabs.map(([key, label]) => (
          <Pressable testID={`admin-tab-${key}`} key={key} onPress={() => { setTab(key); setMessage(""); }} style={[styles.segmentChip, tab === key && styles.segmentChipActive]}>
            <Text style={[styles.segmentText, tab === key && styles.segmentTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {!!message && <View style={styles.successBanner}><Ionicons name="information-circle" size={18} color="#15803D" /><Text style={styles.successBannerText}>{message}</Text></View>}
      {tab === "access" && <AccessTab overview={overview} onApprove={approve} />}
      {tab === "offices" && <OfficesTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "users" && <UsersTab token={token} onMessage={setMessage} />}
      {tab === "leaves" && <LeavesAdminTab token={token} onMessage={setMessage} />}
      {tab === "schedule" && <ScheduleTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "holidays" && <HolidaysTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "stats" && <StatsTab token={token} />}
      {tab === "reports" && <ReportsTab token={token} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}

function AccessTab({ overview, onApprove }: { overview: AdminOverview | null; onApprove: (id: string) => void }) {
  if (!overview) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  if (!overview.requests.length) {
    return <View style={styles.emptySmall}><Ionicons name="checkmark-done" size={25} color="#16A34A" /><Text style={styles.emptyTitle}>All caught up</Text><Text style={styles.emptyBody}>No pending admin access requests.</Text></View>;
  }
  return <View>{overview.requests.map((item) => (
    <View style={styles.requestCard} key={item.request_id}>
      <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(item.name)}</Text></View>
      <View style={styles.requestCopy}><Text style={styles.verifyTitle}>{item.name}</Text><Text style={styles.verifySub}>{item.email}</Text></View>
      <Pressable testID={`approve-${item.request_id}`} onPress={() => onApprove(item.request_id)} style={styles.approve}><Text style={styles.approveText}>Approve</Text></Pressable>
    </View>
  ))}</View>;
}

function OfficesTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [form, setForm] = useState({ office_name: "", latitude: "", longitude: "", radius_meters: "100" });
  const [busyId, setBusyId] = useState<string | null>(null);
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
      onMessage(error instanceof Error ? error.message : "Could not add office");
    } finally { setBusyId(null); }
  };
  const toggleActive = async (office: Office) => {
    setBusyId(office.office_id);
    try { await apiRequest(`/admin/offices/${office.office_id}`, token, { method: "PATCH", body: JSON.stringify({ active: !office.active }) }); onMessage(`Office "${office.office_name}" ${office.active ? "deactivated" : "activated"}.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Could not update office"); }
    finally { setBusyId(null); }
  };
  const remove = async (office: Office) => {
    setBusyId(office.office_id);
    try { await apiRequest(`/admin/offices/${office.office_id}`, token, { method: "DELETE" }); onMessage(`Office "${office.office_name}" deleted.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Could not delete office"); }
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
            <Text style={[styles.activeBadgeText, office.active ? styles.activeBadgeTextOn : styles.activeBadgeTextOff]}>{office.active ? "ACTIVE" : "OFF"}</Text>
          </View>
        </View>
        <View style={styles.officeActions}>
          <Pressable testID={`office-toggle-${office.office_id}`} onPress={() => toggleActive(office)} disabled={busyId === office.office_id} style={styles.outlineButton}>
            {busyId === office.office_id ? <ActivityIndicator color="#DC2626" /> : <><Ionicons name={office.active ? "pause" : "play"} size={16} color="#DC2626" /><Text style={styles.outlineText}>{office.active ? "Deactivate" : "Activate"}</Text></>}
          </Pressable>
          <Pressable testID={`office-delete-${office.office_id}`} onPress={() => remove(office)} disabled={busyId === office.office_id} style={[styles.outlineButton, styles.dangerOutline]}>
            <Ionicons name="trash-outline" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Delete</Text>
          </Pressable>
        </View>
      </View>
    ))}
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Add another office</Text>
      <Text style={styles.formHint}>Tap the map to drop the pin or type coordinates below.</Text>
      <MapPicker
        latitude={form.latitude ? Number(form.latitude) : null}
        longitude={form.longitude ? Number(form.longitude) : null}
        radius={Number(form.radius_meters) || 100}
        onChange={(lat, lng) => setForm((prev) => ({ ...prev, latitude: lat.toFixed(6), longitude: lng.toFixed(6) }))}
      />
      <Field label="Office name" value={form.office_name} onChangeText={(v) => setForm({ ...form, office_name: v })} />
      <Field label="Latitude" value={form.latitude} onChangeText={(v) => setForm({ ...form, latitude: v })} keyboardType="numeric" />
      <Field label="Longitude" value={form.longitude} onChangeText={(v) => setForm({ ...form, longitude: v })} keyboardType="numeric" />
      <Field label="Radius (meters)" value={form.radius_meters} onChangeText={(v) => setForm({ ...form, radius_meters: v })} keyboardType="numeric" />
      <Pressable testID="add-office-button" onPress={submit} disabled={busyId === "new" || !form.office_name || !form.latitude || !form.longitude} style={[styles.primaryButton, (!form.office_name || !form.latitude || !form.longitude) && styles.disabled]}>
        {busyId === "new" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add" size={20} color="#fff" /><Text style={styles.primaryButtonText}>Add office</Text></>}
      </Pressable>
    </View>
  </View>;
}

function ScheduleTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [schedule, setSchedule] = useState({ check_in: "", check_out: "", grace_minutes: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (overview?.schedule) setSchedule({ check_in: overview.schedule.check_in, check_out: overview.schedule.check_out, grace_minutes: String(overview.schedule.grace_minutes) });
  }, [overview?.schedule]);
  const save = async () => {
    setSaving(true);
    try { await apiRequest("/admin/schedule", token, { method: "PATCH", body: JSON.stringify({ check_in: schedule.check_in, check_out: schedule.check_out, grace_minutes: Number(schedule.grace_minutes) }) }); onMessage("Weekly schedule updated."); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Could not save schedule"); }
    finally { setSaving(false); }
  };
  return <View style={styles.formCard}>
    <Text style={styles.formTitle}>Weekly schedule</Text>
    <Text style={styles.formHint}>Applies to every employee. Use HH:MM format.</Text>
    <Field label="Check-in" value={schedule.check_in} onChangeText={(v) => setSchedule({ ...schedule, check_in: v })} />
    <Field label="Check-out" value={schedule.check_out} onChangeText={(v) => setSchedule({ ...schedule, check_out: v })} />
    <Field label="Grace period (minutes)" value={schedule.grace_minutes} onChangeText={(v) => setSchedule({ ...schedule, grace_minutes: v })} keyboardType="numeric" />
    <Pressable testID="save-schedule-button" onPress={save} disabled={saving} style={styles.primaryButton}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Save weekly schedule</Text>}</Pressable>
  </View>;
}

function HolidaysTab({ token, overview, onChange, onMessage }: { token: string; overview: AdminOverview | null; onChange: () => Promise<void>; onMessage: (msg: string) => void }) {
  const [form, setForm] = useState({ date: "", label: "" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const add = async () => {
    setBusyId("new");
    try { await apiRequest("/admin/holidays", token, { method: "POST", body: JSON.stringify(form) }); onMessage(`Holiday "${form.label}" added.`); setForm({ date: "", label: "" }); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Could not add holiday"); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string, label: string) => {
    setBusyId(id);
    try { await apiRequest(`/admin/holidays/${id}`, token, { method: "DELETE" }); onMessage(`Holiday "${label}" removed.`); await onChange(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "Could not delete holiday"); }
    finally { setBusyId(null); }
  };
  const holidays = overview?.holidays || [];
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Add holiday</Text>
      <Text style={styles.formHint}>On these dates, check-in is optional and skipped by policy.</Text>
      <Field label="Date (YYYY-MM-DD)" value={form.date} onChangeText={(v) => setForm({ ...form, date: v })} />
      <Field label="Label (e.g. New Year)" value={form.label} onChangeText={(v) => setForm({ ...form, label: v })} />
      <Pressable testID="add-holiday-button" onPress={add} disabled={busyId === "new" || !form.date || !form.label} style={[styles.primaryButton, (!form.date || !form.label) && styles.disabled]}>
        {busyId === "new" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="calendar" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Add holiday</Text></>}
      </Pressable>
    </View>
    {holidays.length === 0 ? (
      <View style={styles.emptySmall}><Ionicons name="calendar-clear-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No holidays yet</Text><Text style={styles.emptyBody}>Add dates the team should be excused from attendance.</Text></View>
    ) : holidays.map((holiday) => (
      <View testID={`holiday-card-${holiday.holiday_id}`} style={styles.requestCard} key={holiday.holiday_id}>
        <View style={styles.holidayIcon}><Ionicons name="sparkles" size={18} color="#B45309" /></View>
        <View style={styles.requestCopy}>
          <Text style={styles.verifyTitle}>{holiday.label}</Text>
          <Text style={styles.verifySub}>{holiday.date}</Text>
        </View>
        <Pressable testID={`holiday-delete-${holiday.holiday_id}`} onPress={() => remove(holiday.holiday_id, holiday.label)} disabled={busyId === holiday.holiday_id} style={[styles.approve, styles.dangerButton]}>
          {busyId === holiday.holiday_id ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Remove</Text>}
        </Pressable>
      </View>
    ))}
  </View>;
}

function UsersTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Record<string, { full_name: string; department: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<User[]>("/admin/users", token);
      setUsers(data);
    } catch (err) { onMessage(err instanceof Error ? err.message : "Could not load users"); }
    finally { setLoading(false); }
  }, [token, onMessage]);
  useEffect(() => { load(); }, [load]);
  const startEdit = (u: User) => setEditing((prev) => ({ ...prev, [u.user_id]: { full_name: u.full_name || u.name || "", department: u.department || "" } }));
  const cancelEdit = (id: string) => setEditing((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const save = async (u: User) => {
    const draft = editing[u.user_id];
    if (!draft || !draft.full_name.trim() || !draft.department.trim()) { onMessage("Both fields are required"); return; }
    setBusyId(u.user_id);
    try {
      await apiRequest(`/admin/users/${u.user_id}`, token, { method: "PATCH", body: JSON.stringify({ full_name: draft.full_name.trim(), department: draft.department.trim() }) });
      onMessage(`Updated ${draft.full_name.trim()}`);
      cancelEdit(u.user_id);
      await load();
    } catch (err) { onMessage(err instanceof Error ? err.message : "Could not save user"); }
    finally { setBusyId(null); }
  };
  if (loading && !users.length) return <ActivityIndicator color="#DC2626" style={{ marginTop: 24 }} />;
  if (!users.length) return <View style={styles.emptySmall}><Ionicons name="people-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No users yet</Text><Text style={styles.emptyBody}>Users appear after their first Google sign-in.</Text></View>;
  return <View>{users.map((u) => {
    const draft = editing[u.user_id];
    if (draft) {
      return <View testID={`user-edit-${u.user_id}`} style={styles.formCard} key={u.user_id}>
        <Text style={styles.formTitle}>{u.email}</Text>
        <Text style={styles.formHint}>{u.role === "admin" ? "Administrator" : "Employee"}{u.profile_complete ? "" : " · profile pending"}</Text>
        <Field label="Full name" value={draft.full_name} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, full_name: v } }))} />
        <Field label="Department / job area" value={draft.department} onChangeText={(v) => setEditing((prev) => ({ ...prev, [u.user_id]: { ...draft, department: v } }))} />
        <View style={styles.officeActions}>
          <Pressable testID={`user-cancel-${u.user_id}`} onPress={() => cancelEdit(u.user_id)} style={[styles.outlineButton, { flex: 1 }]}><Text style={styles.outlineText}>Cancel</Text></Pressable>
          <Pressable testID={`user-save-${u.user_id}`} onPress={() => save(u)} disabled={busyId === u.user_id} style={[styles.primaryButton, { flex: 1 }]}>
            {busyId === u.user_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Save</Text></>}
          </Pressable>
        </View>
      </View>;
    }
    return <View testID={`user-card-${u.user_id}`} style={styles.requestCard} key={u.user_id}>
      <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(u.full_name || u.name)}</Text></View>
      <View style={styles.requestCopy}>
        <Text style={styles.verifyTitle}>{u.full_name || u.name}</Text>
        <Text style={styles.verifySub}>{u.department || (u.profile_complete ? "—" : "Profile pending")} · {u.email}</Text>
      </View>
      <Pressable testID={`user-edit-btn-${u.user_id}`} onPress={() => startEdit(u)} style={styles.approve}><Text style={styles.approveText}>Edit</Text></Pressable>
    </View>;
  })}</View>;
}

function LeavesAdminTab({ token, onMessage }: { token: string; onMessage: (msg: string) => void }) {
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected">("pending");
  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await apiRequest<Leave[]>(`/admin/leaves?status=${filter}`, token); setLeaves(data); }
    catch (err) { onMessage(err instanceof Error ? err.message : "Could not load leaves"); }
    finally { setLoading(false); }
  }, [token, filter, onMessage]);
  useEffect(() => { load(); }, [load]);
  const resolve = async (leaveId: string, action: "approve" | "reject") => {
    setBusyId(leaveId);
    try { await apiRequest(`/admin/leaves/${leaveId}/${action}`, token, { method: "POST" }); onMessage(`Leave ${action}d.`); await load(); }
    catch (err) { onMessage(err instanceof Error ? err.message : `Could not ${action} leave`); }
    finally { setBusyId(null); }
  };
  const filters: ("pending" | "approved" | "rejected")[] = ["pending", "approved", "rejected"];
  return <View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentedScroll}>
      {filters.map((f) => (
        <Pressable testID={`leave-filter-${f}`} key={f} onPress={() => setFilter(f)} style={[styles.segmentChip, filter === f && styles.segmentChipActive]}>
          <Text style={[styles.segmentText, filter === f && styles.segmentTextActive]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
        </Pressable>
      ))}
    </ScrollView>
    {loading && <ActivityIndicator color="#DC2626" style={{ marginTop: 16 }} />}
    {!loading && leaves.length === 0 && (
      <View style={styles.emptySmall}><Ionicons name="airplane-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No {filter} leaves</Text><Text style={styles.emptyBody}>Requests appear here as employees submit them.</Text></View>
    )}
    {leaves.map((leave) => (
      <View testID={`admin-leave-${leave.leave_id}`} style={styles.formCard} key={leave.leave_id}>
        <Text style={styles.formTitle}>{leave.user_name || leave.user_email}</Text>
        <Text style={styles.formHint}>{leave.department || "—"} · {leave.start_date} → {leave.end_date} · {leave.days} day(s)</Text>
        <Text style={[styles.verifySub, { marginBottom: 8 }]}>{leave.reason}</Text>
        {leave.status === "pending" ? (
          <View style={styles.officeActions}>
            <Pressable testID={`leave-approve-${leave.leave_id}`} onPress={() => resolve(leave.leave_id, "approve")} disabled={busyId === leave.leave_id} style={[styles.primaryButton, { flex: 1 }]}>
              {busyId === leave.leave_id ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Approve</Text></>}
            </Pressable>
            <Pressable testID={`leave-reject-${leave.leave_id}`} onPress={() => resolve(leave.leave_id, "reject")} disabled={busyId === leave.leave_id} style={[styles.outlineButton, styles.dangerOutline, { flex: 1 }]}>
              <Ionicons name="close" size={16} color="#B91C1C" /><Text style={[styles.outlineText, { color: "#B91C1C" }]}>Reject</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.leaveStatus, leave.status === "approved" ? styles.statusApproved : styles.statusRejected]}>
            <Text style={[styles.leaveStatusText, leave.status === "approved" ? { color: "#15803D" } : { color: "#991B1B" }]}>{leave.status.toUpperCase()}</Text>
          </View>
        )}
      </View>
    ))}
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
          <Text style={styles.formHint}>On-time vs late per day</Text>
        </View>
        <Pressable testID="stats-next-button" onPress={() => step(1)} style={styles.outlineButton}><Ionicons name="chevron-forward" size={16} color="#DC2626" /></Pressable>
      </View>
      {loading ? <ActivityIndicator color="#DC2626" style={{ marginTop: 16 }} /> : stats && <>
        <View style={styles.statsTotalsRow}>
          <View style={styles.statsTotal}><Text style={styles.statsTotalValue}>{stats.totals.on_time}</Text><Text style={styles.statsTotalLabel}>On time</Text></View>
          <View style={styles.statsTotal}><Text style={[styles.statsTotalValue, { color: "#B91C1C" }]}>{stats.totals.late}</Text><Text style={styles.statsTotalLabel}>Late</Text></View>
          <View style={styles.statsTotal}><Text style={[styles.statsTotalValue, { color: "#1D4ED8" }]}>{stats.totals.on_leave}</Text><Text style={styles.statsTotalLabel}>Leave</Text></View>
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
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#16A34A" }]} /><Text style={styles.legendText}>On time</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#DC2626" }]} /><Text style={styles.legendText}>Late</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#3B82F6" }]} /><Text style={styles.legendText}>On leave</Text></View>
        </View>
        <Text style={styles.formHint}>Grace period: check-in until {stats.schedule.check_in} (+{stats.schedule.grace_minutes}m) is on time.</Text>
      </>}
    </View>
  </View>;
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
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await apiRequest<ReportPayload>(`/admin/reports?date_from=${dateFrom}&date_to=${dateTo}`, token);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load report");
    } finally { setLoading(false); }
  }, [token, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);
  const shareCsv = async () => {
    try {
      const csv = await apiRequestText(`/admin/reports/export?date_from=${dateFrom}&date_to=${dateTo}`, token);
      await Share.share({ title: `PKUCity attendance ${dateFrom} to ${dateTo}`, message: csv });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share CSV");
    }
  };
  const sharePdf = async () => {
    try {
      setError("");
      if (Platform.OS === "web") {
        // Web: download via fetch + blob URL.
        const response = await fetch(apiUrl(`/admin/reports/export.pdf?date_from=${dateFrom}&date_to=${dateTo}`), { headers: { Authorization: `Bearer ${token}` } });
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
      const download = await FileSystem.downloadAsync(apiUrl(`/admin/reports/export.pdf?date_from=${dateFrom}&date_to=${dateTo}`), target, { headers: { Authorization: `Bearer ${token}` } });
      if (download.status !== 200) throw new Error("Could not build PDF");
      const available = await Sharing.isAvailableAsync();
      if (!available) { setError("Sharing is not available on this device."); return; }
      await Sharing.shareAsync(download.uri, { mimeType: "application/pdf", dialogTitle: `PKUCity attendance ${dateFrom} → ${dateTo}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share PDF");
    }
  };
  return <View>
    <View style={styles.formCard}>
      <Text style={styles.formTitle}>Attendance report</Text>
      <Text style={styles.formHint}>Range summarizes verified check-ins & check-outs.</Text>
      <Field label="From (YYYY-MM-DD)" value={dateFrom} onChangeText={setDateFrom} />
      <Field label="To (YYYY-MM-DD)" value={dateTo} onChangeText={setDateTo} />
      <View style={styles.officeActions}>
        <Pressable testID="report-refresh-button" onPress={load} disabled={loading} style={[styles.outlineButton, { flex: 1 }]}>
          {loading ? <ActivityIndicator color="#DC2626" /> : <><Ionicons name="refresh" size={16} color="#DC2626" /><Text style={styles.outlineText}>Refresh</Text></>}
        </Pressable>
        <Pressable testID="report-share-csv-button" onPress={shareCsv} disabled={loading} style={[styles.primaryButton, { flex: 1 }]}>
          <Ionicons name="share-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Share CSV</Text>
        </Pressable>
      </View>
      <Pressable testID="report-share-pdf-button" onPress={sharePdf} disabled={loading} style={[styles.primaryButton, { marginTop: 10 }]}>
        <Ionicons name="document-text-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Share monthly PDF</Text>
      </Pressable>
      {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
      {report && <Text style={styles.formHint}>{report.total_rows} records · {report.summary.length} employees · overtime after {report.schedule?.check_out || "17:00"} (+{report.schedule?.grace_minutes ?? 0}m grace)</Text>}
    </View>
    {(report?.summary || []).map((summary) => (
      <View testID={`report-row-${summary.user_id}`} style={styles.requestCard} key={summary.user_id}>
        <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(summary.name)}</Text></View>
        <View style={styles.requestCopy}>
          <Text style={styles.verifyTitle}>{summary.name}</Text>
          <Text style={styles.verifySub}>{summary.email || summary.user_id}</Text>
          {(summary.overtime_minutes ?? 0) > 0 && <Text testID={`overtime-${summary.user_id}`} style={styles.overtimeText}>+{Math.floor((summary.overtime_minutes || 0) / 60)}h {(summary.overtime_minutes || 0) % 60}m overtime</Text>}
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.reportMetric}>{summary.check_ins} in</Text>
          <Text style={styles.reportMetricMuted}>{summary.check_outs} out</Text>
        </View>
      </View>
    ))}
    {report && report.rows.length > 0 && (
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>All records ({report.rows.length})</Text>
        <Text style={styles.formHint}>Tap any row to see the face proof photo captured at check-in.</Text>
        {report.rows.slice(0, 50).map((row) => (
          <Pressable
            testID={`report-raw-${row.attendance_id}`}
            key={row.attendance_id}
            onPress={async () => {
              if (!row.has_photo) return;
              setPhotoRow(row); setPhotoUri(""); setPhotoLoading(true);
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
              } finally { setPhotoLoading(false); }
            }}
            style={styles.rawRow}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.verifyTitle}>{row.user_name || row.user_email || "—"}</Text>
              <Text style={styles.verifySub}>{row.date} · {row.action === "check_in" ? "Check in" : "Check out"} · {row.office_name || "—"}</Text>
            </View>
            {row.has_photo ? <Ionicons name="image-outline" size={22} color="#DC2626" /> : <Ionicons name="image-outline" size={22} color="#D1D5DB" />}
          </Pressable>
        ))}
      </View>
    )}
    <Modal visible={!!photoRow} transparent animationType="fade" onRequestClose={() => setPhotoRow(null)}>
      <Pressable testID="photo-modal-backdrop" onPress={() => setPhotoRow(null)} style={styles.modalBackdrop}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.formTitle}>Face proof</Text>
          <Text style={styles.formHint}>{photoRow?.user_name} · {photoRow?.date} · {photoRow?.action === "check_in" ? "Check in" : "Check out"}</Text>
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
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [leaveForm, setLeaveForm] = useState({ start_date: "", end_date: "", reason: "" });
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const request = async () => {
    try { const data = await apiRequest<{ message: string }>("/admin/request", token, { method: "POST" }); setRequestState(data.message); onRequestAdmin(); }
    catch (error) { setRequestState(error instanceof Error ? error.message : "Could not send request"); }
  };
  const loadLeaves = useCallback(async () => {
    try { const data = await apiRequest<Leave[]>("/leaves", token); setLeaves(data); } catch {}
  }, [token]);
  useEffect(() => { loadLeaves(); }, [loadLeaves]);
  const pickAvatar = async () => {
    setAvatarBusy(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { setRequestState("Photo library permission denied"); return; }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.5,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const dataUrl = `data:image/jpeg;base64,${result.assets[0].base64}`;
      const updated = await apiRequest<User>("/profile/avatar", token, { method: "PATCH", body: JSON.stringify({ image_base64: dataUrl }) });
      onUserChange(updated);
      setRequestState("Profile photo updated.");
    } catch (err) {
      setRequestState(err instanceof Error ? err.message : "Could not update photo");
    } finally { setAvatarBusy(false); }
  };
  const submitLeave = async () => {
    if (!leaveForm.start_date || !leaveForm.end_date || !leaveForm.reason) { setLeaveError("All fields are required"); return; }
    setLeaveBusy(true); setLeaveError("");
    try {
      await apiRequest("/leaves", token, { method: "POST", body: JSON.stringify(leaveForm) });
      setLeaveForm({ start_date: "", end_date: "", reason: "" });
      setShowLeaveForm(false);
      await loadLeaves();
    } catch (err) { setLeaveError(err instanceof Error ? err.message : "Could not submit leave"); }
    finally { setLeaveBusy(false); }
  };
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
    <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Profile</Text>
      <Text style={styles.subheading}>Your verified PKUCity account</Text>
      <View style={styles.profileCard}>
        <Pressable testID="avatar-change-button" onPress={pickAvatar} disabled={avatarBusy} style={{ marginBottom: 15 }}>
          <AvatarView user={user} size={92} />
          <View style={styles.avatarEdit}>{avatarBusy ? <ActivityIndicator color="#fff" /> : <Ionicons name="camera" size={16} color="#fff" />}</View>
        </Pressable>
        <Text style={styles.profileName}>{user.full_name || user.name}</Text>
        <Text style={styles.profileEmail}>{user.email}</Text>
        {!!user.department && <Text style={styles.profileEmail}>{user.department}</Text>}
        <View style={styles.verifiedLabel}><Ionicons name="checkmark-circle" size={17} color="#16A34A" /><Text style={styles.verifiedText}>Google account verified</Text></View>
        <View style={styles.roleBadge}><Text style={styles.roleText}>{user.role === "admin" ? "ADMIN" : "EMPLOYEE"}</Text></View>
      </View>
      {/* Leaves */}
      <View style={styles.profileAction}>
        <View style={styles.officeRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.formTitle}>My leave requests</Text>
            <Text style={styles.formHint}>Approved leaves excuse attendance for those dates.</Text>
          </View>
          <Pressable testID="leave-new-button" onPress={() => setShowLeaveForm((s) => !s)} style={styles.approve}><Text style={styles.approveText}>{showLeaveForm ? "Close" : "New"}</Text></Pressable>
        </View>
        {showLeaveForm && <View style={{ marginTop: 10 }}>
          <Field label="Start date (YYYY-MM-DD)" value={leaveForm.start_date} onChangeText={(v) => setLeaveForm({ ...leaveForm, start_date: v })} />
          <Field label="End date (YYYY-MM-DD)" value={leaveForm.end_date} onChangeText={(v) => setLeaveForm({ ...leaveForm, end_date: v })} />
          <Field label="Reason" value={leaveForm.reason} onChangeText={(v) => setLeaveForm({ ...leaveForm, reason: v })} />
          {!!leaveError && <Text style={styles.captureNoticeError}>{leaveError}</Text>}
          <Pressable testID="leave-submit-button" onPress={submitLeave} disabled={leaveBusy} style={[styles.primaryButton, { marginTop: 4 }]}>
            {leaveBusy ? <ActivityIndicator color="#fff" /> : <><Ionicons name="paper-plane-outline" size={16} color="#fff" /><Text style={styles.primaryButtonText}>Submit leave</Text></>}
          </Pressable>
        </View>}
        {leaves.map((leave) => (
          <View testID={`leave-item-${leave.leave_id}`} style={styles.leaveItem} key={leave.leave_id}>
            <View style={{ flex: 1 }}>
              <Text style={styles.verifyTitle}>{leave.start_date} → {leave.end_date} · {leave.days}d</Text>
              <Text style={styles.verifySub}>{leave.reason}</Text>
            </View>
            <View style={[styles.leaveStatus, leave.status === "approved" ? styles.statusApproved : leave.status === "rejected" ? styles.statusRejected : styles.statusPending]}>
              <Text style={[styles.leaveStatusText, leave.status === "approved" ? { color: "#15803D" } : leave.status === "rejected" ? { color: "#991B1B" } : { color: "#A16207" }]}>{leave.status.toUpperCase()}</Text>
            </View>
          </View>
        ))}
        {leaves.length === 0 && !showLeaveForm && <Text style={styles.formHint}>You have no leave requests yet.</Text>}
      </View>
      {user.role !== "admin" && (
        <View style={styles.profileAction}>
          <Text style={styles.formTitle}>Need more access?</Text>
          <Text style={styles.formHint}>Request admin tools from an existing PKUCity administrator.</Text>
          <Pressable testID="request-admin-button" onPress={request} style={styles.outlineButton}><Ionicons name="key-outline" size={19} color="#DC2626" /><Text style={styles.outlineText}>Request admin access</Text></Pressable>
          {!!requestState && <Text style={styles.requestState}>{requestState}</Text>}
        </View>
      )}
      {user.role === "admin" && !!requestState && <Text style={styles.requestState}>{requestState}</Text>}
      <Pressable testID="logout-button" onPress={onLogout} style={styles.logoutButton}><Ionicons name="log-out-outline" size={20} color="#DC2626" /><Text style={styles.logoutText}>Sign out</Text></Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function BottomBar({ active, onChange, isAdmin }: { active: string; onChange: (value: string) => void; isAdmin: boolean }) {
  const tabs = [{ key: "home", label: "Home", icon: "home-outline" }, { key: "history", label: "History", icon: "time-outline" }, ...(isAdmin ? [{ key: "admin", label: "Admin", icon: "settings-outline" }] : []), { key: "profile", label: "Profile", icon: "person-outline" }];
  return <BlurView intensity={80} tint="light" style={styles.bottomBar}>{tabs.map((tab) => <Pressable testID={`tab-${tab.key}`} key={tab.key} onPress={() => onChange(tab.key)} style={({ pressed }) => [styles.tab, pressed && styles.pressed]}><Ionicons name={tab.icon as keyof typeof Ionicons.glyphMap} size={22} color={active === tab.key ? "#DC2626" : "#6B7280"} /><Text style={[styles.tabLabel, active === tab.key && styles.tabActive]}>{tab.label}</Text></Pressable>)}</BlurView>;
}

export default function Index() {
  const [authState, setAuthState] = useState<"loading" | "signed_out" | "signed_in">("loading"); const [user, setUser] = useState<User | null>(null); const [token, setToken] = useState(""); const [authBusy, setAuthBusy] = useState(false); const [authError, setAuthError] = useState(""); const [dashboard, setDashboard] = useState<Dashboard | null>(null); const [records, setRecords] = useState<RecordItem[]>([]); const [active, setActive] = useState("home"); const [captureAction, setCaptureAction] = useState<"check_in" | "check_out" | null>(null); const insets = useSafeAreaInsets();
  const signOut = useCallback(async () => { await clearToken(); setToken(""); setUser(null); setDashboard(null); setAuthState("signed_out"); }, []);
  const loadApp = useCallback(async (sessionToken: string) => { try { const [me, home, history] = await Promise.all([apiRequest<User>("/auth/me", sessionToken), apiRequest<Dashboard>("/dashboard", sessionToken), apiRequest<RecordItem[]>("/attendance", sessionToken)]); setToken(sessionToken); setUser(me); setDashboard(home); setRecords(history); setAuthState("signed_in"); } catch (error) { await clearToken(); setAuthError(error instanceof Error ? error.message : "Session expired"); setAuthState("signed_out"); } }, []);
  const exchange = useCallback(async (sessionId: string) => { if (!sessionId || usedSessionIds.has(sessionId)) return; usedSessionIds.add(sessionId); setAuthBusy(true); setAuthError(""); try { const response = await fetch(apiUrl("/auth/session"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) }); if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || "Google verification failed"); const data = await response.json(); await saveToken(data.session_token); await loadApp(data.session_token); if (Platform.OS === "web") { const cleanUrl = window.location.href.replace(/([?#&])session_id=[^&#]+/, "").replace(/[?&]$/, ""); window.history.replaceState(window.history.state, "", cleanUrl); } } catch (error) { usedSessionIds.delete(sessionId); setAuthError(error instanceof Error ? error.message : "Google verification failed"); setAuthState("signed_out"); } finally { setAuthBusy(false); } }, [loadApp]);
  useEffect(() => { let mounted = true; const handleUrl = (url: string) => { const id = sessionIdFromUrl(url); if (id && mounted) exchange(id); }; const setup = async () => { const initial = Platform.OS === "web" ? window.location.href : await Linking.getInitialURL(); if (initial) handleUrl(initial); const existing = await readToken(); if (mounted && !sessionIdFromUrl(initial) && existing) await loadApp(existing); else if (mounted && !sessionIdFromUrl(initial)) setAuthState("signed_out"); if (Platform.OS !== "web") { const listener = Linking.addEventListener("url", (event) => handleUrl(event.url)); return () => listener.remove(); } }; let cleanup: (() => void) | undefined; setup().then((fn) => { cleanup = fn; }); return () => { mounted = false; cleanup?.(); }; }, [exchange, loadApp]);
  const login = async () => { setAuthBusy(true); setAuthError(""); try { const redirectUrl = Platform.OS === "web" ? `${window.location.origin}/` : Linking.createURL(""); const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`; if (Platform.OS === "web") window.location.href = authUrl; else { let linkedUrl: string | null = null; const listener = Linking.addEventListener("url", (event) => { linkedUrl = event.url; }); const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl); listener.remove(); const callback = result.type === "success" ? result.url : linkedUrl || await Linking.getInitialURL(); const id = sessionIdFromUrl(callback); if (id) await exchange(id); else setAuthError("Google sign-in was cancelled."); } } catch (error) { setAuthError(error instanceof Error ? error.message : "Could not open Google sign-in"); setAuthBusy(false); } };
  const refresh = async () => { if (!token) return; try { const [home, history] = await Promise.all([apiRequest<Dashboard>("/dashboard", token), apiRequest<RecordItem[]>("/attendance", token)]); setDashboard(home); setRecords(history); } catch {} };
  const done = (message: string) => { setCaptureAction(null); Alert.alert("Attendance verified", message); refresh(); };
  if (authState === "loading" || (authBusy && authState !== "signed_in")) return <LoadingScreen />;
  if (authState === "signed_out" || !user) return <AuthScreen onLogin={login} busy={authBusy} error={authError} />;
  if (!user.profile_complete) return <OnboardingScreen user={user} token={token} onDone={(updated) => setUser(updated)} />;
  if (captureAction) return <CaptureScreen action={captureAction} token={token} onDone={done} onCancel={() => setCaptureAction(null)} />;
  return <View style={[styles.root, { paddingBottom: insets.bottom }]}>{active === "home" && <HomeScreen dashboard={dashboard} onRefresh={refresh} onOpenCapture={setCaptureAction} />}{active === "history" && <HistoryScreen records={records} loading={!records} />}{active === "admin" && user.role === "admin" && <AdminScreen token={token} />}{active === "profile" && <ProfileScreen user={user} token={token} onRequestAdmin={() => setActive("profile")} onLogout={signOut} onUserChange={setUser} />}<BottomBar active={active} onChange={setActive} isAdmin={user.role === "admin"} /></View>;
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
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 22 },
  greeting: { color: "#6B7280", fontSize: 14, marginBottom: 4 },
  heading: { fontSize: 27, lineHeight: 34, fontWeight: "800", letterSpacing: -0.7, color: "#111827" },
  subheading: { color: "#6B7280", fontSize: 15, marginTop: 5, marginBottom: 22 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#991B1B", fontWeight: "800", fontSize: 14 },
  liveCard: { backgroundColor: "#DC2626", borderRadius: 22, padding: 20, shadowColor: "#991B1B", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  cardKicker: { color: "#FECACA", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  cardTitle: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 8 },
  rule: { height: 1, backgroundColor: "rgba(255,255,255,0.22)", marginVertical: 18 },
  scheduleRow: { flexDirection: "row", alignItems: "center" },
  scheduleDivider: { width: 1, height: 30, backgroundColor: "rgba(255,255,255,0.24)", marginHorizontal: 18 },
  miniLabel: { color: "#FECACA", fontSize: 10, fontWeight: "800", letterSpacing: 0.7 },
  scheduleValue: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 5 },
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
  cameraShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.30)" },
  captureTop: { position: "absolute", top: 0, left: 20, right: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cameraBack: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.32)" },
  cameraTitle: { color: "#fff", fontSize: 17, fontWeight: "800" },
  recordingBadge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(220,38,38,0.9)", paddingHorizontal: 10, height: 30, borderRadius: 15 },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  recordingText: { color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  faceGuide: { position: "absolute", width: 230, height: 300, borderRadius: 115, top: "22%", left: "50%", marginLeft: -115, borderColor: "rgba(255,255,255,0.75)", borderWidth: 1 },
  faceCornerTL: { position: "absolute", width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#fff", top: -2, left: -2, borderTopLeftRadius: 18 },
  faceCornerTR: { position: "absolute", width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", top: -2, right: -2, borderTopRightRadius: 18 },
  faceCornerBL: { position: "absolute", width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#fff", bottom: -2, left: -2, borderBottomLeftRadius: 18 },
  faceCornerBR: { position: "absolute", width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#fff", bottom: -2, right: -2, borderBottomRightRadius: 18 },
  captureBottom: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center", paddingHorizontal: 20 },
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
  permissionState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  bigIcon: { width: 74, height: 74, borderRadius: 24, backgroundColor: "#FEF2F2", alignItems: "center", justifyContent: "center" },
  backButton: { position: "absolute", left: 18, top: 18, width: 44, height: 44, alignItems: "center", justifyContent: "center", zIndex: 2 },
  captureTitle: { fontSize: 24, fontWeight: "800", color: "#111827" },
  captureBody: { textAlign: "center", color: "#6B7280", fontSize: 15, lineHeight: 22, marginBottom: 12 },
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
  overtimeText: { color: "#B45309", fontSize: 11, fontWeight: "700", marginTop: 4 },
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
  statusApproved: { backgroundColor: "#DCFCE7" },
  statusRejected: { backgroundColor: "#FEE2E2" },
  statusPending: { backgroundColor: "#FEF3C7" },
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
});
