// What Haze knows about a Unity project's scripts without Unity running (the
// Rust index in unity_index.rs): base classes, and the scenes, prefabs and
// assets that use a script. Answers are synchronous from a cache; a miss
// starts loading and `onUnityCodeChanged` tells when to ask again.
import { useUnity } from "../../store/unity";
import { api, type AssetUsages, type FsChange } from "../ipc";
import { isWithin } from "../path";
import { unityBaseOf, type UnityBase } from "./messages";

interface Entry<T> {
  data: T | null;
  /** Changed on disk since loaded: kept until the new answer arrives. */
  stale: boolean;
  loading: boolean;
}

const classes = new Map<string, Entry<Record<string, string[]>>>();
const usages = new Map<string, Entry<AssetUsages>>();
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function onUnityCodeChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((cb) => cb());
  }, 50);
}

/** The Unity project a file belongs to. */
export function unityRootFor(path: string): string | null {
  return Object.values(useUnity.getState().projects).find((u) => isWithin(path, u.root))?.root ?? null;
}

function cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>): T | null {
  let e = map.get(key);
  if (!e) {
    e = { data: null, stale: true, loading: false };
    map.set(key, e);
  }
  if (e.stale && !e.loading) {
    const entry = e;
    entry.loading = true;
    entry.stale = false;
    load()
      .then((data) => {
        entry.data = data;
        notify();
      })
      .catch((err) => console.warn("Unity index", err))
      .finally(() => {
        entry.loading = false;
        // Changed again while loading.
        if (entry.stale) notify();
      });
  }
  return e.data;
}

/** The Unity base type of a class, or null (also while the index loads). */
export function unityBaseFor(root: string, className: string): UnityBase | null {
  const all = cached(classes, root, () => api.unityClasses(root));
  return all ? unityBaseOf(all, className) : null;
}

/** Whether the index has answered for this project. */
export function unityClassesLoaded(root: string): boolean {
  return !!classes.get(root)?.data;
}

/** Scenes, prefabs and assets using a script, and UnityEvent calls to its classes' methods. */
export function assetUsagesFor(root: string, script: string, classNames: string[]): AssetUsages | null {
  const key = `${script}\n${classNames.join(",")}`;
  return cached(usages, key, () => api.unityAssetUsages(root, script, classNames));
}

let generateUntil = 0;

/** Generate was asked for: completion lists only Unity event functions, for a moment. */
export function requestUnityGenerate(): void {
  generateUntil = Date.now() + 1000;
}

export function unityGenerateActive(): boolean {
  return Date.now() < generateUntil;
}

const ASSET = /\.(unity|prefab|asset|controller|overridecontroller|playable)$/i;

/** Files changed on disk: what they may have changed is asked again. */
export function unityFilesChangedForCode(change: FsChange): void {
  if (!classes.has(change.root)) return;
  const paths = [...change.files, ...change.created, ...change.removed];
  const scripts = change.overflow || paths.some((p) => /\.cs$/i.test(p));
  const assets = change.overflow || paths.some((p) => ASSET.test(p) || /\.cs\.meta$/i.test(p));
  if (!scripts && !assets) return;
  if (scripts) classes.get(change.root)!.stale = true;
  for (const [key, e] of usages) if (isWithin(key.split("\n")[0], change.root)) e.stale = true;
  notify();
}
