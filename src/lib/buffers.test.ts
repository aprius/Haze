import { describe, expect, it, vi } from "vitest";

// A Monaco stand-in that spells drive letters as the real one does on
// Windows: `Uri.file("C:\\x").fsPath` is `c:\\x` (vs/base/common/uri.js).
vi.mock("./monaco", () => {
  const models = new Map<string, unknown>();
  const file = (path: string) => {
    const fsPath = /^[A-Za-z]:/.test(path) ? path[0].toLowerCase() + path.slice(1) : path;
    return { scheme: "file", fsPath, toString: () => `file://${fsPath.toLowerCase()}` };
  };
  return {
    languageFor: () => "csharp",
    monaco: {
      Uri: { file, parse: file },
      editor: {
        EndOfLineSequence: { LF: 0, CRLF: 1 },
        getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
        createModel: (text: string, _lang: string, uri: { toString(): string }) => {
          const model = {
            uri,
            setEOL: () => {},
            getAlternativeVersionId: () => 1,
            onDidChangeContent: () => ({ dispose() {} }),
            getValue: () => text,
          };
          models.set(uri.toString(), model);
          return model;
        },
      },
    },
  };
});

vi.mock("./ipc", () => ({
  api: {
    readFile: async () => ({ kind: "text", content: "class A {}", encoding: "utf8", eol: "lf", mtime: 1 }),
  },
  errorMessage: String,
}));

const { monaco } = await import("./monaco");
const { ensureBuffer, filePath } = await import("./buffers");

describe("filePath", () => {
  it("gives back the path a buffer was opened with, not Monaco's lower-case drive", async () => {
    const path = "C:\\Game\\Assets\\Player.cs";
    await ensureBuffer(path);
    const uri = monaco.Uri.file(path);
    expect(uri.fsPath).toBe("c:\\Game\\Assets\\Player.cs");
    expect(filePath(uri)).toBe(path);
  });

  it("upper-cases the drive letter of a file no buffer has", () => {
    expect(filePath(monaco.Uri.file("D:\\Other\\B.cs"))).toBe("D:\\Other\\B.cs");
  });

  it("leaves POSIX paths alone (macOS, Linux)", async () => {
    expect(filePath(monaco.Uri.file("/Users/me/Game/C.cs"))).toBe("/Users/me/Game/C.cs");
    await ensureBuffer("/home/me/game/Assets/a:b.cs");
    expect(filePath(monaco.Uri.file("/home/me/game/Assets/a:b.cs"))).toBe("/home/me/game/Assets/a:b.cs");
  });
});
