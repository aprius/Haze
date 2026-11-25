// The .editorconfig properties of a file, read from the files above it, for
// the typing assists, which need them at once: braceStyleFor answers from a
// cache, the .NET defaults until the files have been read.

import { api } from "./ipc";
import { dirname, join } from "./path";
import { DEFAULT_BRACE_STYLE, type BraceStyle } from "./csharpTyping";

interface Section {
  pattern: string;
  props: Record<string, string>;
}

export interface EditorConfig {
  root: boolean;
  sections: Section[];
}

/** Parses an .editorconfig: keys and values lowercased, as the spec says. */
export function parseEditorconfig(text: string): EditorConfig {
  const out: EditorConfig = { root: false, sections: [] };
  let section: Section | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.*)\]$/.exec(line);
    if (head) {
      section = { pattern: head[1], props: {} };
      out.sections.push(section);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    // A trailing ` # comment` is not part of the value.
    const value = line.slice(eq + 1).replace(/\s[#;].*$/, "").trim().toLowerCase();
    if (section) section.props[key] = value;
    else if (key === "root") out.root = value === "true";
  }
  return out;
}

/** An .editorconfig section pattern as a regex over the path relative to its file, with `/`. */
export function globRegex(pattern: string): RegExp {
  let p = pattern;
  // A pattern without `/` matches the name in any folder.
  if (!p.includes("/")) p = "**/" + p;
  else if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = p.indexOf("}", i);
      if (close < 0) {
        re += "\\{";
        continue;
      }
      const inner = p.slice(i + 1, close);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
      if (range) re += `(?:${Array.from({ length: Math.min(1000, Math.abs(+range[2] - +range[1]) + 1) }, (_, k) => Math.min(+range[1], +range[2]) + k).join("|")})`;
      else re += `(?:${inner.split(",").map((s) => s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`;
      i = close;
    } else if (c === "[") {
      const close = p.indexOf("]", i);
      if (close < 0) re += "\\[";
      else {
        re += "[" + p.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The properties for `path` from configs nearest first, each with its folder; stops after a `root = true`. */
export function propertiesFor(path: string, configs: { dir: string; config: EditorConfig }[]): Record<string, string> {
  const props: Record<string, string> = {};
  const chain: typeof configs = [];
  for (const c of configs) {
    chain.push(c);
    if (c.config.root) break;
  }
  for (const { dir, config } of chain.reverse()) {
    const rel = path.slice(dir.length).replace(/\\/g, "/").replace(/^\//, "");
    for (const s of config.sections) if (globRegex(s.pattern).test(rel)) Object.assign(props, s.props);
  }
  return props;
}

const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v.split(":")[0].trim() !== "false");

/** The brace layout the C# formatter would use. */
export function braceStyleFromProps(props: Record<string, string>): BraceStyle {
  const open = props["csharp_new_line_before_open_brace"]?.split(":")[0].trim();
  return {
    openBraceOnNewLine:
      open === undefined || open === "all" ? "all"
      : open === "none" ? "none"
      : open.split(",").map((s) => s.trim()),
    elseOnNewLine: bool(props["csharp_new_line_before_else"], DEFAULT_BRACE_STYLE.elseOnNewLine),
    indentCaseBlock: bool(props["csharp_indent_case_contents_when_block"], DEFAULT_BRACE_STYLE.indentCaseBlock),
  };
}

// ---------------------------------------------------------------------------
// Cache

const configs = new Map<string, Promise<EditorConfig | null>>();
const styles = new Map<string, BraceStyle>();
const loading = new Set<string>();

function configIn(dir: string) {
  let c = configs.get(dir);
  if (!c) {
    c = api.readFile(join(dir, ".editorconfig")).then(
      (f) => (f.kind === "text" ? parseEditorconfig(f.content) : null),
      () => null,
    );
    configs.set(dir, c);
  }
  return c;
}

async function load(path: string) {
  const found: { dir: string; config: EditorConfig }[] = [];
  for (let dir = dirname(path), prev = ""; dir && dir !== prev; prev = dir, dir = dirname(dir)) {
    const config = await configIn(dir);
    if (config) {
      found.push({ dir, config });
      if (config.root) break;
    }
  }
  styles.set(path, braceStyleFromProps(propertiesFor(path, found)));
}

/** The brace layout for the C# file at `path`: the defaults until its .editorconfig files are read. */
export function braceStyleFor(path: string): BraceStyle {
  const s = styles.get(path);
  if (s) return s;
  if (!loading.has(path)) {
    loading.add(path);
    void load(path).finally(() => loading.delete(path));
  }
  return DEFAULT_BRACE_STYLE;
}

/** Forgets what was read when an .editorconfig changes on disk. */
export function editorconfigChanged(files: string[], all = false) {
  if (!all && !files.some((f) => /(^|[\\/])\.editorconfig$/i.test(f))) return;
  configs.clear();
  styles.clear();
}
