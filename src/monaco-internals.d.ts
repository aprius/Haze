// Monaco internals Haze patches (see EditorArea's installResultLists).
declare module "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js" {
  import type * as monaco from "monaco-editor";
  interface Reference {
    uri: monaco.Uri;
    range: monaco.IRange;
  }
  interface ReferencesModel {
    references: Reference[];
    dispose(): void;
  }
  export class SymbolNavigationAction {
    desc: { id: string };
    configuration: { openToSide: boolean; openInPeek: boolean; muteMessage: boolean };
    _onResult(editorService: unknown, symbolNavService: unknown, editor: monaco.editor.ICodeEditor, model: ReferencesModel, range?: monaco.IRange): Promise<void>;
    _openReference(
      editor: monaco.editor.ICodeEditor,
      editorService: unknown,
      reference: Reference,
      sideBySide: boolean,
      highlight: boolean,
    ): Promise<monaco.editor.ICodeEditor | undefined>;
  }
  export class DefinitionAction extends SymbolNavigationAction {}
}

// The hover-delegate factory every editor resets (see lib/monaco.ts).
declare module "monaco-editor/base/browser/ui/hover/hoverDelegateFactory.js" {
  export function setHoverDelegateFactory(factory: (placement: "mouse" | "element", instantHover: boolean) => unknown): void;
}
declare module "monaco-editor/platform/hover/browser/hover.js" {
  export class WorkbenchHoverDelegate {}
}
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    initialize(overrides: object): { createInstance(ctor: unknown, ...args: unknown[]): unknown };
  };
}

// Exported by vite.config.ts (exposeMonacoWindows).
declare module "monaco-editor/base/browser/dom.js" {
  export function registerWindow(win: Window): { dispose(): void };
}
