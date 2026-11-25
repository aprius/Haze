// Unity GUIDs (unity_index.rs): Ctrl+Click / Ctrl+B on the GUID of a
// reference in a scene, prefab, material or `.meta` (`guid: …`), or of an
// assembly definition reference (`"GUID:…"`), opens the asset it names; Find
// Usages on it, or on an asset in the Project view, lists the scenes, prefabs
// and assets that reference it.
import { filePath } from "../buffers";
import { api, type AssetUsage } from "../ipc";
import { monaco } from "../monaco";
import { basename } from "../path";
import { unityRootFor } from "./scripts";

const GUID = /^[0-9a-f]{32}$/i;

export interface GuidAt {
  root: string;
  guid: string;
  range: monaco.IRange;
}

/** The GUID under the caret, when the line references an asset by it. */
export function unityGuidAt(model: monaco.editor.ITextModel, position: monaco.IPosition): GuidAt | null {
  if (model.uri.scheme !== "file") return null;
  const root = unityRootFor(filePath(model.uri));
  const word = root && model.getWordAtPosition(position);
  if (!root || !word || !GUID.test(word.word)) return null;
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  if (!/(?:\bguid: |GUID:)$/i.test(before)) return null;
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
  return { root, guid: word.word.toLowerCase(), range };
}

/** The GUID Unity gave an asset or folder, from its `.meta`, or the `.meta`'s own. */
export async function assetGuid(path: string): Promise<string | null> {
  const meta = path.endsWith(".meta") ? path : path + ".meta";
  const file = await api.readFile(meta).catch(() => null);
  if (file?.kind !== "text") return null;
  return /^guid: ([0-9a-f]{32})\s*$/m.exec(file.content)?.[1] ?? null;
}

/** Where a GUID is referenced, titled with the asset it names. */
export async function guidUsages(root: string, guid: string): Promise<{ title: string; usages: AssetUsage[] }> {
  const [target, usages] = await Promise.all([api.unityGuidPath(root, guid).catch(() => null), api.unityGuidUsages(root, guid)]);
  return { title: `Usages of ${target ? basename(target.path) : guid}`, usages };
}

let registered = false;

/** Registers Go to Declaration on GUIDs for all languages (once). */
export function registerGuidNavigation(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerDefinitionProvider("*", {
    async provideDefinition(model, position) {
      const at = unityGuidAt(model, position);
      if (!at) return null;
      const target = await api.unityGuidPath(at.root, at.guid).catch(() => null);
      // A folder opens in no editor; Ctrl+hover would underline a dead link.
      if (!target || target.folder) return null;
      return [{ uri: monaco.Uri.file(target.path), range: new monaco.Range(1, 1, 1, 1), originSelectionRange: at.range }];
    },
  });
}
