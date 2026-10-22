// What Haze knows about a Unity project's scripts without Unity running (the
// Rust index in unity_index.rs): base classes, and the scenes, prefabs and
// assets that use a script. Answers are synchronous from a cache; a miss
// starts loading and `onUnityCodeChanged` tells when to ask again.
import { useUnity } from "../../store/unity";
import { api, type AssetUsages, type FsChange } from "../ipc";
import { isWithin } from "../path";
import { unityBaseOf, type UnityBase } from "./messages";

interface Entry<T> {
  root: string;
  data: T | null;
  /** The answer as JSON, to tell a new answer that changes nothing (no redraw then). */
  json: string;
  /** Changed on disk since loaded: kept until the new answer arrives. */
  stale: boolean;
  loading: boolean;
  load: () => Promise<T>;
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

function reload<T>(entry: Entry<T>) {
  if (entry.loading) return;
  entry.loading = true;
  entry.stale = false;
  entry
    .load()
    .then((data) => {
      const json = JSON.stringify(data);
      entry.data = data;
      if (json !== entry.json) {
        entry.json = json;
        notify();
      }
    })
    .catch((err) => console.warn("Unity index", err))
    .finally(() => {
      entry.loading = false;
      // Changed again while loading.
      if (entry.stale) reload(entry);
    });
}

function cached<T>(map: Map<string, Entry<T>>, root: string, key: string, load: () => Promise<T>): T | null {
  let e = map.get(key);
  if (!e) {
    e = { root, data: null, json: "", stale: true, loading: false, load };
    map.set(key, e);
  }
  // The first answer; later ones after file changes settle (unityFilesChangedForCode).
  if (e.stale && !e.json) reload(e);
  return e.data;
}

/** Base types already worked out, per answer of the index. */
const bases = new WeakMap<Record<string, string[]>, Map<string, UnityBase | null>>();

/** The Unity base type of a class, or null (also while the index loads). */
export function unityBaseFor(root: string, className: string): UnityBase | null {
  const all = cached(classes, root, root, () => api.unityClasses(root));
  if (!all) return null;
  let known = bases.get(all);
  if (!known) bases.set(all, (known = new Map()));
  if (!known.has(className)) known.set(className, unityBaseOf(all, className));
  return known.get(className)!;
}

/** Whether the index has answered for this project. */
export function unityClassesLoaded(root: string): boolean {
  return !!classes.get(root)?.data;
}

/** Scenes, prefabs and assets using a script, and UnityEvent calls to its classes' methods. */
export function assetUsagesFor(root: string, script: string, classNames: string[]): AssetUsages | null {
  const key = `${script}\n${classNames.join(",")}`;
  return cached(usages, root, key, () => api.unityAssetUsages(root, script, classNames));
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

const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Files changed on disk: what they may have changed is asked again, once a
 * burst of changes (an agent's edits, a reimport) has settled. Code Vision
 * redraws only if an answer changed.
 */
export function unityFilesChangedForCode(change: FsChange): void {
  if (!classes.has(change.root)) return;
  const paths = [...change.files, ...change.created, ...change.removed];
  const scripts = change.overflow || paths.some((p) => /\.cs$/i.test(p));
  const assets = scripts || paths.some((p) => ASSET.test(p) || /\.cs\.meta$/i.test(p));
  if (!assets) return;
  const affected = [...(scripts ? [classes.get(change.root)!] : []), ...[...usages.values()].filter((e) => e.root === change.root)];
  affected.forEach((e) => (e.stale = true));
  clearTimeout(reloadTimers.get(change.root));
  reloadTimers.set(
    change.root,
    setTimeout(() => {
      reloadTimers.delete(change.root);
      for (const e of affected) if (e.stale) reload(e as Entry<unknown>);
    }, 300),
  );
}
