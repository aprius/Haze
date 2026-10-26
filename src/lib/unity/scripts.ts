// What Haze knows about a Unity project's scripts without Unity running (the
// Rust index in unity_index.rs): base classes, the scenes, prefabs and assets
// that use a script, and what the project's settings and assets name (tags,
// layers, scenes…). Answers are synchronous from a cache; a miss starts
// loading and `onUnityCodeChanged` tells when to ask again.
import { useUnity } from "../../store/unity";
import { api, type AssetUsages, type FsChange, type UnityProjectData } from "../ipc";
import { isWithin } from "../path";
import { unityBaseOf, type UnityBase } from "./messages";
import { UNITY_OBJECTS } from "./perf";

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
const projectData = new Map<string, Entry<UnityProjectData>>();
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

const classesOf = (root: string) => cached(classes, root, root, () => api.unityClasses(root));

/**
 * Indexes a Unity project as it opens: the scripts' base classes are at hand
 * when the first script shows (its scenes and prefabs are read after them).
 */
export function warmUnityIndex(root: string): void {
  void api.unityWarmIndex(root).catch((err) => console.warn("Unity index", err));
  classesOf(root);
}

/** The Unity base type of a class, or null (also while the index loads). */
export function unityBaseFor(root: string, className: string): UnityBase | null {
  const all = classesOf(root);
  if (!all) return null;
  let known = bases.get(all);
  if (!known) bases.set(all, (known = new Map()));
  if (!known.has(className)) known.set(className, unityBaseOf(all, className));
  return known.get(className)!;
}

/** Whether a type of the project (or of Unity) derives from UnityEngine.Object; false while the index loads. */
export function unityObjectFor(root: string, typeName: string): boolean {
  if (UNITY_OBJECTS.has(typeName)) return true;
  const all = classesOf(root);
  if (!all) return false;
  const seen = new Set<string>();
  let level = [typeName];
  while (level.length) {
    const next: string[] = [];
    for (const n of level) {
      if (UNITY_OBJECTS.has(n)) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      next.push(...(all[n] ?? []));
    }
    level = next;
  }
  return false;
}

/** Tags, layers, scenes, Resources, Animator states, shaders and assemblies of a project, or null while loading. */
export function projectDataFor(root: string): UnityProjectData | null {
  return cached(projectData, root, root, () => api.unityProjectData(root));
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
// What ProjectData lists: settings, scenes, controllers, shaders, assembly definitions, compiled assemblies, Resources.
const DATA = /[\\/]ProjectSettings[\\/]\w+\.asset$|\.(unity|controller|shader|shadergraph|asmdef|asmdef\.meta|dll)$|[\\/]Resources[\\/]/i;

const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Files changed on disk: what they may have changed is asked again, once a
 * burst of changes (an agent's edits, a reimport) has settled. Code Vision
 * redraws only if an answer changed.
 */
export function unityFilesChangedForCode(change: FsChange): void {
  if (!classes.has(change.root) && !projectData.has(change.root)) return;
  const paths = [...change.files, ...change.created, ...change.removed];
  const scripts = change.overflow || paths.some((p) => /\.cs$/i.test(p));
  const assets = scripts || paths.some((p) => ASSET.test(p) || /\.cs\.meta$/i.test(p));
  const data = change.overflow || paths.some((p) => DATA.test(p));
  if (!assets && !data) return;
  const affected = [
    ...(scripts && classes.has(change.root) ? [classes.get(change.root)!] : []),
    ...(assets ? [...usages.values()].filter((e) => e.root === change.root) : []),
    ...(data && projectData.has(change.root) ? [projectData.get(change.root)!] : []),
  ];
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
