import { Ionicons } from "@expo/vector-icons";
import * as Camera from "expo-camera";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { BlurView } from "expo-blur";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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

type User = { user_id: string; email: string; name: string; role: "employee" | "admin"; email_verified: boolean };
type Office = { office_id: string; office_name: string; latitude: number; longitude: number; radius_meters: number; active: boolean };
type Holiday = { holiday_id: string; date: string; label: string };
type Dashboard = { user: User; settings: Office; offices: Office[]; schedule: { check_in: string; check_out: string; grace_minutes: number }; today?: { action?: string; created_at?: string }; holiday?: { label: string } | null };
type RecordItem = { attendance_id: string; date: string; action: string; distance_meters: number; verification: string; created_at: string; office_name?: string };
type AdminOverview = { settings: Office; offices: Office[]; schedule: Dashboard["schedule"]; requests: { request_id: string; name: string; email: string }[]; holidays: Holiday[] };
type LivenessSession = { liveness_session_id: string; steps: string[]; expires_in: number };
type ReportSummary = { user_id: string; name: string; email?: string; check_ins: number; check_outs: number; last_action?: string; last_at?: string };
type ReportPayload = { date_from: string; date_to: string; total_rows: number; summary: ReportSummary[] };

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
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 32 }]} showsVerticalScrollIndicator={false}>
    <View style={styles.headerRow}><View><Text style={styles.greeting}>Good day</Text><Text style={styles.heading}>{dashboard?.user.name || "Your workspace"}</Text></View><View style={styles.avatar}><Text style={styles.avatarText}>{initials(dashboard?.user.name || "PK")}</Text></View></View>
    {!!holiday && <View testID="holiday-banner" style={styles.holidayBanner}><Ionicons name="sparkles" size={18} color="#B45309" /><Text style={styles.holidayText}>Today is a holiday · {holiday.label}. Attendance is optional.</Text></View>}
    <View style={styles.liveCard}><View style={styles.cardTop}><View><Text style={styles.cardKicker}>TODAY’S ATTENDANCE</Text><Text style={styles.cardTitle}>{completed ? `Checked ${completed === "check_in" ? "in" : "out"}` : "Ready when you are"}</Text></View><StatusPill label={completed ? "Recorded" : "Not started"} tone={completed ? "success" : "neutral"} /></View><View style={styles.rule} /><View style={styles.scheduleRow}><View><Text style={styles.miniLabel}>SHIFT</Text><Text style={styles.scheduleValue}>{dashboard?.schedule.check_in || "08:00"} — {dashboard?.schedule.check_out || "17:00"}</Text></View><View style={styles.scheduleDivider} /><View><Text style={styles.miniLabel}>NEAREST OFFICE</Text><Text style={styles.scheduleValue}>{nearestOffice?.office_name || "—"}</Text></View></View></View>
    <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Verification</Text><Pressable onPress={onRefresh} hitSlop={8}><Ionicons name="refresh" size={20} color="#DC2626" /></Pressable></View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="location" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>Office location</Text><Text style={styles.verifySub}>{locating ? locationState : distance === null ? locationState : `${distance}m away · ${locationState}`}</Text></View>{locating ? <ActivityIndicator color="#DC2626" /> : <Ionicons name={inRange ? "checkmark-circle" : "alert-circle"} size={22} color={inRange ? "#16A34A" : "#CA8A04"} />}</View>
    <View style={styles.verifyCard}><View style={styles.verifyIcon}><Ionicons name="videocam" size={21} color="#DC2626" /></View><View style={styles.verifyCopy}><Text style={styles.verifyTitle}>Face liveness (video)</Text><Text style={styles.verifySub}>Record a short video and follow on-screen prompts</Text></View><Ionicons name="shield-checkmark-outline" size={22} color="#16A34A" /></View>
    <Text style={styles.helper}>You must be within {nearestOffice?.radius_meters || 100}m of an active office to record attendance.</Text>
    <View style={styles.actionArea}><Pressable testID="attendance-primary-button" onPress={() => onOpenCapture(canCheckIn ? "check_in" : "check_out")} disabled={!inRange || locating} style={({ pressed }) => [styles.primaryButton, (pressed && styles.pressed), (!inRange || locating) && styles.disabled]}><Ionicons name={canCheckIn ? "log-in-outline" : "log-out-outline"} size={22} color="#fff" /><Text style={styles.primaryButtonText}>{canCheckIn ? "Check in now" : "Check out now"}</Text></Pressable><Text style={styles.actionCaption}>{!inRange ? "Waiting for a valid office location" : "Camera video and location will be checked"}</Text></View>
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

// ------------------ Admin -------------------------------------------------------

type AdminTab = "access" | "offices" | "holidays" | "schedule" | "reports";

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
  const tabs: [AdminTab, string][] = [["access", "Access"], ["offices", "Offices"], ["schedule", "Schedule"], ["holidays", "Holidays"], ["reports", "Reports"]];
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
      {tab === "schedule" && <ScheduleTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
      {tab === "holidays" && <HolidaysTab token={token} overview={overview} onChange={load} onMessage={setMessage} />}
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
      <Text style={styles.formHint}>Employees can check in near any active office.</Text>
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

function ReportsTab({ token }: { token: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date().toISOString().slice(0, 8) + "01";
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(today);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
      {!!error && <Text style={styles.captureNoticeError}>{error}</Text>}
      {report && <Text style={styles.formHint}>{report.total_rows} records · {report.summary.length} employees</Text>}
    </View>
    {(report?.summary || []).map((summary) => (
      <View testID={`report-row-${summary.user_id}`} style={styles.requestCard} key={summary.user_id}>
        <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initials(summary.name)}</Text></View>
        <View style={styles.requestCopy}>
          <Text style={styles.verifyTitle}>{summary.name}</Text>
          <Text style={styles.verifySub}>{summary.email || summary.user_id}</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.reportMetric}>{summary.check_ins} in</Text>
          <Text style={styles.reportMetricMuted}>{summary.check_outs} out</Text>
        </View>
      </View>
    ))}
    {report && report.summary.length === 0 && !loading && (
      <View style={styles.emptySmall}><Ionicons name="bar-chart-outline" size={25} color="#DC2626" /><Text style={styles.emptyTitle}>No records in range</Text><Text style={styles.emptyBody}>Try widening the date window.</Text></View>
    )}
  </View>;
}

function Field({ label, value, onChangeText, keyboardType = "default" }: { label: string; value: string; onChangeText: (value: string) => void; keyboardType?: "default" | "numeric" }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} keyboardType={keyboardType} style={styles.input} placeholderTextColor="#9CA3AF" /></View>;
}

function ProfileScreen({ user, token, onRequestAdmin, onLogout }: { user: User; token: string; onRequestAdmin: () => void; onLogout: () => void }) {
  const insets = useSafeAreaInsets(); const [requestState, setRequestState] = useState("");
  const request = async () => { try { const data = await apiRequest<{ message: string }>("/admin/request", token, { method: "POST" }); setRequestState(data.message); onRequestAdmin(); } catch (error) { setRequestState(error instanceof Error ? error.message : "Could not send request"); } };
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: 30 }]}><Text style={styles.heading}>Profile</Text><Text style={styles.subheading}>Your verified PKUCity account</Text><View style={styles.profileCard}><View style={styles.avatarLarge}><Text style={styles.avatarLargeText}>{initials(user.name)}</Text></View><Text style={styles.profileName}>{user.name}</Text><Text style={styles.profileEmail}>{user.email}</Text><View style={styles.verifiedLabel}><Ionicons name="checkmark-circle" size={17} color="#16A34A" /><Text style={styles.verifiedText}>Google account verified</Text></View><View style={styles.roleBadge}><Text style={styles.roleText}>{user.role === "admin" ? "ADMIN" : "EMPLOYEE"}</Text></View></View>{user.role !== "admin" && <View style={styles.profileAction}><Text style={styles.formTitle}>Need more access?</Text><Text style={styles.formHint}>Request admin tools from an existing PKUCity administrator.</Text><Pressable testID="request-admin-button" onPress={request} style={styles.outlineButton}><Ionicons name="key-outline" size={19} color="#DC2626" /><Text style={styles.outlineText}>Request admin access</Text></Pressable>{!!requestState && <Text style={styles.requestState}>{requestState}</Text>}</View>}<Pressable testID="logout-button" onPress={onLogout} style={styles.logoutButton}><Ionicons name="log-out-outline" size={20} color="#DC2626" /><Text style={styles.logoutText}>Sign out</Text></Pressable></ScrollView>;
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
  if (captureAction) return <CaptureScreen action={captureAction} token={token} onDone={done} onCancel={() => setCaptureAction(null)} />;
  return <View style={[styles.root, { paddingBottom: insets.bottom }]}>{active === "home" && <HomeScreen dashboard={dashboard} onRefresh={refresh} onOpenCapture={setCaptureAction} />}{active === "history" && <HistoryScreen records={records} loading={!records} />}{active === "admin" && user.role === "admin" && <AdminScreen token={token} />}{active === "profile" && <ProfileScreen user={user} token={token} onRequestAdmin={() => setActive("profile")} onLogout={signOut} />}<BottomBar active={active} onChange={setActive} isAdmin={user.role === "admin"} /></View>;
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
});
