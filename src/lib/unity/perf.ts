// Rider's performance-critical context for Unity: event functions Unity calls
// every frame (Update, LateUpdate, FixedUpdate…), coroutines, and the methods
// of the same class they call. Inside it, well-known expensive operations
// (GetComponent, Find, Camera.main, Debug.Log, SendMessage, calls by name) are
// pointed out, and so are calls to methods that do one. So are comparisons of
// a UnityEngine.Object to null and multidimensional array accesses.
//
// Calls are followed within a class of the file (syntax.rs lists them; no
// types are resolved), so a call into another class or file is not followed.
import type { PerfCall, PerfMethod } from "../ipc";

/** Event functions called every frame, or every physics step. */
export const FRAME_MESSAGES = new Set([
  "Update",
  "LateUpdate",
  "FixedUpdate",
  "OnGUI",
  "OnAnimatorMove",
  "OnAnimatorIK",
  "OnRenderObject",
  "OnWillRenderObject",
  "OnPreCull",
  "OnPreRender",
  "OnPostRender",
  "OnRenderImage",
  "OnTriggerStay",
  "OnTriggerStay2D",
  "OnCollisionStay",
  "OnCollisionStay2D",
  "OnMouseOver",
  "OnMouseDrag",
]);

/** Unity's own types that derive from UnityEngine.Object, which overloads `==` to ask the engine. */
export const UNITY_OBJECTS = new Set([
  "Object", "GameObject", "Component", "Transform", "RectTransform", "Behaviour", "MonoBehaviour", "ScriptableObject",
  "Camera", "Light", "Animator", "Animation", "AudioSource", "AudioListener", "AudioClip", "Rigidbody", "Rigidbody2D",
  "Collider", "Collider2D", "BoxCollider", "SphereCollider", "CapsuleCollider", "MeshCollider", "BoxCollider2D", "CircleCollider2D",
  "CharacterController", "Renderer", "MeshRenderer", "SkinnedMeshRenderer", "SpriteRenderer", "LineRenderer", "TrailRenderer",
  "MeshFilter", "ParticleSystem", "Canvas", "CanvasGroup", "Graphic", "Image", "RawImage", "Text", "Button", "Toggle", "Slider",
  "Selectable", "TMP_Text", "TextMeshPro", "TextMeshProUGUI", "Material", "Shader", "Texture", "Texture2D", "RenderTexture",
  "Sprite", "Mesh", "AnimationClip", "RuntimeAnimatorController", "NavMeshAgent", "Terrain", "Joint", "HingeJoint",
]);

const ADVICE: Record<string, (where: string) => string> = {
  GetComponent: (w) => `GetComponent in a performance-critical context (${w}): get the component once, in Awake or Start, and keep it in a field.`,
  AddComponent: (w) => `AddComponent in a performance-critical context (${w}) creates a component every time.`,
  Find: (w) => `Find in a performance-critical context (${w}) searches the whole scene: find the object once and keep it in a field.`,
  "Debug.Log": (w) => `Debug.Log in a performance-critical context (${w}) is slow, in builds too.`,
  SendMessage: (w) => `SendMessage in a performance-critical context (${w}) finds the method by name each time: call it directly.`,
  "string-invoke": (w) => `String-based method invocation in a performance-critical context (${w}): call the method directly, or pass nameof(…).`,
  "Camera.main": (w) => `Camera.main in a performance-critical context (${w}): keep the camera in a field (older Unity versions search for it each time).`,
};

export interface HotMethod {
  method: PerfMethod;
  /** The event function (or "coroutine") it is reached from. */
  from: string;
}

export interface CostlyCall {
  range: PerfCall["range"];
  message: string;
}

export interface PerfReport {
  hot: HotMethod[];
  costly: CostlyCall[];
}

const NULL_CHECK = (w: string) =>
  `Comparing a UnityEngine.Object to null in a performance-critical context (${w}) asks the engine whether it was destroyed: check once, in Awake or Start, where you can.`;
const ARRAY_ACCESS = (w: string) =>
  `Multidimensional array access in a performance-critical context (${w}) is slower than a jagged (T[][]) or flat (T[]) array.`;

/**
 * The performance-critical methods of a file's classes and the expensive calls
 * in them. `isUnityObject` tells which declared types derive from UnityEngine.Object.
 */
export function analyzePerf(methods: PerfMethod[], isMonoBehaviour: (className: string) => boolean, isUnityObject: (typeName: string) => boolean = () => false): PerfReport {
  const byName = new Map<string, PerfMethod[]>();
  const key = (cls: string, name: string) => `${cls}.${name}`;
  for (const m of methods) {
    const k = key(m.class, m.name);
    byName.set(k, [...(byName.get(k) ?? []), m]);
  }
  const callees = (m: PerfMethod, c: PerfCall) => byName.get(key(m.class, c.name)) ?? [];

  // What makes a method expensive: an operation in it, or in a method it calls (followed to a fixpoint).
  const cost = new Map<PerfMethod, string>();
  for (const m of methods) if (m.expensive.length) cost.set(m, m.expensive[0].name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of methods) {
      if (cost.has(m)) continue;
      const via = m.calls.flatMap((c) => callees(m, c)).find((t) => cost.has(t));
      if (via) {
        cost.set(m, cost.get(via)!);
        changed = true;
      }
    }
  }

  const hot = new Map<PerfMethod, string>();
  const queue: PerfMethod[] = [];
  for (const m of methods) {
    if (!isMonoBehaviour(m.class) || !(FRAME_MESSAGES.has(m.name) || m.coroutine)) continue;
    hot.set(m, m.coroutine && !FRAME_MESSAGES.has(m.name) ? "coroutine" : m.name);
    queue.push(m);
  }
  while (queue.length) {
    const m = queue.shift()!;
    for (const c of m.calls) {
      for (const t of callees(m, c)) {
        if (hot.has(t)) continue;
        hot.set(t, hot.get(m)!);
        queue.push(t);
      }
    }
  }

  const costly: CostlyCall[] = [];
  for (const [m, from] of hot) {
    for (const e of m.expensive) costly.push({ range: e.range, message: (ADVICE[e.name] ?? ((w: string) => `Expensive operation in a performance-critical context (${w}).`))(from) });
    for (const c of m.calls) {
      const target = callees(m, c).find((t) => cost.has(t) && t !== m);
      if (target) costly.push({ range: c.range, message: `Expensive method invocation in a performance-critical context (${from}): ${c.name} uses ${cost.get(target)}.` });
    }
    for (const n of m.nullChecks ?? []) if (isUnityObject(n.typeName)) costly.push({ range: n.range, message: NULL_CHECK(from) });
    for (const a of m.arrayAccess ?? []) costly.push({ range: a, message: ARRAY_ACCESS(from) });
  }
  return { hot: [...hot].map(([method, from]) => ({ method, from })), costly };
}
