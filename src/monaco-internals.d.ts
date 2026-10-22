// Monaco internals Haze patches (see EditorArea's installRiderResultLists).
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
