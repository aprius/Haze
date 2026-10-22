// Monaco internals Haze patches (see EditorArea's installDeclarationsList).
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
  export class DefinitionAction {
    configuration: { openToSide: boolean; openInPeek: boolean; muteMessage: boolean };
    _onResult(editorService: unknown, symbolNavService: unknown, editor: monaco.editor.ICodeEditor, model: ReferencesModel, range?: monaco.IRange): Promise<void>;
  }
}
