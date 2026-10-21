// GitHub / GitLab accounts in Settings, like Rider's Settings | Version Control | GitHub / GitLab.
// Git commands Haze runs (push, pull, fetch…) use them for their servers; tokens stay in the OS keychain.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type DeviceCode, type GitAccount, type GitProvider } from "../lib/ipc";
import { toast } from "./Overlays";
import { PageHeader } from "./SettingsDialog";

const PROVIDERS: Record<GitProvider, { name: string; server: string; tokenHelp: string; tokenUrl: (server: string) => string }> = {
  github: {
    name: "GitHub",
    server: "https://github.com",
    tokenHelp: "Scopes: repo, workflow, read:org, gist. Fine-grained tokens need Contents read/write.",
    tokenUrl: (s) => `${s}/settings/tokens/new?description=Haze&scopes=repo,workflow,read:org,gist`,
  },
  gitlab: {
    name: "GitLab",
    server: "https://gitlab.com",
    tokenHelp: "Scopes: api, read_user.",
    tokenUrl: (s) => `${s}/-/user_settings/personal_access_tokens?name=Haze&scopes=api,read_user`,
  },
};

function normalizeServer(server: string): string {
  const s = server.trim().replace(/\/+$/, "");
  return s.includes("://") ? s : `https://${s}`;
}

/** git's messages when a remote rejects or cannot get credentials over HTTPS. */
const AUTH_FAILURE =
  /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i;

export function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}

function LoginForm({ provider, githubOauth, onDone }: { provider: GitProvider; githubOauth: boolean; onDone: () => void }) {
  const p = PROVIDERS[provider];
  const [server, setServer] = useState(p.server);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  // Cancel can be clicked before polling starts, which a backend cancel would miss.
  const cancelled = useRef(false);
  const isDotCom = normalizeServer(server) === p.server;

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
    setBusy(true);
    setError(null);
    try {
      done(await api.gitAccountLogin(provider, server, token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const loginViaBrowser = async () => {
    setBusy(true);
    setError(null);
    cancelled.current = false;
    try {
      const code = await api.gitDeviceStart();
      if (cancelled.current) return;
      setDevice(code);
      await navigator.clipboard.writeText(code.userCode).catch(() => {});
      await openUrl(code.verificationUri);
      if (cancelled.current) return;
      done(await api.gitDevicePoll(code));
    } catch (e) {
      if (!cancelled.current) setError(errorMessage(e));
      setDevice(null);
    } finally {
      setBusy(false);
    }
  };

  if (device)
    return (
      <div className="settings-agent">
        <div>
          Enter this code on the GitHub page that opened in your browser (it is copied to the clipboard):
        </div>
        <div className="git-device-code">{device.userCode}</div>
        <div className="settings-agent-head">
          <span className="muted small">Waiting for you to authorize Haze…</span>
          <span className="run-spacer" />
          <button className="btn small" onClick={() => void openUrl(device.verificationUri)}>
            Open Page Again
          </button>
          <button className="btn small" onClick={cancelDevice}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="settings-agent">
      <div className="settings-agent-head">
        <b>Add {p.name} account</b>
        <span className="run-spacer" />
        <button className="btn small" onClick={onDone}>
          Cancel
        </button>
      </div>
      {provider === "github" && githubOauth && (
        <>
          <button className="btn primary" disabled={busy} onClick={() => void loginViaBrowser()}>
            Log In via GitHub…
          </button>
          <div className="muted small">Or use a token (also for GitHub Enterprise):</div>
        </>
      )}
      <div className="git-login-grid">
        <span>Server</span>
        <input className="modal-input" value={server} spellCheck={false} onChange={(e) => setServer(e.target.value)} />
        <span>Token</span>
        <div className="git-login-token">
          <input
            className="modal-input"
            type="password"
            autoFocus={!(provider === "github" && githubOauth)}
            value={token}
            spellCheck={false}
            placeholder={provider === "github" ? "ghp_… or github_pat_…" : "glpat-…"}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && void loginWithToken()}
          />
          <button className="btn small" title="Create a token on the server with the scopes Haze needs" onClick={() => void openUrl(p.tokenUrl(normalizeServer(server)))}>
            Generate…
          </button>
        </div>
      </div>
      <div className="muted small">
        {p.tokenHelp}
        {!isDotCom && provider === "github" && " For GitHub Enterprise, enter its address, e.g. https://github.example.com."}
      </div>
      {error && <div className="modal-error">{error}</div>}
      <div className="settings-agent-head">
        <span className="run-spacer" />
        <button className="btn small primary" disabled={busy || !token.trim() || !server.trim()} onClick={() => void loginWithToken()}>
          {busy ? "Checking…" : "Log In"}
        </button>
      </div>
    </div>
  );
}

export function GitAccountsSection() {
  const [accounts, setAccounts] = useState<GitAccount[] | null>(null);
  const [githubOauth, setGithubOauth] = useState(false);
  const [adding, setAdding] = useState<GitProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api.gitAccounts().then(
      (i) => {
        setAccounts(i.accounts);
        setGithubOauth(i.githubOauth);
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
              <span className="tag">{PROVIDERS[a.provider].name}</span>
              <span className="muted small">{a.server.replace(/^https:\/\//, "")}</span>
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
          githubOauth={githubOauth}
          onDone={() => {
            setAdding(null);
            void reload();
          }}
        />
      ) : (
        <div className="settings-agent-head">
          <button className="btn small" onClick={() => setAdding("github")}>
            Add GitHub Account…
          </button>
          <button className="btn small" onClick={() => setAdding("gitlab")}>
            Add GitLab Account…
          </button>
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
