import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Library as LibraryIcon, Plus, Settings as SettingsIcon, Square } from "lucide-react";
import { CourseInput } from "./components/CourseInput";
import { MicrophoneToggle } from "./components/MicrophoneToggle";
import { SourcePicker } from "./components/SourcePicker";
import { canStartRecording } from "./features/recording/setup";
import type { CaptureSource } from "./features/recording/types";
import {
  isTauri,
  native,
  requestCapturePermission,
  type LocalSession,
  type RecordingSnapshot,
} from "./native";
import { getLang, setLang, useLang, useT, t, type Lang } from "./i18n";

type View =
  | "setup"
  | "recording"
  | "finalizing"
  | "library"
  | "detail"
  | "settings";
type UiSource = CaptureSource & {
  native: { id: string; name: string; icon_hint: string; icon_data?: string | null; available: boolean };
};

const fallbackSources = (): UiSource[] => [
  {
    id: "zoom",
    name: "Zoom Workplace",
    detail: t("setup.src.meeting"),
    available: true,
    native: {
      id: "zoom",
      name: "Zoom Workplace",
      icon_hint: "us.zoom.xos",
      available: true,
    },
  },
  {
    id: "chrome",
    name: "Google Chrome",
    detail: "Google Meet",
    available: true,
    native: {
      id: "chrome",
      name: "Google Chrome",
      icon_hint: "com.google.Chrome",
      available: true,
    },
  },
  {
    id: "safari",
    name: "Safari",
    detail: t("setup.src.closed"),
    available: false,
    native: {
      id: "safari",
      name: "Safari",
      icon_hint: "com.apple.Safari",
      available: false,
    },
  },
];

const formatTime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const formatDate = (date: string) =>
  new Intl.DateTimeFormat(getLang() === "fr" ? "fr-FR" : "en-US", {
    day: "numeric",
    month: "short",
  }).format(new Date(date));
const preference = {
  get: (key: string) => {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      /* storage unavailable in test/preview */
    }
  },
};

function Logo() {
  return (
    <div aria-hidden="true" className="brand-mark">
      <span />
      <i />
    </div>
  );
}
function Header({
  view,
  setView,
}: {
  view: View;
  setView: (view: View) => void;
}) {
  const t = useT();
  return (
    <header className="app-header product-header">
      <button className="brand brand-button" onClick={() => setView("setup")}>
        <Logo />
        <span className="sr-only">Pssst</span>
      </button>
      <nav aria-label={t("nav.main")}>
        <button onClick={() => setView("library")}>
          <LibraryIcon size={15} aria-hidden="true" /> {t("nav.courses")}
        </button>
        <button onClick={() => setView("settings")}>
          <SettingsIcon size={15} aria-hidden="true" /> {t("nav.settings")}
        </button>
      </nav>
      <div className="ready-status">
        <span /> {view === "recording" ? t("status.recording") : t("status.ready")}
        <small>v0.12.28</small>
      </div>
    </header>
  );
}

function Onboarding({ finish }: { finish: () => void }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState(
    () => preference.get("pssst.transcription-mode") ?? "automatic",
  );
  const [installed, setInstalled] = useState(false);
  const [permission, setPermission] = useState(false);
  const [serverLink, setServerLink] = useState(
    () => preference.get("pssst.connection-link") ?? "",
  );
  const [serverReady, setServerReady] = useState(() => Boolean(preference.get("pssst.connection-link")));
  const [serverError, setServerError] = useState(() =>
    preference.get("pssst.connection-link") ? t("onb.server.saved") : "",
  );
  const connectServer = async () => {
    const link = serverLink.trim();
    try {
      const url = new URL(link);
      if (!/^https?:$/.test(url.protocol) || !url.pathname.includes("/connect/")) {
        throw new Error(t("onb.server.badLink"));
      }
      const result = isTauri()
        ? await native.validateServerLink(url.toString())
        : await fetch(url.toString()).then(async (response) => {
            if (!response.ok) {
              if (response.status === 401) throw new Error(t("onb.server.revoked"));
              throw new Error(t("onb.server.httpError", { status: response.status }));
            }
            return response.json();
          });
      if (!result?.capabilities?.faster_whisper) {
        throw new Error(t("onb.server.notWhisper"));
      }
      preference.set("pssst.connection-link", url.toString());
      setServerReady(true);
      setServerLink(url.toString());
      setServerError(t("onb.server.ok", { model: result.capabilities.whisper_model }));
    } catch (error) {
      setServerReady(false);
      setServerError(
        error instanceof TypeError
          ? t("onb.server.unreachable")
          : error instanceof Error
            ? error.message
            : t("onb.server.failed"),
      );
    }
  };
  const next = () => {
    if (step === 2) {
      preference.set("pssst.transcription-mode", mode);
      // Both local Whisper and a self-hosted server have a short setup step.
      // Keep the server flow visible instead of silently blocking Continue.
      if (mode === "local" || mode === "server") setStep(3);
      else setStep(4);
    } else if (step === 3) {
      if (mode === "server") {
        if (!serverReady) return;
        setStep(4);
      } else {
        setInstalled(true);
        setStep(4);
      }
    } else if (step === 4) setStep(5);
    else if (step === 5) {
      preference.set("pssst.onboarding-complete", "true");
      preference.set("pssst.mic-default", "true");
      finish();
    } else setStep(step + 1);
  };
  return (
    <main className="onboarding">
      <div className="onboarding-top">
        <button className="brand brand-button">
          <Logo />
          <span className="sr-only">Pssst</span>
        </button>
        <span>{step + 1} / 6</span>
      </div>
      <div key={step} className="onboarding-content onboarding-step">
        {step === 0 && (
          <>
            <p className="eyebrow">{t("onb.step0.eyebrow")}</p>
            <h1>
              {t("onb.step0.titleA")}
              <br />
              <em>{t("onb.step0.titleB")}</em>
            </h1>
            <p>{t("onb.step0.copy")}</p>
          </>
        )}
        {step === 1 && (
          <>
            <p className="eyebrow">{t("onb.step1.eyebrow")}</p>
            <h1>
              {t("onb.step1.titleA")}
              <br />
              <em>{t("onb.step1.titleB")}</em>
            </h1>
            <div className="flow-line">
              <span>{t("onb.step1.flow.capture")}</span>
              <b>→</b>
              <span>{t("onb.step1.flow.local")}</span>
              <b>→</b>
              <span>Whisper</span>
              <b>→</b>
              <span>{t("onb.step1.flow.correction")}</span>
            </div>
            <p>{t("onb.step1.copy")}</p>
          </>
        )}
        {step === 2 && (
          <>
            <p className="eyebrow">{t("onb.step2.eyebrow")}</p>
            <h1>
              {t("onb.step2.titleA")}
              <br />
              <em>{t("onb.step2.titleB")}</em>
            </h1>
            <div className="choice-list">
              {[
                [
                  "automatic",
                  t("onb.step2.auto.title"),
                  t("onb.step2.auto.copy"),
                ],
                [
                  "local",
                  t("onb.step2.local.title"),
                  t("onb.step2.local.copy"),
                ],
                [
                  "server",
                  t("onb.step2.server.title"),
                  t("onb.step2.server.copy"),
                ],
              ].map(([id, title, copy]) => (
                <button
                  className={mode === id ? "choice selected" : "choice"}
                  onClick={() => setMode(id)}
                  key={id}
                >
                  <span className="choice-radio" />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 3 && mode === "server" && (
          <>
            <p className="eyebrow">{t("onb.step3s.eyebrow")}</p>
            <h1>
              {t("onb.step3s.titleA")}
              <br />
              <em>{t("onb.step3s.titleB")}</em>
            </h1>
            <p>{t("onb.step3s.copy")}</p>
            <div className="model-install server-connect-card">
              <strong>{t("onb.step3s.install")}</strong>
              <div className="command-box">
                <code>curl -fsSL https://irisla.com/pssst/install.sh | sudo bash</code>
                <button
                  className="copy-icon"
                  aria-label={t("onb.copyCmd")}
                  title={t("onb.copyCmd")}
                  onClick={() => navigator.clipboard?.writeText("curl -fsSL https://irisla.com/pssst/install.sh | sudo bash")}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </button>
              </div>
              <label>
                <strong>{t("onb.step3s.linkLabel")}</strong>
                <input
                  value={serverLink}
                  onChange={(event) => {
                    setServerLink(event.target.value);
                    setServerReady(false);
                    setServerError("");
                  }}
                  placeholder={t("onb.step3s.linkPlaceholder")}
                  spellCheck={false}
                />
              </label>
              <button className="record-button" onClick={connectServer} disabled={!serverLink.trim()}>
                {serverReady ? t("onb.step3s.connected") : t("onb.step3s.connect")}
              </button>
              {serverError && <small className={serverReady ? "server-success" : "server-error"}>{serverError}</small>}
            </div>
          </>
        )}
        {step === 3 && mode !== "server" && (
          <>
            <p className="eyebrow">{t("onb.step3l.eyebrow")}</p>
            <h1>
              {t("onb.step3l.titleA")}
              <br />
              <em>{t("onb.step3l.titleB")}</em>
            </h1>
            <div className="model-install">
              <strong>Whisper Medium</strong>
              <span>{t("onb.step3l.modelCopy")}</span>
              {installed ? (
                <p>{t("onb.step3l.ready")}</p>
              ) : (
                <button
                  className="record-button"
                  onClick={() => setInstalled(true)}
                >
                  {t("onb.step3l.install")}
                </button>
              )}
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <p className="eyebrow">{t("onb.step4.eyebrow")}</p>
            <h1>
              {t("onb.step4.titleA")}
              <br />
              <em>{t("onb.step4.titleB")}</em>
            </h1>
            <div className="permission-list">
              <div>
                <strong>{t("onb.step4.sysAudio")}</strong>
                <small>{t("onb.step4.sysAudioCopy")}</small>
                <button onClick={() => native.requestScreenRecordingAccess()}>
                  {t("onb.step4.allow")}
                </button>
              </div>
              <div>
                <strong>
                  {t("onb.step4.mic")} <i>{t("onb.step4.optional")}</i>
                </strong>
                <small>{t("onb.step4.micCopy")}</small>
                <button onClick={() => setPermission(true)}>
                  {permission ? t("onb.step4.allowed") : t("onb.step4.allow")}
                </button>
              </div>
            </div>
          </>
        )}
        {step === 5 && (
          <>
            <p className="eyebrow">{t("onb.step5.eyebrow")}</p>
            <h1>
              {t("onb.step5.titleA")}
              <br />
              <em>{t("onb.step5.titleB")}</em>
            </h1>
            <p>{t("onb.step5.copy")}</p>
          </>
        )}
      </div>
      <div className="onboarding-actions">
        {step > 0 && (
          <button className="text-button" onClick={() => setStep(step - 1)}>
            {t("onb.back")}
          </button>
        )}
        <button className="record-button" onClick={next}>
          {step === 5 ? t("onb.start") : t("onb.continue")}
        </button>
      </div>
    </main>
  );
}

function Setup({
  start,
  initialCourse = "",
  initialAppId = null,
  initialMic = true,
  courseSuggestions = [],
}: {
  start: (source: UiSource, course: string, mic: boolean) => Promise<void>;
  initialCourse?: string;
  initialAppId?: string | null;
  initialMic?: boolean;
  courseSuggestions?: string[];
}) {
  const t = useT();
  const [sources, setSources] = useState<UiSource[]>(fallbackSources);
  const [source, setSource] = useState<UiSource | null>(null);
  const [open, setOpen] = useState(false);
  const [course, setCourse] = useState(
    () => initialCourse || preference.get("pssst.last-course") || "",
  );
  const [mic, setMic] = useState(initialMic);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [permissionRequired, setPermissionRequired] = useState(false);
  const requestedIcons = useRef(new Set<string>());

  useEffect(() => {
    if (initialCourse) setCourse(initialCourse);
  }, [initialCourse]);

  const loadApplications = async () => {
    if (!isTauri()) return;
    try {
      const status = await native.capturePermissionStatus();
      const needsPermission = status !== "granted";
      setPermissionRequired(needsPermission);
      if (needsPermission) {
        // Keep the probe one-shot so an unavailable audio device never turns
        // into a repeated permission prompt on every launch.
        if (!preference.get("pssst.requested-legacy-capture-permission")) {
          preference.set("pssst.requested-legacy-capture-permission", "true");
          const granted = await native.requestScreenRecordingAccess();
          if (granted) await loadApplications();
        }
        return;
      }
      const applications = await native.applications();
      const mapped = applications.map((application) => ({
        id: application.id,
        name: application.name,
        detail: t("setup.src.open"),
        available: application.available,
        iconData:
          sources.find((item) => item.id === application.id)?.iconData ??
          application.icon_data,
        native: application,
      }));
      setSources(mapped);

      // Auto-select initial app or last used app
      const targetId = initialAppId || preference.get("pssst.last-app-id");
      if (targetId) {
        const found = mapped.find((item) => item.id === targetId && item.available);
        if (found) setSource(found);
      }
      // The picker is useful before every icon is ready. Resolve macOS app
      // icons afterwards so an indexing delay can never hide the sources.
      void (async () => {
        for (const application of applications) {
          if (requestedIcons.current.has(application.id)) continue;
          requestedIcons.current.add(application.id);
          try {
            const iconData = await native.applicationIcon(application.icon_hint);
            if (!iconData) continue;
            setSources((current) =>
              current.map((item) =>
                item.id === application.id ? { ...item, iconData } : item,
              ),
            );
          } catch {
            // A missing Finder/Spotlight icon is cosmetic; keep the source.
          }
        }
      })();
      setError("");
    } catch (reason) {
      const message = String(reason);
      setError(message);
      // Any Core Audio/TCC failure is a permission state, not a source
      // picker failure. Keep the raw reason for diagnostics, but render the
      // guided permission card so users never see a dead/empty picker.
      if (/permission|tcc|shareable content|capture/i.test(message)) setPermissionRequired(true);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    void loadApplications();
    window.addEventListener("focus", loadApplications);
    return () => {
      window.removeEventListener("focus", loadApplications);
    };
  }, []);
  const ready = canStartRecording({ source, course });
  const permissionDenied =
    permissionRequired ||
    /permission|tcc|shareable content|capture/i.test(error);
  return (
    <main className="setup">
      <section className="setup-intro">
        <p className="eyebrow">{t("setup.eyebrow")}</p>
        <h1>
          {t("setup.titleA")}
          <br />
          <em>{t("setup.titleB")}</em>
        </h1>
        <p>{t("setup.copy")}</p>
      </section>
      <section className="setup-form">
        {permissionDenied ? (
          <section className="permission-card">
            <p className="eyebrow">{t("setup.perm.eyebrow")}</p>
            <h3>{t("setup.perm.title")}</h3>
            <p>{t("setup.perm.copy")}</p>
            <button
              className="record-button"
              onClick={async () => {
                const granted = await requestCapturePermission();
                if (granted) {
                  await loadApplications();
                  return;
                }
                window.setTimeout(() => void loadApplications(), 900);
              }}
            >
              {t("setup.perm.button")}
            </button>
            <small>{t("setup.perm.hint")}</small>
          </section>
        ) : (
          <>
            <CourseInput suggestions={courseSuggestions} value={course} onChange={setCourse} />
            <SourcePicker
              sources={sources}
              selected={source}
              open={open}
              onOpenChange={setOpen}
              onSelect={(item) => {
                setSource(item as UiSource);
                setOpen(false);
              }}
            />
            <MicrophoneToggle enabled={mic} onChange={setMic} />
            {error && (
              <p className="availability-note">
                <span>!</span>
                {error}
              </p>
            )}
            {!ready && !error && (
              <p className="availability-note compact">
                <span>!</span>
                {!course.trim()
                  ? t("setup.hint.course")
                  : t("setup.hint.app")}
              </p>
            )}
            <div className="action-row">
              <p className="local-note">
                <span>⌁</span> {t("setup.localNote")}
              </p>
              <button
                className="record-button"
                disabled={!ready || starting}
                onClick={async () => {
                  if (!source) return;
                  setStarting(true);
                  setError("");
                  try {
                    await start(source, course, mic);
                  } catch (reason) {
                    setError(String(reason));
                    setStarting(false);
                  }
                }}
              >
                <span className="record-button-dot" />
                {starting ? t("setup.preparing") : t("setup.start")}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function Recording({
  snapshot,
  stop,
}: {
  snapshot: RecordingSnapshot;
  stop: () => Promise<void>;
}) {
  const t = useT();
  const [seconds, setSeconds] = useState(snapshot.elapsed_seconds);
  const [stopping, setStopping] = useState(false);
  const [offline, setOffline] = useState(false);
  const [segments, setSegments] = useState(
    snapshot.session.transcript_segments,
  );
  useEffect(() => {
    setSeconds(snapshot.elapsed_seconds);
  }, [snapshot.elapsed_seconds]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setSeconds((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setInterval(
      () =>
        native
          .get(snapshot.session.id)
          .then((next) => setSegments(next.session.transcript_segments))
          .catch(() => setOffline(true)),
      3_000,
    );
    return () => window.clearInterval(timer);
  }, [snapshot.session.id]);
  const session = snapshot.session;
  return (
    <main className="session-page">
      <section className="session-top">
        <div>
          <p className="eyebrow">{t("rec.eyebrow")}</p>
          <h2>{session.course}</h2>
          <p className="session-subline">
            <b className="recording-live" /> {formatTime(seconds)} ·{" "}
            {session.selected_application.name}
            {session.microphone_included && ` · ${t("rec.micIncluded")}`}
          </p>
        </div>
        <div className="session-actions">
          <button
            className="network-button"
            onClick={() => setOffline(!offline)}
          >
            {offline ? t("rec.offline") : t("rec.connected")}
          </button>
          <button
            className="stop-button"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              await stop();
            }}
          >
            <Square size={12} fill="currentColor" stroke="none" aria-hidden="true" />
            {stopping ? t("rec.finalizing") : t("rec.stop")}
          </button>
        </div>
      </section>
      <div className="session-health">
        <span>
          <i className="health-dot active" />
          {t("rec.health.local")}
        </span>
        <span>
          <i className={`health-dot ${offline ? "delayed" : "waiting"}`} />
          {offline
            ? t("rec.health.deferred")
            : segments.length
              ? t("rec.health.upToDate")
              : t("rec.health.waiting")}
        </span>
        <span>
          <i className="health-dot waiting" />
          {t("rec.health.correction")}
        </span>
      </div>
      <section className="transcript-stage">
        <div className="transcript-heading">
          <div>
            <h3>{t("rec.transcript")}</h3>
            <p>
              {offline
                ? t("rec.transcript.offline")
                : t("rec.transcript.live")}
            </p>
          </div>
          <button>{t("rec.transcript.jump")}</button>
        </div>
        <div className="transcript-list">
          {segments.map((segment) => (
            <article className="transcript-segment" key={segment.backend_id}>
              <time>{formatTime(Math.floor(segment.start_ms / 1000))}</time>
              <p>{segment.raw_text}</p>
              <small>{segment.corrected_text ? t("rec.seg.corrected") : t("rec.seg.raw")}</small>
            </article>
          ))}
          {!segments.length && (
            <article className="transcript-segment waiting">
              <time>{formatTime(seconds)}</time>
              <p>{t("rec.seg.preparing")}</p>
            </article>
          )}
        </div>
      </section>
    </main>
  );
}

function Finalizing({
  snapshot,
  open,
}: {
  snapshot: RecordingSnapshot;
  open: () => void;
}) {
  const t = useT();
  return (
    <main className="finalizing">
      <p className="eyebrow">{t("fin.eyebrow")}</p>
      <h1>
        {t("fin.titleA")}
        <br />
        <em>{t("fin.titleB")}</em>
      </h1>
      <p>
        {snapshot.session.tracks.reduce(
          (sum, track) => sum + track.bytes_written,
          0,
        ) > 44
          ? t("fin.copy.ready")
          : t("fin.copy.wait")}
      </p>
      <button className="record-button" onClick={open}>
        {t("fin.open")}
      </button>
    </main>
  );
}

function Library({
  sessions,
  open,
  setup,
}: {
  sessions: RecordingSnapshot[];
  open: (snapshot: RecordingSnapshot) => void;
  setup: () => void;
}) {
  const t = useT();
  return (
    <main className="library-page">
      <div className="library-title">
        <div>
          <p className="eyebrow">{t("lib.eyebrow")}</p>
          <h1>
            {t("lib.titleA")}
            <br />
            <em>{t("lib.titleB")}</em>
          </h1>
        </div>
        <button className="new-recording" onClick={setup}>
          <Plus size={14} aria-hidden="true" /> {t("lib.new")}
        </button>
      </div>
      <div className="search-line">
        <input placeholder={t("lib.search")} />
        <span>⌘ K</span>
      </div>
      <div className="lecture-list">
        {sessions.length ? (
          sessions.map((snapshot) => (
            <button key={snapshot.session.id} onClick={() => open(snapshot)}>
              <span className="lecture-date">
                {formatDate(snapshot.session.started_at)}
                <small>{formatTime(snapshot.elapsed_seconds)}</small>
              </span>
              <span>
                <strong>{snapshot.session.course}</strong>
                <small>
                  {snapshot.session.selected_application.name} ·{" "}
                  {snapshot.session.recording_state === "recording"
                    ? t("lib.state.recording")
                    : t("lib.state.local")}
                </small>
              </span>
              <span className="lecture-end-actions">
                <i className="lecture-status">
                  {snapshot.session.recording_state === "recoverable"
                    ? t("lib.state.recoverable")
                    : snapshot.session.recording_state === "recording"
                      ? t("lib.state.recording")
                      : t("lib.state.ready")}
                </i>
                <b>›</b>
              </span>
            </button>
          ))
        ) : (
          <p className="empty-library">{t("lib.empty")}</p>
        )}
      </div>
    </main>
  );
}

function Detail({
  snapshot,
  continueCourse,
  onBack,
}: {
  snapshot: RecordingSnapshot;
  continueCourse: (course: string, appId?: string | null, mic?: boolean) => void;
  onBack?: () => void;
}) {
  const t = useT();
  const [version, setVersion] = useState("final");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioError, setAudioError] = useState("");
  const [session, setSession] = useState(snapshot.session);
  const [correcting, setCorrecting] = useState(false);
  const [correctionMessage, setCorrectionMessage] = useState("");

  const isCorrecting =
    correcting || session.correction_state === "uploading";

  useEffect(() => {
    setSession(snapshot.session);
  }, [snapshot]);

  useEffect(() => {
    if (session.correction_state === "uploaded" && correcting) {
      setCorrecting(false);
      setCorrectionMessage(t("detail.correct.done"));
    } else if (session.correction_state === "failed" && correcting) {
      setCorrecting(false);
      setCorrectionMessage(session.last_error || t("detail.correct.failed"));
    }
  }, [session.correction_state, session.last_error, correcting, t]);

  useEffect(() => {
    if (!isTauri()) return;
    const intervalMs = isCorrecting ? 400 : 3000;
    const timer = window.setInterval(() => {
      native
        .get(session.id)
        .then((next) => {
          setSession(next.session);
        })
        .catch(() => undefined);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [session.id, isCorrecting]);

  useEffect(() => {
    if (!isTauri()) return;
    let objectUrlToRevoke: string | null = null;
    let isCancelled = false;
    invokeTrack(session.id)
      .then(async (path) => {
        if (isCancelled) return;
        setAudioError("");
        const assetUrl = convertFileSrc(path);
        try {
          const res = await fetch(assetUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (isCancelled) return;
          if (blob.size <= 44) {
            setAudioUrl("");
            setAudioError(t("detail.audio.empty"));
            return;
          }
          const blobUrl = URL.createObjectURL(blob);
          objectUrlToRevoke = blobUrl;
          setAudioUrl(blobUrl);
        } catch {
          if (!isCancelled) {
            setAudioUrl(assetUrl);
          }
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setAudioUrl("");
          setAudioError(String(error));
          console.error("Pssst audio track error", error);
        }
      });
    return () => {
      isCancelled = true;
      if (objectUrlToRevoke) {
        URL.revokeObjectURL(objectUrlToRevoke);
      }
    };
  }, [session.id, t]);
  const transcript = useMemo(
    () =>
      session.transcript_segments.map((segment) => ({
        time: segment.start_ms,
        text:
          version === "final"
            ? (segment.final_text || segment.corrected_text || segment.raw_text)
            : version === "corrected"
              ? (segment.corrected_text || segment.raw_text)
              : segment.raw_text,
      })),
    [session.transcript_segments, version],
  );
  return (
    <main className="detail-page">
      {onBack && (
        <button
          type="button"
          className="back-link"
          onClick={onBack}
          aria-label={t("detail.back")}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t("detail.back.short")}</span>
        </button>
      )}
      <div className="detail-head">
        <div>
          <p className="eyebrow">{session.course.toUpperCase()}</p>
          <h1>{session.selected_application.name}</h1>
          <p>
            {formatDate(session.started_at)} ·{" "}
            {formatTime(snapshot.elapsed_seconds)}
          </p>
        </div>
        <div className="detail-head-actions">
          <button
            className="new-recording"
            onClick={() =>
              continueCourse(
                session.course,
                session.selected_application.id,
                session.microphone_included,
              )
            }
          >
            {t("detail.continue")}
          </button>
          <div className="audio-player">
            <small>
              {audioUrl ? t("detail.audio.ready") : audioError ? t("detail.audio.unavailable") : t("detail.audio.preparing")}
            </small>
            {audioUrl && (
              <audio
                id="lecture-audio"
                src={audioUrl}
                controls
                onError={(event) => {
                  const detail = event.currentTarget.error?.message || t("detail.audio.invalid");
                  const message = t("detail.audio.playError", { detail });
                  setAudioError(message);
                  console.error("Pssst audio playback error", event.currentTarget.error);
                }}
              />
            )}
            {audioError && <span className="audio-error" role="status">{audioError}</span>}
          </div>
        </div>
      </div>
      <div className="version-tabs">
        {["final", "corrected", "raw"].map((item) => (
          <button
            className={version === item ? "selected" : ""}
            onClick={() => setVersion(item)}
            key={item}
          >
            {item === "final"
              ? t("detail.tab.final")
              : item === "corrected"
                ? t("detail.tab.corrected")
                : t("detail.tab.raw")}
          </button>
        ))}
      </div>
      <div className="detail-transcript">
        {version === "corrected" && (
          <div className="correct-bar">
            <button
              type="button"
              className="correct-button"
              disabled={isCorrecting || !session.transcript_segments.length}
              onClick={async () => {
                if (!isTauri()) return;
                setCorrecting(true);
                setCorrectionMessage(t("detail.correct.running"));
                try {
                  await native.correctSession(session.id);
                } catch (error) {
                  setCorrecting(false);
                  setCorrectionMessage(String(error));
                }
              }}
            >
              {isCorrecting ? t("detail.correct.running") : t("detail.correct.button")}
            </button>
            {correctionMessage && (
              <span className="correct-status">{correctionMessage}</span>
            )}
          </div>
        )}
        {version === "corrected" ? (
          transcript.length ? (
            <div className="corrected-block">
              {transcript.map((line) => line.text).join(" ").replace(/\s+/g, " ")}
            </div>
          ) : (
            <p className="pending-copy">{t("detail.pending")}</p>
          )
        ) : (
          <>
            {transcript.map((line, index) => (
              <p key={`${line.time}-${index}`}>
                <time>{formatTime(Math.floor(line.time / 1000))}</time>
                {line.text}
              </p>
            ))}
            {!transcript.length && (
              <p className="pending-copy">{t("detail.pending")}</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
  };
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} onClick={handleClick}>
      {children}
    </a>
  );
}

function Settings() {
  const t = useT();
  const lang = useLang();
  const [mode, setMode] = useState(
    () => preference.get("pssst.transcription-mode") ?? "automatic",
  );
  const [link, setLink] = useState(
    () => preference.get("pssst.connection-link") ?? "",
  );
  const [connection, setConnection] = useState("");
  const [copied, setCopied] = useState(false);
  const [model, setModel] = useState(
    () => preference.get("pssst.openrouter-model") ?? "openai/gpt-4o-mini",
  );
  const [apiKey, setApiKey] = useState(
    () => preference.get("pssst.openrouter-api-key") ?? "",
  );
  const [accountName, setAccountName] = useState(
    () => preference.get("pssst.account-name") ?? "",
  );
  const [accountEmail, setAccountEmail] = useState(
    () => preference.get("pssst.account-email") ?? "",
  );
  const [accountSaved, setAccountSaved] = useState(false);
  const connect = async () => {
    try {
      const result = isTauri()
        ? await native.validateServerLink(link.trim())
        : await fetch(link.trim()).then((response) => {
            if (!response.ok)
              throw new Error(t("set.server.invalid"));
            return response.json();
          });
      preference.set("pssst.connection-link", link.trim());
      setConnection(
        t("set.server.ok", { model: result.capabilities.whisper_model }),
      );
    } catch (error) {
      setConnection(
        error instanceof Error ? error.message : t("set.server.failed"),
      );
    }
  };
  const save = async () => {
    preference.set("pssst.openrouter-model", model.trim());
    preference.set("pssst.openrouter-api-key", apiKey.trim());
    preference.set("pssst.transcription-mode", mode);
    preference.set("pssst.account-name", accountName);
    preference.set("pssst.account-email", accountEmail);
    if (isTauri()) {
      try {
        await native.saveOpenRouterConfig(apiKey.trim(), model.trim());
      } catch (error) {
        console.error("Failed to persist OpenRouter config", error);
      }
    }
    setAccountSaved(true);
    window.setTimeout(() => setAccountSaved(false), 1800);
  };
  const clearAccount = () => {
    try {
      window.localStorage?.removeItem("pssst.account-name");
      window.localStorage?.removeItem("pssst.account-email");
    } catch {
      /* storage unavailable in test/preview */
    }
    setAccountName("");
    setAccountEmail("");
    setAccountSaved(false);
  };
  const install = "curl -fsSL https://irisla.com/pssst/install.sh | sudo bash";
  return (
    <main className="settings-page">
      <div>
        <p className="eyebrow">{t("set.eyebrow")}</p>
        <h1>
          {t("set.titleA")}
          <br />
          <em>{t("set.titleB")}</em>
        </h1>
        <small className="app-version">Pssst v0.12.28</small>
      </div>
      <section className="settings-form">
        <section className="settings-section account-section">
          <div className="settings-section-heading">
            <div>
              <p className="eyebrow">{t("set.account.eyebrow")}</p>
              <h2>{t("set.account.title")}</h2>
            </div>
            <span className="account-badge">{t("set.account.badge")}</span>
          </div>
          <p className="settings-copy">{t("set.account.copy")}</p>
          <div className="settings-grid">
            <label>
              {t("set.account.name")}
              <input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder={t("set.account.namePh")} />
            </label>
            <label>
              {t("set.account.email")}
              <input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} placeholder="vous@exemple.fr" />
            </label>
          </div>
          <div className="account-actions">
            <button className="quiet-button" onClick={clearAccount}>{t("set.account.clear")}</button>
            {accountSaved && <span className="saved-state">{t("set.account.saved")}</span>}
          </div>
        </section>
        <label>
          {t("set.language")}
          <select
            value={lang}
            onChange={(event) => setLang(event.target.value as Lang)}
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {t("set.transcription")}
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="automatic">{t("set.transcription.auto")}</option>
            <option value="local">{t("set.transcription.local")}</option>
            <option value="server">{t("set.transcription.server")}</option>
          </select>
          <small>{t("set.transcription.note")}</small>
        </label>
        {mode === "server" && (
          <>
            <div className="server-setup-note">
              <strong>{t("set.server.note.title")}</strong>
              <small>{t("set.server.note.copy")}</small>
              <div className="command-box settings-command-box">
                <code>{install}</code>
                <button
                  className="copy-icon"
                  aria-label={t("onb.copyCmd")}
                  title={copied ? t("onb.copiedCmd") : t("onb.copyCmd")}
                  onClick={() => { navigator.clipboard?.writeText(install); setCopied(true); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </button>
              </div>
            </div>
            <label>
              <strong>Connection link</strong>
              <input
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://my-server/connect/…"
              />
            </label>
            <button className="record-button" onClick={connect}>
              {t("set.server.connect")}
            </button>
            {connection && (
              <p className="availability-note">
                <span>✓</span>
                {connection}
              </p>
            )}
          </>
        )}
        <section className="settings-section">
          <div className="settings-section-heading">
            <div>
              <p className="eyebrow">{t("set.ai.eyebrow")}</p>
              <h2>OpenRouter</h2>
            </div>
            <span className="account-badge">{t("set.ai.badge")}</span>
          </div>
          <p className="settings-copy">{t("set.ai.copy")}</p>
          <div className="settings-grid">
            <label>
              {t("set.ai.key")}
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-or-v1-..."
                spellCheck={false}
              />
            </label>
            <label>
              {t("set.ai.model")}
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="openai/gpt-4o-mini"
                spellCheck={false}
              />
            </label>
          </div>
        </section>
        <label className="settings-switch">
          {t("set.micDefault")}
          <input type="checkbox" defaultChecked />
        </label>
        <label>
          {t("set.folder")}
          <input defaultValue={t("set.folder.value")} readOnly />
        </label>
        <button className="record-button" onClick={save}>
          {t("set.save")}
        </button>
        <section className="settings-section">
          <div className="settings-section-heading">
            <div>
              <p className="eyebrow">{t("set.credits.eyebrow")}</p>
              <h2>Made by Irisla</h2>
            </div>
          </div>
          <p className="settings-copy">{t("set.credits.copy")}</p>
          <div className="credits-links">
            <ExternalLink href="https://irisla.com">irisla.com</ExternalLink>
            <ExternalLink href="https://wa.me/50942404646">WhatsApp · +509 42 40 4646</ExternalLink>
            <ExternalLink href="https://instagram.com/irislahq">Instagram · @irislahq</ExternalLink>
            <ExternalLink href="https://tiktok.com/@irislahq">TikTok · @irislahq</ExternalLink>
          </div>
        </section>
      </section>
    </main>
  );
}
async function invokeTrack(sessionId: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("recording_track_path", {
    sessionId,
    track: "application",
  });
}

export default function App() {
  const [view, setView] = useState<View>("setup");
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(null);
  const [sessions, setSessions] = useState<RecordingSnapshot[]>([]);
  const [prefill, setPrefill] = useState<{
    course: string;
    appId?: string | null;
    mic?: boolean;
  }>({
    course: preference.get("pssst.last-course") || "",
    appId: preference.get("pssst.last-app-id") || null,
    mic: true,
  });
  const [onboarding, setOnboarding] = useState(
    () =>
      preference.get("pssst.onboarding-complete") !== "true" &&
      typeof window.localStorage !== "undefined",
  );
  const refreshLibrary = async () => {
    if (!isTauri()) return;
    const list = await native.list();
    setSessions(list);
  };
  useEffect(() => {
    refreshLibrary().catch(() => undefined);
    const savedLink = preference.get("pssst.connection-link");
    if (savedLink && isTauri()) {
      native.validateServerLink(savedLink.trim()).catch(() => undefined);
    }
  }, []);

  const continueCourse = async (
    course: string,
    appId?: string | null,
    mic?: boolean,
  ) => {
    const useMic = mic ?? true;
    preference.set("pssst.last-course", course.trim());
    if (appId) preference.set("pssst.last-app-id", appId);
    // Non-Tauri preview: fall back to the setup form.
    if (!isTauri()) {
      setPrefill({ course, appId, mic: useMic });
      setView("setup");
      return;
    }
    try {
      const applications = await native.applications();
      const found = applications.find((a) => a.id === appId && a.available);
      if (!found) {
        // Application no longer running/available: guide via setup.
        setPrefill({ course, appId, mic: useMic });
        setView("setup");
        return;
      }
      const current = await native.start(course, found, useMic);
      setSnapshot(current);
      setView("recording");
      await refreshLibrary();
    } catch {
      // Capture failed: let the user adjust in setup instead of a dead end.
      setPrefill({ course, appId, mic: useMic });
      setView("setup");
    }
  };

  const start = async (source: UiSource, course: string, mic: boolean) => {
    preference.set("pssst.last-course", course.trim());
    preference.set("pssst.last-app-id", source.id);
    if (!isTauri()) {
      const now = new Date().toISOString();
      setSnapshot({
        elapsed_seconds: 0,
        session: {
          id: "preview-session",
          course,
          started_at: now,
          ended_at: null,
          recording_state: "recording",
          selected_application: source.native,
          microphone_included: mic,
          tracks: [],
          transcription_state: "not_started",
          correction_state: "not_started",
          last_error: null,
          transcript_segments: [],
        },
      });
      setView("recording");
      return;
    }
    const current = await native.start(course, source.native, mic);
    setSnapshot(current);
    setView("recording");
    await refreshLibrary();
  };
  const stop = async () => {
    if (!snapshot) return;
    const final = isTauri()
      ? await native.stop(snapshot.session.id)
      : {
          ...snapshot,
          session: {
            ...snapshot.session,
            recording_state: "stopped",
            ended_at: new Date().toISOString(),
          },
        };
    setSnapshot(final);
    setView("finalizing");
    await refreshLibrary();
  };
  const open = (item: RecordingSnapshot) => {
    setSnapshot(item);
    setView("detail");
  };
  if (onboarding)
    return (
      <div className="app-shell product-shell">
        <Onboarding finish={() => setOnboarding(false)} />
      </div>
    );
  return (
    <div className="app-shell product-shell">
      <Header view={view} setView={setView} />
      <div key={view} className="view-transition">
        {view === "setup" && (
          <Setup
            start={start}
            initialCourse={prefill.course}
            initialAppId={prefill.appId}
            initialMic={prefill.mic ?? true}
            courseSuggestions={Array.from(
              new Set(sessions.map((s) => s.session.course).filter(Boolean)),
            )}
          />
        )}
        {view === "recording" && snapshot && (
          <Recording snapshot={snapshot} stop={stop} />
        )}
        {view === "finalizing" && snapshot && (
          <Finalizing snapshot={snapshot} open={() => setView("detail")} />
        )}
        {view === "library" && (
          <Library
            sessions={sessions}
            open={open}
            setup={() => {
              setPrefill({
                course: preference.get("pssst.last-course") || "",
                appId: preference.get("pssst.last-app-id") || null,
                mic: true,
              });
              setView("setup");
            }}
          />
        )}
        {view === "detail" && snapshot && (
          <Detail
            snapshot={snapshot}
            continueCourse={continueCourse}
            onBack={() => setView("library")}
          />
        )}
        {view === "settings" && <Settings />}
      </div>
    </div>
  );
}
