// GitHub / GitLab accounts in Settings › Version Control.
// Git commands Haze runs (push, pull, fetch…) use them for their servers; tokens stay in the OS keychain.
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronRight, Copy, ExternalLink, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, type DeviceCode, type GitAccount, type GitProvider } from "../lib/ipc";
import { toast } from "./Overlays";
import { PageHeader } from "./SettingsDialog";

/** The providers' marks, in one colour (`currentColor`) like the rest of the UI. */
function ProviderMark({ provider, size = 16 }: { provider: GitProvider; size?: number }) {
  return (
    <svg className="git-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {provider === "github" ? (
        <path
          fill="currentColor"
          d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        />
      ) : (
        <path
          fill="currentColor"
          d="m23.6 9.593-.034-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.538L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003z"
        />
      )}
    </svg>
  );
}

interface ProviderInfo {
  name: string;
  server: string;
  /** github.com / gitlab.com, and the other kind of server. */
  cloud: string;
  selfHosted: string;
  serverPlaceholder: string;
  tokenScopes: string[];
  tokenNote?: string;
  tokenPlaceholder: string;
  tokenUrl: (server: string) => string;
  appIdLabel: string;
  appSteps: ReactNode[];
  appUrl: (server: string) => string;
}

const PROVIDERS: Record<GitProvider, ProviderInfo> = {
  github: {
    name: "GitHub",
    server: "https://github.com",
    cloud: "GitHub.com",
    selfHosted: "GitHub Enterprise",
    serverPlaceholder: "https://github.example.com",
    tokenScopes: ["repo", "workflow", "read:org", "gist"],
    tokenNote: "Fine-grained tokens need Contents: read and write.",
    tokenPlaceholder: "ghp_… or github_pat_…",
    tokenUrl: (s) => `${s}/settings/tokens/new?description=Haze&scopes=repo,workflow,read:org,gist`,
    appIdLabel: "Client ID",
    appSteps: [
      <>On the server, open Settings › Developer settings › OAuth Apps › New OAuth App.</>,
      <>
        Any homepage and callback URL; tick <b>Enable Device Flow</b>.
      </>,
      <>Paste its Client ID here (not the secret).</>,
    ],
    appUrl: (s) => `${s}/settings/applications/new`,
  },
  gitlab: {
    name: "GitLab",
    server: "https://gitlab.com",
    cloud: "GitLab.com",
    selfHosted: "Self-managed",
    serverPlaceholder: "https://gitlab.example.com",
    tokenScopes: ["api", "read_user"],
    tokenPlaceholder: "glpat-…",
    tokenUrl: (s) => `${s}/-/user_settings/personal_access_tokens?name=Haze&scopes=api,read_user`,
    appIdLabel: "Application ID",
    appSteps: [
      <>On the server, open User Settings › Applications › Add new application (GitLab 17.9 or later).</>,
      <>
        Any redirect URI; untick <b>Confidential</b>, enable the <b>device authorization grant</b>, scopes <code>api</code> and{" "}
        <code>read_user</code>.
      </>,
      <>Paste its Application ID here (not the secret).</>,
    ],
    appUrl: (s) => `${s}/-/user_settings/applications`,
  },
};

function normalizeServer(server: string): string {
  const s = server.trim().replace(/\/+$/, "");
  return s.includes("://") ? s : `https://${s}`;
}

const hostOf = (url: string) => url.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");

/** git's messages when a remote rejects or cannot get credentials over HTTPS. */
const AUTH_FAILURE =
  /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i;

export function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}

/** The code to type in the browser while Haze waits for the authorization. */
function DevicePanel({ provider, device, onCancel }: { provider: GitProvider; device: DeviceCode; onCancel: () => void }) {
  const p = PROVIDERS[provider];
  const [copied, setCopied] = useState(false);
  const page = device.verificationUriComplete ?? device.verificationUri;
  const copy = async () => {
    await navigator.clipboard.writeText(device.userCode).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="git-login">
      <div className="git-login-head">
        <ProviderMark provider={provider} size={18} />
        <b>Authorize Haze on {p.name}</b>
        <span className="run-spacer" />
        <button className="icon-btn" title="Cancel" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      <div className="git-login-lead">
        {device.verificationUriComplete
          ? "Check that the page that opened in your browser shows this code, then authorize Haze:"
          : "Enter this code on the page that opened in your browser (it is on the clipboard):"}
      </div>
      <div className="git-device">
        <span className="git-device-code">{device.userCode}</span>
        <button className="icon-btn" title="Copy the code" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="git-login-row">
        <LoaderCircle size={13} className="spin muted" />
        <span className="muted small">Waiting for you to authorize Haze on {hostOf(page)}…</span>
        <span className="run-spacer" />
        <button className="btn small" onClick={() => void openUrl(page)}>
          <ExternalLink size={12} /> Open Page Again
        </button>
        <button className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LoginForm({
  provider,
  builtInId,
  onDone,
}: {
  provider: GitProvider;
  /** The OAuth app built in for github.com / gitlab.com, if any. */
  builtInId: string | null;
  onDone: () => void;
}) {
  const p = PROVIDERS[provider];
  const [selfHosted, setSelfHosted] = useState(false);
  const [customServer, setCustomServer] = useState("");
  const [appId, setAppId] = useState("");
  const [token, setToken] = useState("");
  // The token form starts open only when the browser cannot be used without setup.
  const [tokenOpen, setTokenOpen] = useState(!builtInId);
  const [busy, setBusy] = useState<"browser" | "token" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  // Cancel can be clicked before polling starts, which a backend cancel would miss.
  const cancelled = useRef(false);
  const server = selfHosted ? normalizeServer(customServer) : p.server;
  const serverOk = !selfHosted || /^https?:\/\/[^/\s]+/.test(server);
  // The app built in on github.com / gitlab.com; elsewhere (GitHub
  // Enterprise, self-managed GitLab) an OAuth app the user registered there.
  const needsAppId = selfHosted || !builtInId;

  // Stop waiting for the browser when the form goes away.
  useEffect(
    () => () => {
      cancelled.current = true;
      void api.gitDeviceCancel();
    },
    [],
  );
  const cancelDevice = () => {
    cancelled.current = true;
    void api.gitDeviceCancel();
    setDevice(null);
  };

  const done = (a: GitAccount) => {
    toast(`Logged in to ${p.name} as ${a.login}`);
    onDone();
  };
  const loginWithToken = async () => {
    setBusy("token");
    setError(null);
    try {
      done(await api.gitAccountLogin(provider, server, token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const loginViaBrowser = async () => {
    setBusy("browser");
    setError(null);
    cancelled.current = false;
    try {
      const code = await api.gitDeviceStart(provider, server, needsAppId ? appId : "");
      if (cancelled.current) return;
      setDevice(code);
      await navigator.clipboard.writeText(code.userCode).catch(() => {});
      await openUrl(code.verificationUriComplete ?? code.verificationUri);
      if (cancelled.current) return;
      done(await api.gitDevicePoll(code));
    } catch (e) {
      if (!cancelled.current) setError(errorMessage(e));
      setDevice(null);
    } finally {
      setBusy(null);
    }
  };

  if (device) return <DevicePanel provider={provider} device={device} onCancel={cancelDevice} />;

  const canBrowser = !busy && serverOk && (!needsAppId || !!appId.trim());
  const canToken = !busy && serverOk && !!token.trim();
  return (
    <div className="git-login">
      <div className="git-login-head">
        <ProviderMark provider={provider} size={18} />
        <b>Add {p.name} account</b>
        <span className="run-spacer" />
        <button className="icon-btn" title="Cancel" onClick={onDone}>
          <X size={14} />
        </button>
      </div>

      <div className="seg git-login-seg">
        {[false, true].map((self) => (
          <button
            key={String(self)}
            className={"seg-btn" + (selfHosted === self ? " on" : "")}
            onClick={() => (setSelfHosted(self), setError(null))}
          >
            {self ? p.selfHosted : p.cloud}
          </button>
        ))}
      </div>

      {selfHosted && (
        <label className="git-field">
          <span>Server</span>
          <input
            className="modal-input"
            autoFocus
            value={customServer}
            spellCheck={false}
            placeholder={p.serverPlaceholder}
            onChange={(e) => setCustomServer(e.target.value)}
          />
        </label>
      )}

      <section className="git-login-method">
        {needsAppId && (
          <>
            <label className="git-field">
              <span>{p.appIdLabel}</span>
              <input
                className="modal-input"
                value={appId}
                spellCheck={false}
                placeholder={`OAuth app on ${selfHosted ? "the server" : hostOf(p.server)}`}
                onChange={(e) => setAppId(e.target.value)}
              />
            </label>
            <ol className="git-steps muted small">
              {p.appSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {serverOk && (selfHosted ? !!customServer.trim() : true) && (
              <button className="git-link small" onClick={() => void openUrl(p.appUrl(server))}>
                Open the OAuth apps page <ExternalLink size={11} />
              </button>
            )}
          </>
        )}
        <button className="btn primary git-login-browser" disabled={!canBrowser} onClick={() => void loginViaBrowser()}>
          {busy === "browser" ? <LoaderCircle size={14} className="spin" /> : <ProviderMark provider={provider} size={14} />}
          Log In via {p.name}…
        </button>
        <div className="muted small git-login-note">
          Opens {selfHosted && customServer.trim() ? hostOf(server) : hostOf(p.server)} in your browser. Haze never sees your
          password; the token it gets stays in the system keychain.
        </div>
      </section>

      <div className="git-login-or">
        <span>or</span>
      </div>

      <section className="git-login-method">
        <button className="git-disclosure" aria-expanded={tokenOpen} onClick={() => setTokenOpen((o) => !o)}>
          <ChevronRight size={13} className="chev" />
          Use a personal access token
        </button>
        {tokenOpen && (
          <>
            <div className="git-login-token">
              <input
                className="modal-input"
                type="password"
                autoFocus={!builtInId}
                value={token}
                spellCheck={false}
                placeholder={p.tokenPlaceholder}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canToken && void loginWithToken()}
              />
              <button
                className="btn small"
                title="Create a token on the server with the scopes Haze needs"
                disabled={!serverOk || (selfHosted && !customServer.trim())}
                onClick={() => void openUrl(p.tokenUrl(server))}
              >
                Generate… <ExternalLink size={11} />
              </button>
              <button className="btn small primary" disabled={!canToken} onClick={() => void loginWithToken()}>
                {busy === "token" && <LoaderCircle size={12} className="spin" />}
                {busy === "token" ? "Checking…" : "Log In"}
              </button>
            </div>
            <div className="muted small">
              Scopes:{" "}
              {p.tokenScopes.map((s) => (
                <code key={s} className="git-scope">
                  {s}
                </code>
              ))}
              {p.tokenNote && ` ${p.tokenNote}`}
            </div>
          </>
        )}
      </section>

      {error && <div className="modal-error git-login-error">{error}</div>}
    </div>
  );
}

export function GitAccountsSection() {
  const [accounts, setAccounts] = useState<GitAccount[] | null>(null);
  const [builtInIds, setBuiltInIds] = useState<Record<GitProvider, string | null>>({ github: null, gitlab: null });
  const [adding, setAdding] = useState<GitProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api.gitAccounts().then(
      (i) => {
        setAccounts(i.accounts);
        setBuiltInIds({ github: i.githubClientId, gitlab: i.gitlabClientId });
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => void reload(), []);

  const remove = async (a: GitAccount) => {
    try {
      await api.gitAccountRemove(a.id);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    void reload();
  };

  return (
    <>
      <PageHeader
        title="Version Control"
        desc="GitHub / GitLab accounts. Push, pull and fetch over HTTPS use them for their servers. Tokens are kept in the system keychain. One account per server."
      />
      {accounts && accounts.length > 0 && (
        <div className="settings-card">
          {accounts.map((a) => (
            <div key={a.id} className="settings-agent-head git-account">
              {a.avatarUrl ? <img className="git-avatar" src={a.avatarUrl} alt="" /> : <span className="git-avatar" />}
              <b>{a.login}</b>
              {a.name && <span className="muted">{a.name}</span>}
              <span className="git-account-host muted small">
                <ProviderMark provider={a.provider} size={12} />
                {hostOf(a.server)}
              </span>
              <span className="run-spacer" />
              <button className="btn small" onClick={() => void remove(a)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {accounts?.length === 0 && !adding && <div className="settings-empty muted small">No accounts yet.</div>}
      {adding ? (
        <LoginForm
          key={adding}
          provider={adding}
          builtInId={builtInIds[adding]}
          onDone={() => {
            setAdding(null);
            void reload();
          }}
        />
      ) : (
        <div className="settings-agent-head">
          {(["github", "gitlab"] as const).map((pr) => (
            <button key={pr} className="btn small" onClick={() => setAdding(pr)}>
              <ProviderMark provider={pr} size={13} />
              Add {PROVIDERS[pr].name} Account…
            </button>
          ))}
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
