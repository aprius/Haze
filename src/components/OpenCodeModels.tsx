// Model providers for OpenCode in Settings › AI Models: keys for the providers OpenCode knows, and custom providers
// (Ollama, LM Studio, OpenAI- or Anthropic-compatible endpoints, a proxy…). Written to OpenCode's global config; keys go to files only the user can read.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api, errorMessage, type OpenCodeConfig, type OpenCodeProvider } from "../lib/ipc";
import { confirmAction, toast } from "./Overlays";
import { PageHeader } from "./SettingsDialog";

const COMPATIBLE = "@ai-sdk/openai-compatible";

/** The API a custom provider speaks: the AI SDK package OpenCode loads for it. */
const API_TYPES: { npm: string; name: string; hint: string; placeholder: string }[] = [
  {
    npm: COMPATIBLE,
    name: "OpenAI-compatible",
    hint: "Chat Completions (/chat/completions): Ollama, LM Studio, vLLM, LiteLLM, most hosted models and proxies.",
    placeholder: "https://api.example.com/v1",
  },
  {
    npm: "@ai-sdk/anthropic",
    name: "Anthropic-compatible",
    hint: "Anthropic's Messages API (/messages), e.g. a Claude proxy or a provider's Anthropic endpoint. The address usually ends in /v1.",
    placeholder: "https://api.example.com/anthropic/v1",
  },
  {
    npm: "@ai-sdk/openai",
    name: "OpenAI Responses",
    hint: "OpenAI's Responses API (/responses), e.g. Azure OpenAI or an OpenAI proxy.",
    placeholder: "https://api.example.com/v1",
  },
];

interface Preset {
  id: string;
  name: string;
  /** Where to create a key, for providers OpenCode knows. */
  keyUrl?: string;
  /** A local server: a custom provider with this address. */
  baseUrl?: string;
}

const PRESETS: Preset[] = [
  { id: "anthropic", name: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", name: "xAI", keyUrl: "https://console.x.ai" },
  { id: "groq", name: "Groq", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
];

const presetOf = (id: string) => PRESETS.find((p) => p.id === id);

/** A custom provider (API type, address and models set here); others only get a key here, keeping what was set by hand. */
const isCustom = (p: OpenCodeProvider) => !!p.npm || !!presetOf(p.id)?.baseUrl || (!!p.baseUrl && !presetOf(p.id));

function keyLabel(p: OpenCodeProvider): string {
  switch (p.key) {
    case "haze":
      return "Key saved";
    case "env":
      return `$${p.keyEnv}`;
    case "file":
      return "Key file";
    case "inline":
      return "Key in config";
    default:
      return "No key here";
  }
}

/** Model ids to tick: the provider's own, those fetched from the server, and any typed in. */
function ModelPicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: Set<string>;
  onChange: (available: string[], selected: Set<string>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [typed, setTyped] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query ? available.filter((m) => m.toLowerCase().includes(query)) : available;
  const toggle = (m: string) => {
    const next = new Set(selected);
    if (!next.delete(m)) next.add(m);
    onChange(available, next);
  };
  // All or none of the models shown (the filter narrows it).
  const setShown = (on: boolean) => {
    const next = new Set(selected);
    for (const m of shown) {
      if (on) next.add(m);
      else next.delete(m);
    }
    onChange(available, next);
  };
  const add = () => {
    const ids = typed.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) return;
    onChange([...new Set([...available, ...ids])], new Set([...selected, ...ids]));
    setTyped("");
  };
  return (
    <>
      {available.length > 0 && (
        <div className="opencode-models-bar">
          {available.length > 8 && (
            <input className="modal-input" value={filter} spellCheck={false} placeholder="Filter models" onChange={(e) => setFilter(e.target.value)} />
          )}
          <button className="btn small" disabled={shown.every((m) => selected.has(m))} onClick={() => setShown(true)}>
            Select All
          </button>
          <button className="btn small" disabled={!shown.some((m) => selected.has(m))} onClick={() => setShown(false)}>
            Select None
          </button>
          <span className="muted small">
            {selected.size} of {available.length} selected
          </span>
        </div>
      )}
      {available.length > 0 && (
        <div className="opencode-model-list">
          {shown.map((m) => (
            <label key={m} className="opencode-model" title={m}>
              <input type="checkbox" checked={selected.has(m)} onChange={() => toggle(m)} />
              <span>{m}</span>
            </label>
          ))}
          {!shown.length && <div className="muted small">No model matches "{filter.trim()}".</div>}
        </div>
      )}
      <div className="git-login-token">
        <input
          className="modal-input"
          value={typed}
          spellCheck={false}
          placeholder={available.length ? "Add a model id by hand" : "Model id, e.g. qwen3:8b (or fetch them from the server)"}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn small" disabled={!typed.trim()} onClick={add}>
          Add
        </button>
      </div>
    </>
  );
}

function ProviderForm({
  initial,
  custom,
  taken,
  onDone,
}: {
  initial: OpenCodeProvider;
  custom: boolean;
  /** Ids of the providers already configured. */
  taken: string[];
  onDone: (c?: OpenCodeConfig) => void;
}) {
  const isNew = !initial.npm && !initial.baseUrl && initial.key === "none" && initial.models.length === 0;
  const preset = presetOf(initial.id);
  const [id, setId] = useState(initial.id);
  const [name, setName] = useState(initial.name ?? preset?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? preset?.baseUrl ?? "");
  // A provider written by hand may use another package; it stays selectable.
  const [npm, setNpm] = useState(initial.npm ?? COMPATIBLE);
  const apiTypes = API_TYPES.some((t) => t.npm === npm) ? API_TYPES : [...API_TYPES, { npm, name: npm, hint: "", placeholder: "" }];
  const apiType = apiTypes.find((t) => t.npm === npm)!;
  const [apiKey, setApiKey] = useState("");
  const [available, setAvailable] = useState(initial.models);
  const [selected, setSelected] = useState(() => new Set(initial.models));
  const chosen = available.filter((m) => selected.has(m));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKey = initial.key !== "none";

  const save = async (removeKey = false) => {
    if (isNew && !preset && taken.includes(id.trim())) {
      setError(`A provider "${id.trim()}" is already configured; edit it instead.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = await api.opencodeSaveProvider({
        id: id.trim(),
        apiKey: removeKey ? "" : apiKey.trim() || undefined,
        ...(custom ? { name: name.trim(), npm, baseUrl: baseUrl.trim(), models: chosen } : {}),
      });
      toast(removeKey ? "Key removed" : `Saved ${name.trim() || id.trim()}`);
      onDone(config);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const fetchModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await api.opencodeFetchModels(baseUrl, apiKey.trim() || null, id.trim(), npm);
      if (!found.length) setError("The server lists no models.");
      // Fetched models start unticked, except on a first fetch with nothing chosen yet and only a few to pick from.
      const fresh = found.filter((m) => !available.includes(m));
      setAvailable([...available, ...fresh]);
      if (!selected.size && found.length <= 5) setSelected(new Set(found));
      else if (fresh.length) toast(`${fresh.length} model(s) found; tick the ones to use`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const canSave = !!id.trim() && (!custom || (!!baseUrl.trim() && !!chosen.length)) && (custom || !!apiKey.trim() || !isNew);

  return (
    <div className="settings-agent">
      <div className="settings-agent-head">
        <b>{isNew ? `Add ${preset?.name ?? "Custom Provider"}` : `Edit ${initial.name ?? preset?.name ?? initial.id}`}</b>
        <span className="run-spacer" />
        <button className="btn small" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      <div className="git-login-grid">
        {custom && (
          <>
            {!preset && (
              <>
                <span>API type</span>
                <div className="opencode-api-type">
                  <div className="seg">
                    {apiTypes.map((t) => (
                      <button key={t.npm} className={"seg-btn" + (t.npm === npm ? " on" : "")} onClick={() => setNpm(t.npm)}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                  {apiType.hint && <div className="muted small">{apiType.hint}</div>}
                </div>
              </>
            )}
            <span>ID</span>
            <input
              className="modal-input"
              value={id}
              disabled={!isNew || !!preset}
              spellCheck={false}
              placeholder="my-server (used as my-server/model)"
              onChange={(e) => setId(e.target.value)}
            />
            <span>Name</span>
            <input className="modal-input" value={name} spellCheck={false} placeholder="My Server" onChange={(e) => setName(e.target.value)} />
            <span>Address</span>
            <input className="modal-input" value={baseUrl} spellCheck={false} placeholder={apiType.placeholder || "https://api.example.com/v1"} onChange={(e) => setBaseUrl(e.target.value)} />
          </>
        )}
        <span>API key</span>
        <div className="git-login-token">
          <input
            className="modal-input"
            type="password"
            autoFocus={!custom}
            value={apiKey}
            spellCheck={false}
            placeholder={hasKey ? `Unchanged (${keyLabel(initial)})` : custom ? "Optional for local servers" : "sk-…"}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSave && void save()}
          />
          {preset?.keyUrl && (
            <button className="btn small" title="Create a key on the provider's site" onClick={() => void openUrl(preset.keyUrl!)}>
              Get a Key…
            </button>
          )}
        </div>
        {custom && (
          <>
            <span className="opencode-models-label">Models</span>
            <div className="opencode-models">
              <ModelPicker
                available={available}
                selected={selected}
                onChange={(a, s) => {
                  setAvailable(a);
                  setSelected(s);
                }}
              />
              <button className="btn small" disabled={busy || !baseUrl.trim()} title="Ask the server for its models (GET <address>/models)" onClick={() => void fetchModels()}>
                Fetch from Server
              </button>
            </div>
          </>
        )}
      </div>
      {custom && available.length > 0 && !chosen.length && <div className="muted small">Tick at least one model to save.</div>}
      {!custom && (
        <div className="muted small">
          OpenCode already knows {preset?.name ?? initial.id}'s models. A key added with /connect in OpenCode or set in the environment also works.
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="settings-agent-head">
        {initial.key === "haze" && (
          <button className="btn small" disabled={busy} onClick={() => void save(true)}>
            Remove Key
          </button>
        )}
        <span className="run-spacer" />
        <button className="btn small primary" disabled={busy || !canSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function DefaultModels({ config, onChange }: { config: OpenCodeConfig; onChange: (c: OpenCodeConfig) => void }) {
  const [model, setModel] = useState(config.model ?? "");
  const [small, setSmall] = useState(config.smallModel ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setModel(config.model ?? ""), [config.model]);
  useEffect(() => setSmall(config.smallModel ?? ""), [config.smallModel]);
  const dirty = model.trim() !== (config.model ?? "") || small.trim() !== (config.smallModel ?? "");
  const save = async () => {
    try {
      onChange(await api.opencodeSetModels(model.trim(), small.trim()));
      setError(null);
      toast("Default models saved");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="settings-agent">
      <b>Default models</b>
      <datalist id="opencode-models">
        {config.providers.flatMap((p) => p.models.map((m) => <option key={`${p.id}/${m}`} value={`${p.id}/${m}`} />))}
      </datalist>
      <div className="git-login-grid">
        <span>Model</span>
        <input className="modal-input" list="opencode-models" value={model} spellCheck={false} placeholder="anthropic/claude-sonnet-4-5" onChange={(e) => setModel(e.target.value)} />
        <span>Small model</span>
        <input className="modal-input" list="opencode-models" value={small} spellCheck={false} placeholder="For titles and summaries (optional)" onChange={(e) => setSmall(e.target.value)} />
      </div>
      <div className="muted small">Written provider/model. Empty leaves the choice to OpenCode; /models in OpenCode switches for a session.</div>
      {error && <div className="modal-error">{error}</div>}
      <div className="settings-agent-head">
        <span className="run-spacer" />
        <button className="btn small primary" disabled={!dirty || !!config.conflict} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

export function OpenCodeModelsSection() {
  const [config, setConfig] = useState<OpenCodeConfig | null>(null);
  const [editing, setEditing] = useState<{ provider: OpenCodeProvider; custom: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => api.opencodeConfig().then(setConfig, (e) => setError(errorMessage(e)));
  useEffect(() => void reload(), []);

  const add = (preset?: Preset) => {
    const existing = preset && config?.providers.find((p) => p.id === preset.id);
    const provider = existing ?? { id: preset?.id ?? "", name: null, npm: null, baseUrl: null, key: "none" as const, keyEnv: null, models: [] };
    setEditing({ provider, custom: existing ? isCustom(existing) : !preset?.keyUrl });
  };
  const remove = async (p: OpenCodeProvider) => {
    const name = p.name ?? presetOf(p.id)?.name ?? p.id;
    if (!(await confirmAction("Remove Provider", `Remove ${name} from OpenCode's config, with its saved key?`, "Remove", true))) return;
    try {
      setConfig(await api.opencodeRemoveProvider(p.id));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const locked = !!config?.conflict;

  return (
    <>
      <PageHeader
        title="AI Models"
        desc="Model providers for OpenCode, in its global config. OpenCode knows the models of most providers and only needs a key; a custom provider (Ollama, LM Studio, any OpenAI- or Anthropic-compatible endpoint, a proxy) also needs its API type, address and models. Keys are saved in files only you can read, not in the config. Restart OpenCode to apply."
      />
      {config && (
        <div className="muted small settings-path" title={config.path}>
          {config.path}
        </div>
      )}
      {config?.conflict && <div className="modal-error">{config.conflict}.</div>}
      {config && config.providers.length > 0 && (
        <div className="settings-card">
          {config.providers.map((p) => (
            <div key={p.id} className="settings-agent-head git-account">
              <b>{p.name ?? presetOf(p.id)?.name ?? p.id}</b>
              <span className="muted small">{p.id}</span>
              <span className={"tag" + (p.key === "none" ? " off" : "")} title={p.key === "none" ? "OpenCode uses a key from /connect or the environment, if any" : undefined}>
                {keyLabel(p)}
              </span>
              {p.baseUrl && <span className="muted small">{p.baseUrl.replace(/^https?:\/\//, "")}</span>}
              {p.models.length > 0 && <span className="muted small">{p.models.length === 1 ? "1 model" : `${p.models.length} models`}</span>}
              <span className="run-spacer" />
              <button className="btn small" disabled={locked} onClick={() => setEditing({ provider: p, custom: isCustom(p) })}>
                Edit
              </button>
              <button className="btn small" disabled={locked} onClick={() => void remove(p)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {config?.providers.length === 0 && !editing && <div className="settings-empty muted small">No providers configured here yet.</div>}
      {editing ? (
        <ProviderForm
          key={editing.provider.id || "new"}
          initial={editing.provider}
          custom={editing.custom}
          taken={config?.providers.map((p) => p.id) ?? []}
          onDone={(c) => {
            setEditing(null);
            if (c) setConfig(c);
          }}
        />
      ) : (
        !locked && (
          <div className="settings-agent-head">
            {PRESETS.map((p) => (
              <button key={p.id} className="btn small" onClick={() => add(p)}>
                {p.name}
              </button>
            ))}
            <button className="btn small" onClick={() => add()}>
              Custom Provider…
            </button>
          </div>
        )
      )}
      {config && <DefaultModels config={config} onChange={setConfig} />}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
