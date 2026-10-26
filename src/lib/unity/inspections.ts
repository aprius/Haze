// Unity inspections of a script, like Rider's: strings that name a tag, a
// layer, an input axis, a scene, a Resources asset, an Animator state or a
// shader the project does not have (they compile, and fail when they run),
// and a parent set right after Instantiate. Checked against what the project's
// files name (unity_data.rs); a list Haze could not read is not checked.
import type { LspRange } from "../lsp/convert";
import type { ParentAfterInstantiate, UnityCode, UnityProjectData, UnityRef } from "../ipc";
import { BUILTIN_SHADERS } from "./builtinShaders";

export interface UnityProblem {
  range: LspRange;
  severity: "error" | "warning" | "info" | "hint";
  /** Rider's name for the inspection. */
  code: string;
  message: string;
}

const lower = (s: string) => s.toLowerCase();
const stem = (path: string) => path.replace(/\.unity$/i, "");

/**
 * Whether `value` names the scene at `path` ("Assets/Scenes/Main.unity") the
 * ways SceneManager takes it: "Main", "Scenes/Main" or the whole path.
 */
export function sceneMatches(path: string, value: string): boolean {
  if (value === path) return true;
  const base = stem(path);
  return base === value || base.endsWith("/" + value);
}

function checkScene(ref: UnityRef, data: UnityProjectData): Omit<UnityProblem, "range"> | null {
  const build = data.buildScenes;
  if (!build) return null;
  const v = ref.value;
  if (ref.kind === "sceneIndex") {
    const enabled = build.filter((s) => s.enabled).length;
    const index = Number(v);
    if (index < enabled) return null;
    return { severity: "warning", code: "LoadSceneWrongIndex", message: `There is no scene at index ${index} in the Build Settings (${enabled} enabled).` };
  }
  const inBuild = build.filter((s) => sceneMatches(s.path, v));
  if (inBuild.length) {
    const enabled = inBuild.filter((s) => s.enabled);
    if (!enabled.length) return { severity: "warning", code: "LoadSceneDisabledSceneName", message: `The scene "${v}" is disabled in the Build Settings: a build can't load it.` };
    if (enabled.length > 1 && !v.endsWith(".unity"))
      return { severity: "warning", code: "LoadSceneAmbiguousSceneName", message: `More than one scene in the Build Settings matches "${v}": the first is loaded (${enabled.map((s) => s.path).join(", ")}).` };
    return null;
  }
  if (data.scenes.some((p) => sceneMatches(p, v)))
    return { severity: "warning", code: "LoadSceneUnknownSceneName", message: `The scene "${v}" is not in the Build Settings: a build can't load it.` };
  return { severity: "warning", code: "LoadSceneUnexistingSceneName", message: `There is no scene "${v}" in the project.` };
}

function checkResource(ref: UnityRef, data: UnityProjectData): Omit<UnityProblem, "range"> | null {
  const v = lower(ref.value.replace(/\\/g, "/"));
  if (!v) return null;
  const all = data.resources.map(lower);
  const withoutExt = (r: string) => r.replace(/\.[^./]+$/, "");
  if (ref.kind === "resourceFolder") {
    if (all.some((r) => r.startsWith(v + "/") || withoutExt(r) === v)) return null;
    return { severity: "warning", code: "UnknownResource", message: `There is no folder "${ref.value}" in a Resources folder.` };
  }
  if (all.some((r) => withoutExt(r) === v)) return null;
  if (all.includes(v))
    return { severity: "warning", code: "UnknownResource", message: `Resources paths have no file extension: "${withoutExt(ref.value)}".` };
  return { severity: "warning", code: "UnknownResource", message: `There is no asset "${ref.value}" in a Resources folder.` };
}

function check(ref: UnityRef, data: UnityProjectData): Omit<UnityProblem, "range"> | null {
  const v = ref.value;
  switch (ref.kind) {
    case "tag":
      if (!data.tags || data.tags.includes(v)) return null;
      return { severity: "warning", code: "UnknownTag", message: `The tag "${v}" is not defined in the Tag Manager.` };
    case "layer":
      if (!data.layers || data.layers.includes(v)) return null;
      return { severity: "warning", code: "UnknownLayer", message: `The layer "${v}" is not defined in the Tag Manager.` };
    case "axis":
      if (!data.axes?.length || data.axes.includes(v)) return null;
      return { severity: "warning", code: "UnknownInputAxes", message: `The input axis "${v}" is not defined in the Input Manager.` };
    case "scene":
    case "sceneIndex":
      return checkScene(ref, data);
    case "editorScene":
      if (!/^(Assets|Packages)\//.test(v) || data.scenes.includes(v)) return null;
      return { severity: "warning", code: "LoadSceneUnexistingSceneName", message: `There is no scene at "${v}".` };
    case "resource":
    case "resourceFolder":
      return checkResource(ref, data);
    case "animatorState": {
      const states = data.animatorStates;
      if (!states || states.includes(v) || states.includes(v.slice(v.lastIndexOf(".") + 1))) return null;
      return { severity: "warning", code: "UnknownAnimatorStateName", message: `No Animator Controller of the project has a state named "${v}".` };
    }
    case "shader":
      if (data.shaders.includes(v) || BUILTIN_SHADERS.has(v)) return null;
      return { severity: "warning", code: "ShaderLabShaderReferenceNotResolved", message: `There is no shader "${v}" in the project, its packages or Unity's built-in shaders.` };
  }
}

/** The arguments Instantiate takes to do what setting the parent after it does. */
export function instantiateWithParent(p: ParentAfterInstantiate): string {
  const world = p.world === null ? ", worldPositionStays" : p.world ? ", true" : "";
  return `Instantiate(${p.original}, ${p.parent}${world})`;
}

export function inspectUnityCode(code: UnityCode, data: UnityProjectData | null): UnityProblem[] {
  const out: UnityProblem[] = [];
  if (data) {
    for (const ref of code.refs) {
      const p = check(ref, data);
      if (p) out.push({ ...p, range: ref.range });
    }
  }
  for (const p of code.setParent) {
    out.push({
      range: p.range,
      severity: "info",
      code: "InstantiateWithoutParent",
      message: `Setting the parent right after Instantiate builds the transform hierarchy twice: pass it to Instantiate instead, ${instantiateWithParent(p)}.`,
    });
  }
  return out;
}

/** What a string of this kind can be, for completion. */
export function unityNames(kind: UnityRef["kind"], data: UnityProjectData): string[] {
  switch (kind) {
    case "tag":
      return data.tags ?? [];
    case "layer":
      return data.layers ?? [];
    case "axis":
      return [...new Set(data.axes ?? [])];
    case "scene":
      return (data.buildScenes ?? []).filter((s) => s.enabled).map((s) => stem(s.path).split("/").pop()!);
    case "editorScene":
      return data.scenes;
    case "resource":
      return [...new Set(data.resources.map((r) => r.replace(/\.[^./]+$/, "")))];
    case "resourceFolder":
      return [...new Set(data.resources.flatMap((r) => r.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))];
    case "animatorState":
      return data.animatorStates ?? [];
    case "shader":
      return [...data.shaders, ...[...BUILTIN_SHADERS].filter((s) => !s.startsWith("Hidden/"))];
    case "sceneIndex":
      return [];
  }
}
