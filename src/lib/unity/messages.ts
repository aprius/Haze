// Unity's event functions ("messages"): methods Unity calls by name on
// classes that derive from these base types, with the signature to generate.

export type UnityBase = "MonoBehaviour" | "ScriptableObject" | "Editor" | "EditorWindow" | "AssetPostprocessor";

export interface UnityMessage {
  name: string;
  /** Parameter list as declared: "Collider other". */
  params: string;
  description: string;
  isStatic?: boolean;
}

const m = (name: string, params: string, description: string, isStatic = false): UnityMessage => ({ name, params, description, isStatic });

const SCRIPTABLE_OBJECT: UnityMessage[] = [
  m("Awake", "", "Called when the instance is being loaded."),
  m("OnEnable", "", "Called when the object becomes enabled and active."),
  m("OnDisable", "", "Called when the object becomes disabled."),
  m("OnDestroy", "", "Called when the object will be destroyed."),
  m("OnValidate", "", "Editor only: called when the script is loaded or a value changes in the Inspector."),
  m("Reset", "", "Editor only: called when the component is added or Reset is used in the Inspector."),
];

const MONO_BEHAVIOUR: UnityMessage[] = [
  ...SCRIPTABLE_OBJECT,
  m("Start", "", "Called before the first frame update, if the script is enabled."),
  m("Update", "", "Called every frame, if the MonoBehaviour is enabled."),
  m("FixedUpdate", "", "Called every fixed frame-rate frame, for physics."),
  m("LateUpdate", "", "Called every frame after all Update functions."),
  m("OnGUI", "", "Called for rendering and handling IMGUI events."),
  m("OnApplicationQuit", "", "Called on all game objects before the application quits."),
  m("OnApplicationPause", "bool pauseStatus", "Called when the application pauses or resumes."),
  m("OnApplicationFocus", "bool hasFocus", "Called when the player gets or loses focus."),
  m("OnBecameVisible", "", "Called when the renderer became visible by any camera."),
  m("OnBecameInvisible", "", "Called when the renderer is no longer visible by any camera."),
  m("OnDrawGizmos", "", "Implement to draw gizmos that are pickable and always drawn."),
  m("OnDrawGizmosSelected", "", "Implement to draw gizmos when the object is selected."),
  m("OnTriggerEnter", "Collider other", "Called when a Collider enters the trigger."),
  m("OnTriggerExit", "Collider other", "Called when a Collider has stopped touching the trigger."),
  m("OnTriggerStay", "Collider other", "Called once per physics update for every Collider touching the trigger."),
  m("OnTriggerEnter2D", "Collider2D other", "Called when another 2D collider enters the trigger."),
  m("OnTriggerExit2D", "Collider2D other", "Called when another 2D collider leaves the trigger."),
  m("OnTriggerStay2D", "Collider2D other", "Called each frame another 2D collider is in the trigger."),
  m("OnCollisionEnter", "Collision collision", "Called when this collider/rigidbody has begun touching another."),
  m("OnCollisionExit", "Collision collision", "Called when this collider/rigidbody has stopped touching another."),
  m("OnCollisionStay", "Collision collision", "Called once per physics update for every collider/rigidbody touching another."),
  m("OnCollisionEnter2D", "Collision2D collision", "Called when an incoming 2D collider makes contact."),
  m("OnCollisionExit2D", "Collision2D collision", "Called when a 2D collider stops touching this one."),
  m("OnCollisionStay2D", "Collision2D collision", "Called each frame a 2D collider is touching this one."),
  m("OnControllerColliderHit", "ControllerColliderHit hit", "Called when the CharacterController hits a collider while moving."),
  m("OnJointBreak", "float breakForce", "Called when a joint attached to the same game object broke."),
  m("OnJointBreak2D", "Joint2D brokenJoint", "Called when a Joint2D attached to the same game object breaks."),
  m("OnParticleCollision", "GameObject other", "Called when a particle hits a collider."),
  m("OnParticleTrigger", "", "Called when particles meet the conditions of the trigger module."),
  m("OnParticleSystemStopped", "", "Called when all particles in the system have died and no new ones will be born."),
  m("OnMouseDown", "", "Called when the user pressed the mouse button over the collider."),
  m("OnMouseUp", "", "Called when the user has released the mouse button."),
  m("OnMouseUpAsButton", "", "Called when the mouse is released over the same collider it was pressed on."),
  m("OnMouseEnter", "", "Called when the mouse enters the collider."),
  m("OnMouseExit", "", "Called when the mouse is no longer over the collider."),
  m("OnMouseOver", "", "Called every frame while the mouse is over the collider."),
  m("OnMouseDrag", "", "Called when the user has clicked on a collider and is still holding down the mouse."),
  m("OnAnimatorMove", "", "Callback for processing animation movements for modifying root motion."),
  m("OnAnimatorIK", "int layerIndex", "Callback for setting up animation IK (inverse kinematics)."),
  m("OnRenderObject", "", "Called after the camera has rendered the scene."),
  m("OnWillRenderObject", "", "Called for each camera if the object is visible and not a UI element."),
  m("OnPreCull", "", "Called before the camera culls the scene (Built-in Render Pipeline)."),
  m("OnPreRender", "", "Called before the camera starts rendering the scene (Built-in Render Pipeline)."),
  m("OnPostRender", "", "Called after the camera finishes rendering the scene (Built-in Render Pipeline)."),
  m("OnRenderImage", "RenderTexture source, RenderTexture destination", "Called after rendering is complete, to modify the final image."),
  m("OnAudioFilterRead", "float[] data, int channels", "Intercepts audio data to implement a custom filter."),
  m("OnTransformParentChanged", "", "Called when the parent of the transform changed."),
  m("OnTransformChildrenChanged", "", "Called when the list of children of the transform changed."),
  m("OnBeforeTransformParentChanged", "", "Called before the parent of the transform changes."),
  m("OnRectTransformDimensionsChange", "", "Called when the dimensions of a RectTransform change."),
  m("OnCanvasGroupChanged", "", "Called when the state of a parent CanvasGroup changes."),
  m("OnDidApplyAnimationProperties", "", "Called after animated properties were applied."),
];

const EDITOR: UnityMessage[] = [...SCRIPTABLE_OBJECT, m("OnSceneGUI", "", "Lets the editor handle an event in the Scene view.")];

const EDITOR_WINDOW: UnityMessage[] = [
  ...SCRIPTABLE_OBJECT,
  m("CreateGUI", "", "Called when the window's UI Toolkit root is ready to be filled."),
  m("OnGUI", "", "Implement your own editor GUI here (IMGUI)."),
  m("Update", "", "Called multiple times per second on all visible windows."),
  m("OnFocus", "", "Called when the window gets keyboard focus."),
  m("OnLostFocus", "", "Called when the window loses keyboard focus."),
  m("OnHierarchyChange", "", "Called whenever the scene hierarchy has changed."),
  m("OnProjectChange", "", "Called whenever something changes in the project."),
  m("OnSelectionChange", "", "Called whenever the selection has changed."),
  m("OnInspectorUpdate", "", "Called 10 times per second to give the inspector a chance to update."),
  m("OnBecameVisible", "", "Called when the window becomes visible."),
  m("OnBecameInvisible", "", "Called after the window is removed from a container view, or is no longer visible."),
  m("ModifierKeysChanged", "", "Called when a modifier key (Shift, Ctrl…) changes."),
  m("ShowButton", "Rect rect", "Draws a button in the window's tab, next to the menu."),
];

const ASSET_POSTPROCESSOR: UnityMessage[] = [
  m("OnPreprocessAsset", "", "Called before any asset is imported."),
  m("OnPreprocessTexture", "", "Called before a texture is imported."),
  m("OnPostprocessTexture", "Texture2D texture", "Called after a texture has been imported."),
  m("OnPostprocessSprites", "Texture2D texture, Sprite[] sprites", "Called after the sprites of a texture have been imported."),
  m("OnPreprocessModel", "", "Called before a model is imported."),
  m("OnPostprocessModel", "GameObject g", "Called after a model has been imported."),
  m("OnPostprocessPrefab", "GameObject root", "Called after a prefab has been imported."),
  m("OnPostprocessMaterial", "Material material", "Called after a material has been imported."),
  m("OnPreprocessAudio", "", "Called before an audio clip is imported."),
  m("OnPostprocessAudio", "AudioClip clip", "Called after an audio clip has been imported."),
  m("OnPreprocessAnimation", "", "Called before an animation from a model is imported."),
  m(
    "OnPostprocessAllAssets",
    "string[] importedAssets, string[] deletedAssets, string[] movedAssets, string[] movedFromAssetPaths",
    "Called after any number of assets have been imported.",
    true,
  ),
];

export const UNITY_MESSAGES_BY_BASE: Record<UnityBase, UnityMessage[]> = {
  MonoBehaviour: MONO_BEHAVIOUR,
  ScriptableObject: SCRIPTABLE_OBJECT,
  Editor: EDITOR,
  EditorWindow: EDITOR_WINDOW,
  AssetPostprocessor: ASSET_POSTPROCESSOR,
};

const BASES = new Set<string>(Object.keys(UNITY_MESSAGES_BY_BASE));

/**
 * The Unity base type a class derives from, following base classes declared
 * in the project and its packages (`classes`: name → bases). Names only:
 * two classes of the same name in different namespaces are merged.
 */
export function unityBaseOf(classes: Record<string, string[]>, name: string): UnityBase | null {
  const seen = new Set<string>();
  let level = [name];
  while (level.length) {
    const next: string[] = [];
    for (const n of level) {
      if (BASES.has(n) && n !== name) return n as UnityBase;
      if (seen.has(n)) continue;
      seen.add(n);
      next.push(...(classes[n] ?? []));
    }
    level = next;
  }
  return null;
}

export function unityMessage(base: UnityBase, name: string): UnityMessage | undefined {
  return UNITY_MESSAGES_BY_BASE[base].find((x) => x.name === name);
}

/** The declaration to insert: "private void OnTriggerEnter(Collider other)". */
export function messageSignature(msg: UnityMessage, modifiers = "private"): string {
  return `${modifiers ? modifiers + " " : ""}${msg.isStatic ? "static " : ""}void ${msg.name}(${msg.params})`;
}
