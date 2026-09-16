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

const fallback: UiSource[] = [
  {
    id: "zoom",
    name: "Zoom Workplace",
    detail: "Réunion en cours",
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
    detail: "Application fermée",
    available: false,
    native: {
      id: "safari",
      name: "Safari",
      icon_hint: "com.apple.Safari",
      available: false,
    },
  },
];
const previewLines = [
  "Donc si on prend la mémoire cache comme exemple, on a une hiérarchie.",
  "Le processeur ne va pas chercher directement dans la RAM à chaque fois.",
  "Et là vous avez une ligne de cache, euh, qui contient plusieurs octets.",
];
const formatTime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const formatDate = (date: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(
    new Date(date),
  );
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
  return (
    <header className="app-header product-header">
      <button className="brand brand-button" onClick={() => setView("setup")}>
        <Logo />
        <span className="sr-only">Pssst</span>
      </button>
      <nav aria-label="Navigation principale">
        <button onClick={() => setView("library")}>
          <LibraryIcon size={15} aria-hidden="true" /> Cours
        </button>
        <button onClick={() => setView("settings")}>
          <SettingsIcon size={15} aria-hidden="true" /> Réglages
        </button>
      </nav>
      <div className="ready-status">
        <span /> {view === "recording" ? "En cours" : "Prêt"}
        <small>v0.12.28</small>
      </div>
    </header>
  );
}

function Onboarding({ finish }: { finish: () => void }) {
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
    preference.get("pssst.connection-link") ? "Serveur enregistré" : "",
  );
  const connectServer = async () => {
    const link = serverLink.trim();
    try {
      const url = new URL(link);
      if (!/^https?:$/.test(url.protocol) || !url.pathname.includes("/connect/")) {
        throw new Error("Collez le connection link complet de votre serveur Pssst.");
      }
      const result = isTauri()
        ? await native.validateServerLink(url.toString())
        : await fetch(url.toString()).then(async (response) => {
            if (!response.ok) {
              if (response.status === 401) throw new Error("Ce connection link est invalide ou révoqué.");
              throw new Error(`Le serveur répond avec une erreur (${response.status}).`);
            }
            return response.json();
          });
      if (!result?.capabilities?.faster_whisper) {
        throw new Error("Ce serveur n’est pas un serveur Whisper Pssst.");
      }
      preference.set("pssst.connection-link", url.toString());
      setServerReady(true);
      setServerLink(url.toString());
      setServerError(`Connecté - Whisper ${result.capabilities.whisper_model}`);
    } catch (error) {
      setServerReady(false);
      setServerError(
        error instanceof TypeError
          ? "Impossible de joindre le serveur. Vérifiez son adresse, son port et son accès réseau."
          : error instanceof Error
            ? error.message
            : "Connexion impossible",
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
            <p className="eyebrow">BIENVENUE DANS PSSST</p>
            <h1>
              Souvenez-vous du cours.
              <br />
              <em>Pas de la prise de notes.</em>
            </h1>
            <p>
              pssst enregistre l’audio de votre classe localement et crée une
              transcription fidèle pendant que vous écoutez.
            </p>
          </>
        )}
        {step === 1 && (
          <>
            <p className="eyebrow">COMMENT ÇA MARCHE</p>
            <h1>
              Vous écoutez.
              <br />
              <em>pssst s’occupe du reste.</em>
            </h1>
            <div className="flow-line">
              <span>Audio de la classe</span>
              <b>→</b>
              <span>Enregistré localement</span>
              <b>→</b>
              <span>Whisper</span>
              <b>→</b>
              <span>Correction optionnelle</span>
            </div>
            <p>
              L’enregistrement est toujours sauvegardé sur ce Mac en premier.
              Internet ou la transcription peuvent attendre sans interrompre
              votre cours.
            </p>
          </>
        )}
        {step === 2 && (
          <>
            <p className="eyebrow">TRANSCRIPTION</p>
            <h1>
              Où doit tourner
              <br />
              <em>Whisper ?</em>
            </h1>
            <div className="choice-list">
              {[
                [
                  "automatic",
                  "Automatic — Recommandé",
                  "pssst choisit la meilleure option disponible.",
                ],
                [
                  "local",
                  "On this Mac",
                  "Privé, fonctionne hors ligne. Un modèle Whisper sera téléchargé.",
                ],
                [
                  "server",
                  "My pssst server",
                  "Utilisez votre serveur FastAPI + faster-whisper.",
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
            <p className="eyebrow">CONNEXION SERVEUR</p>
            <h1>
              Connectez votre
              <br />
              <em>serveur pssst.</em>
            </h1>
            <p>
              Vous avez un serveur Linux&nbsp;? Copiez la commande dans son
              terminal, puis collez ici le lien sécurisé qu’il vous donne.
            </p>
            <div className="model-install server-connect-card">
              <strong>1. Installer pssst Whisper</strong>
              <div className="command-box">
                <code>curl -fsSL https://irisla.com/pssst/install.sh | sudo bash</code>
                <button
                  className="copy-icon"
                  aria-label="Copier la commande"
                  title="Copier la commande"
                  onClick={() => navigator.clipboard?.writeText("curl -fsSL https://irisla.com/pssst/install.sh | sudo bash")}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </button>
              </div>
              <label>
                <strong>2. Connection link</strong>
                <input
                  value={serverLink}
                  onChange={(event) => {
                    setServerLink(event.target.value);
                    setServerReady(false);
                    setServerError("");
                  }}
                  placeholder="https://votre-serveur/connect/..."
                  spellCheck={false}
                />
              </label>
              <button className="record-button" onClick={connectServer} disabled={!serverLink.trim()}>
                {serverReady ? "Serveur connecté" : "Connecter"}
              </button>
              {serverError && <small className={serverReady ? "server-success" : "server-error"}>{serverError}</small>}
            </div>
          </>
        )}
        {step === 3 && mode !== "server" && (
          <>
            <p className="eyebrow">WHISPER SUR CE MAC</p>
            <h1>
              Installez Whisper
              <br />
              <em>une seule fois.</em>
            </h1>
            <div className="model-install">
              <strong>Whisper Medium</strong>
              <span>≈ 1,5 Go · très bonne précision en français</span>
              {installed ? (
                <p>✓ Whisper est prêt.</p>
              ) : (
                <button
                  className="record-button"
                  onClick={() => setInstalled(true)}
                >
                  Télécharger et installer
                </button>
              )}
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <p className="eyebrow">VOS PERMISSIONS</p>
            <h1>
              Une dernière
              <br />
              <em>autorisation.</em>
            </h1>
            <div className="permission-list">
              <div>
                <strong>Audio système</strong>
                <small>
                  Nécessaire pour entendre l’application où votre cours se joue.
                </small>
                <button onClick={() => native.requestScreenRecordingAccess()}>
                  Autoriser
                </button>
              </div>
              <div>
                <strong>
                  Microphone <i>Optionnel</i>
                </strong>
                <small>Ajoutez vos propres questions à la transcription.</small>
                <button onClick={() => setPermission(true)}>
                  {permission ? "Autorisé" : "Autoriser"}
                </button>
              </div>
            </div>
          </>
        )}
        {step === 5 && (
          <>
            <p className="eyebrow">TOUT EST PRÊT</p>
            <h1>
              Vous êtes prêt
              <br />
              <em>à écouter.</em>
            </h1>
            <p>
              Ouvrez votre classe, choisissez l’application qui la joue, puis
              appuyez sur Enregistrer.
            </p>
          </>
        )}
      </div>
      <div className="onboarding-actions">
        {step > 0 && (
          <button className="text-button" onClick={() => setStep(step - 1)}>
            Retour
          </button>
        )}
        <button className="record-button" onClick={next}>
          {step === 5 ? "Commencer avec pssst" : "Continuer"}
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
  const [sources, setSources] = useState<UiSource[]>(fallback);
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
        detail: "Application ouverte",
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
        <p className="eyebrow">NOUVEL ENREGISTREMENT</p>
        <h1>
          Prêt à enregistrer
          <br />
          <em>votre cours.</em>
        </h1>
        <p>
          Choisissez la classe, l’application, puis laissez pssst faire le
          reste.
        </p>
      </section>
      <section className="setup-form">
        {permissionDenied ? (
          <section className="permission-card">
            <p className="eyebrow">AUTORISATION REQUISE</p>
            <h3>Autorisez pssst à écouter votre cours.</h3>
            <p>
              macOS bloque l’accès à l’audio des applications tant que
              l’autorisation audio système n’est pas activée.
            </p>
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
              Autoriser dans macOS
            </button>
            <small>
              Activez pssst, puis revenez ici et relancez l’application.
            </small>
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
                  ? "Ajoutez le nom du cours pour commencer."
                  : "Choisissez l’application qui joue votre cours."}
              </p>
            )}
            <div className="action-row">
              <p className="local-note">
                <span>⌁</span> Audio seulement · enregistré localement sur ce Mac
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
                {starting ? "Préparation…" : "Commencer l’enregistrement"}
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
          <p className="eyebrow">EN COURS</p>
          <h2>{session.course}</h2>
          <p className="session-subline">
            <b className="recording-live" /> {formatTime(seconds)} ·{" "}
            {session.selected_application.name}
            {session.microphone_included && " · Micro inclus"}
          </p>
        </div>
        <div className="session-actions">
          <button
            className="network-button"
            onClick={() => setOffline(!offline)}
          >
            {offline ? "Hors ligne — file locale active" : "Connecté"}
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
            {stopping ? "Finalisation…" : "Terminer le cours"}
          </button>
        </div>
      </section>
      <div className="session-health">
        <span>
          <i className="health-dot active" />
          Enregistrement local
        </span>
        <span>
          <i className={`health-dot ${offline ? "delayed" : "waiting"}`} />
          {offline
            ? "Transcription différée"
            : segments.length
              ? "Transcription à jour"
              : "En attente de séquences"}
        </span>
        <span>
          <i className="health-dot waiting" />
          Correction en attente
        </span>
      </div>
      <section className="transcript-stage">
        <div className="transcript-heading">
          <div>
            <h3>Transcription</h3>
            <p>
              {offline
                ? "Les séquences restent dans la file locale."
                : "Les segments apparaissent dès que Whisper les termine."}
            </p>
          </div>
          <button>Aller au direct ↓</button>
        </div>
        <div className="transcript-list">
          {segments.map((segment) => (
            <article className="transcript-segment" key={segment.backend_id}>
              <time>{formatTime(Math.floor(segment.start_ms / 1000))}</time>
              <p>{segment.raw_text}</p>
              <small>{segment.corrected_text ? "Corrigé" : "Brut"}</small>
            </article>
          ))}
          {!segments.length && (
            <article className="transcript-segment waiting">
              <time>{formatTime(seconds)}</time>
              <p>La première séquence est en cours de préparation…</p>
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
  return (
    <main className="finalizing">
      <p className="eyebrow">COURS TERMINÉ</p>
      <h1>
        Votre enregistrement
        <br />
        <em>reste en sécurité.</em>
      </h1>
      <p>
        {snapshot.session.tracks.reduce(
          (sum, track) => sum + track.bytes_written,
          0,
        ) > 44
          ? "Les pistes locales ont été finalisées. La file de transcription peut continuer en arrière-plan."
          : "La session a été sauvegardée. Les derniers octets sont en cours de finalisation."}
      </p>
      <button className="record-button" onClick={open}>
        Voir le cours
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
  return (
    <main className="library-page">
      <div className="library-title">
        <div>
          <p className="eyebrow">VOS COURS</p>
          <h1>
            Ce que vous avez
            <br />
            <em>gardé.</em>
          </h1>
        </div>
        <button className="new-recording" onClick={setup}>
          <Plus size={14} aria-hidden="true" /> Enregistrer un cours
        </button>
      </div>
      <div className="search-line">
        <input placeholder="Rechercher dans vos cours" />
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
                    ? "En cours"
                    : "Local"}
                </small>
              </span>
              <span className="lecture-end-actions">
                <i className="lecture-status">
                  {snapshot.session.recording_state === "recoverable"
                    ? "À récupérer"
                    : snapshot.session.recording_state === "recording"
                      ? "En cours"
                      : "Prêt"}
                </i>
                <b>›</b>
              </span>
            </button>
          ))
        ) : (
          <p className="empty-library">
            Aucun cours enregistré pour le moment.
          </p>
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
      setCorrectionMessage("Correction terminée.");
    } else if (session.correction_state === "failed" && correcting) {
      setCorrecting(false);
      setCorrectionMessage(session.last_error || "Échec de la correction.");
    }
  }, [session.correction_state, session.last_error, correcting]);

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
            setAudioError("Cette session ne contient aucun signal audio enregistré.");
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
  }, [session.id]);
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
          aria-label="Retour aux cours"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Cours</span>
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
            + Continuer ce cours
          </button>
          <div className="audio-player">
            <small>
              {audioUrl ? "Piste locale · prête à écouter" : audioError ? "Piste locale indisponible" : "Préparation de la piste locale…"}
            </small>
            {audioUrl && (
              <audio
                id="lecture-audio"
                src={audioUrl}
                controls
                onError={(event) => {
                  const detail = event.currentTarget.error?.message || "format audio invalide";
                  const message = `Impossible de lire cette piste locale : ${detail}`;
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
              ? "Version finale"
              : item === "corrected"
                ? "Corrigée"
                : "Brute"}
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
                setCorrectionMessage("Correction en cours…");
                try {
                  await native.correctSession(session.id);
                } catch (error) {
                  setCorrecting(false);
                  setCorrectionMessage(String(error));
                }
              }}
            >
              {isCorrecting ? "Correction en cours…" : "Corriger la transcription"}
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
            <p className="pending-copy">
              La file locale prépare la transcription de cette session.
            </p>
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
              <p className="pending-copy">
                La file locale prépare la transcription de cette session.
              </p>
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
  const [mode, setMode] = useState(
    () => localStorage.getItem("pssst.transcription-mode") ?? "automatic",
  );
  const [link, setLink] = useState(
    () => localStorage.getItem("pssst.connection-link") ?? "",
  );
  const [connection, setConnection] = useState("");
  const [copied, setCopied] = useState(false);
  const [model, setModel] = useState(
    () => localStorage.getItem("pssst.openrouter-model") ?? "openai/gpt-4o-mini",
  );
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("pssst.openrouter-api-key") ?? "",
  );
  const [accountName, setAccountName] = useState(
    () => localStorage.getItem("pssst.account-name") ?? "",
  );
  const [accountEmail, setAccountEmail] = useState(
    () => localStorage.getItem("pssst.account-email") ?? "",
  );
  const [accountSaved, setAccountSaved] = useState(false);
  const connect = async () => {
    try {
      const result = isTauri()
        ? await native.validateServerLink(link.trim())
        : await fetch(link.trim()).then((response) => {
            if (!response.ok)
              throw new Error("Lien invalide ou serveur indisponible");
            return response.json();
          });
      localStorage.setItem("pssst.connection-link", link.trim());
      setConnection(
        `Connecté · faster-whisper · ${result.capabilities.whisper_model}`,
      );
    } catch (error) {
      setConnection(
        error instanceof Error ? error.message : "Connexion impossible",
      );
    }
  };
  const save = async () => {
    localStorage.setItem("pssst.openrouter-model", model.trim());
    localStorage.setItem("pssst.openrouter-api-key", apiKey.trim());
    localStorage.setItem("pssst.transcription-mode", mode);
    localStorage.setItem("pssst.account-name", accountName);
    localStorage.setItem("pssst.account-email", accountEmail);
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
    localStorage.removeItem("pssst.account-name");
    localStorage.removeItem("pssst.account-email");
    setAccountName("");
    setAccountEmail("");
    setAccountSaved(false);
  };
  const install = "curl -fsSL https://irisla.com/pssst/install.sh | sudo bash";
  return (
    <main className="settings-page">
      <div>
        <p className="eyebrow">RÉGLAGES</p>
        <h1>
          À votre
          <br />
          <em>manière.</em>
        </h1>
        <small className="app-version">Pssst v0.12.28</small>
      </div>
      <section className="settings-form">
        <section className="settings-section account-section">
          <div className="settings-section-heading">
            <div>
              <p className="eyebrow">COMPTE</p>
              <h2>Votre espace Pssst</h2>
            </div>
            <span className="account-badge">Sur ce Mac</span>
          </div>
          <p className="settings-copy">Gardez vos préférences et vos cours identifiables sans envoyer vos enregistrements ailleurs.</p>
          <div className="settings-grid">
            <label>
              Nom
              <input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Votre nom" />
            </label>
            <label>
              Adresse e-mail
              <input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} placeholder="vous@exemple.fr" />
            </label>
          </div>
          <div className="account-actions">
            <button className="quiet-button" onClick={clearAccount}>Effacer le profil</button>
            {accountSaved && <span className="saved-state">Profil enregistré</span>}
          </div>
        </section>
        <label>
          Transcription
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="automatic">Automatique — Recommandé</option>
            <option value="local">Sur ce Mac</option>
            <option value="server">Mon serveur</option>
          </select>
          <small>
            L’enregistrement local reste prioritaire dans tous les modes.
          </small>
        </label>
        {mode === "server" && (
          <>
            <div className="server-setup-note">
              <strong>Vous avez un serveur Linux&nbsp;?</strong>
              <small>Copiez cette commande dans son terminal, puis collez ici le lien qu’il vous donne.</small>
              <div className="command-box settings-command-box">
                <code>{install}</code>
                <button
                  className="copy-icon"
                  aria-label="Copier la commande"
                  title={copied ? "Commande copiée" : "Copier la commande"}
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
                placeholder="https://mon-serveur/connect/…"
              />
            </label>
            <button className="record-button" onClick={connect}>
              Connecter
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
              <p className="eyebrow">CORRECTION IA</p>
              <h2>OpenRouter</h2>
            </div>
            <span className="account-badge">Optionnel</span>
          </div>
          <p className="settings-copy">
            Corrige automatiquement la grammaire et la ponctuation du texte transcrit sans modifier l’enregistrement brut.
          </p>
          <div className="settings-grid">
            <label>
              Clé API OpenRouter
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-or-v1-..."
                spellCheck={false}
              />
            </label>
            <label>
              Modèle
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
          Inclure mon micro par défaut
          <input type="checkbox" defaultChecked />
        </label>
        <label>
          Dossier des enregistrements
          <input defaultValue="Données pssst / recordings" readOnly />
        </label>
        <button className="record-button" onClick={save}>
          Enregistrer les modifications
        </button>
        <section className="settings-section">
          <div className="settings-section-heading">
            <div>
              <p className="eyebrow">CRÉDITS</p>
              <h2>Made by Irisla</h2>
            </div>
          </div>
          <p className="settings-copy">
            Pssst est conçu et développé par Irisla.
          </p>
          <div className="credits-links">
            <ExternalLink href="https://irisla.com">irisla.com</ExternalLink>
            <ExternalLink href="https://wa.me/50942404646">WhatsApp · +509 42 40 4646</ExternalLink>
            <ExternalLink href="https://instagram.com/irislhq">Instagram · @irislhq</ExternalLink>
            <ExternalLink href="https://tiktok.com/@irislhq">TikTok · @irislhq</ExternalLink>
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
