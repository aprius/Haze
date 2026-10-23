// Richer C# hovers, closer to Rider's: Roslyn's hover has the signature without
// modifiers or base types, and its docs skip parameters, type parameters and
// remarks. Those are read here from the declaration Go to Definition lands on:
// the project's sources (`///` XML docs) or Roslyn's metadata-as-source files
// for DLLs (`// Summary:` / `// Parameters:` comments).

export interface DocSections {
  summary?: string;
  params: [string, string][];
  typeParams: [string, string][];
  returns?: string;
  exceptions: [string, string][];
  remarks?: string;
}

export interface Declaration {
  attributes: string[];
  /** The declaration up to its body, on one line: `public class Player : MonoBehaviour`. */
  header: string;
  doc?: DocSections;
  /** The type declaring a member: `{ kind: "class", name: "Player" }`. */
  container?: { kind: string; name: string };
  namespace?: string;
  /** For DLLs: the assembly named in the metadata-as-source file's header. */
  assembly?: string;
}

const MODIFIERS = new Set(
  "public private protected internal static readonly const virtual override abstract sealed extern unsafe volatile async new partial required file ref".split(" "),
);
const TYPE_DECL = /\b(class|struct|interface|enum|record|delegate)\b/;
const CONTAINER = /\b(class|struct|interface|enum|record)\s+(?:class\s+|struct\s+)?(@?\w+)/;

const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>#|~]/g, "\\$&");

/** `T:System.Collections.Generic.List`1` → `List<T>`-ish short name: `List`. */
function crefName(cref: string): string {
  const noKind = cref.replace(/^[A-Z]:/, "").replace(/\(.*$/, "");
  return noKind.split(".").pop()!.replace(/`+\d+$/, "");
}

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** One XML doc element's content as Markdown. */
function xmlToMd(xml: string): string {
  const out: string[] = [];
  const re = /<(\w+)([^>]*?)(\/?)>|<\/(\w+)>|([^<]+)/g;
  const attr = (attrs: string, name: string) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
  let code = false;
  for (const m of xml.matchAll(re)) {
    const [, open, attrs = "", selfClose, close, text] = m;
    if (text !== undefined) {
      const t = decodeEntities(text);
      out.push(code ? t : escapeMd(t.replace(/\s+/g, " ")));
    } else if (open) {
      const name = open.toLowerCase();
      if (name === "see" || name === "seealso") {
        const target = attr(attrs, "cref") ?? attr(attrs, "langword");
        if (target && selfClose) out.push("`" + (attr(attrs, "cref") ? crefName(target) : target) + "`");
      } else if (name === "paramref" || name === "typeparamref") {
        out.push("`" + (attr(attrs, "name") ?? "") + "`");
      } else if (name === "c") out.push("`");
      else if (name === "code") {
        code = true;
        out.push("\n\n```csharp\n");
      } else if (name === "para" || name === "br") out.push("\n\n");
      else if (name === "item") out.push("\n- ");
    } else if (close) {
      const name = close.toLowerCase();
      if (name === "c") out.push("`");
      else if (name === "code") {
        code = false;
        out.push("\n```\n\n");
      } else if (name === "para") out.push("\n\n");
    }
  }
  let fenced = false;
  return out
    .join("")
    .split("\n")
    .map((l) => {
      if (l.startsWith("```")) fenced = !fenced;
      return fenced ? l : l.trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Docs from `///` lines (without the slashes). */
export function parseXmlDoc(xml: string): DocSections {
  const doc: DocSections = { params: [], typeParams: [], exceptions: [] };
  const one = (tag: string) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m ? xmlToMd(m[1]) || undefined : undefined;
  };
  const named = (tag: string, key: string, name: (v: string) => string) =>
    [...xml.matchAll(new RegExp(`<${tag}\\s+${key}\\s*=\\s*"([^"]*)"\\s*>([\\s\\S]*?)</${tag}>`, "g"))].map(
      (m): [string, string] => [name(m[1]), xmlToMd(m[2])],
    );
  doc.summary = one("summary");
  doc.returns = one("returns") ?? one("value");
  doc.remarks = one("remarks");
  doc.params = named("param", "name", (v) => v);
  doc.typeParams = named("typeparam", "name", (v) => v);
  doc.exceptions = named("exception", "cref", crefName);
  return doc;
}

const SECTIONS: Record<string, "summary" | "params" | "typeParams" | "returns" | "exceptions" | "remarks"> = {
  "Summary:": "summary",
  "Parameters:": "params",
  "Type parameters:": "typeParams",
  "Returns:": "returns",
  "Exceptions:": "exceptions",
  "Remarks:": "remarks",
};

/** Docs from metadata-as-source comments (lines without the `//`): sections at
 *  indent 1, entries (`item:`, `T:System.ArgumentException:`) at 3, text deeper. */
export function parseMetadataDoc(lines: string[]): DocSections {
  const doc: DocSections = { params: [], typeParams: [], exceptions: [] };
  let section: keyof typeof doc | undefined;
  let entry: [string, string] | undefined;
  const add = (s: string, t: string) => (s ? s + " " + t : t);
  for (const raw of lines) {
    const text = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (!text) continue;
    if (indent <= 1 && SECTIONS[text]) {
      section = SECTIONS[text];
      entry = undefined;
    } else if (!section) continue;
    else if (section === "params" || section === "typeParams" || section === "exceptions") {
      if (indent <= 3 && text.endsWith(":")) {
        const name = text.slice(0, -1);
        entry = [section === "exceptions" ? crefName(name) : name, ""];
        doc[section].push(entry);
      } else if (entry) entry[1] = add(entry[1], text);
    } else doc[section] = add(doc[section] ?? "", text);
  }
  const esc = (pairs: [string, string][]) => pairs.map(([n, t]): [string, string] => [n, escapeMd(t)]);
  return {
    summary: doc.summary && escapeMd(doc.summary),
    returns: doc.returns && escapeMd(doc.returns),
    remarks: doc.remarks && escapeMd(doc.remarks),
    params: esc(doc.params),
    typeParams: esc(doc.typeParams),
    exceptions: esc(doc.exceptions),
  };
}

const stripLineComment = (l: string) => l.replace(/\s*\/\/.*$/, "");
const codeOf = (l: string) => stripLineComment(l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'));

/** The type and namespace around 0-based `line`: braces are matched upward from it. */
function enclosing(lines: string[], line: number): Pick<Declaration, "container" | "namespace"> {
  const out: Pick<Declaration, "container" | "namespace"> = {};
  let depth = 0;
  for (let i = line - 1; i >= 0; i--) {
    const l = codeOf(lines[i]);
    for (let j = l.length - 1; j >= 0; j--) {
      if (l[j] === "}") depth++;
      else if (l[j] === "{" && --depth < 0) {
        depth = 0;
        // The block's header is on this line or just above (`class A\n{`).
        const head = [lines[i - 2], lines[i - 1], l.slice(0, j)].filter((x) => x !== undefined).map(codeOf).join(" ");
        const ns = /\bnamespace\s+([\w.]+)\s*$/.exec(head);
        const type = !out.container && !ns && CONTAINER.exec(head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1));
        if (ns) out.namespace = out.namespace ? ns[1] + "." + out.namespace : ns[1];
        else if (type) out.container = { kind: type[1], name: type[2] };
        break;
      }
    }
  }
  if (!out.namespace) {
    const fileScoped = lines.slice(0, line).map((l) => /^\s*namespace\s+([\w.]+)\s*;/.exec(l)).find(Boolean);
    if (fileScoped) out.namespace = fileScoped[1];
  }
  return out;
}

/** The declaration whose name is on 0-based `line` of a C# file. */
export function declarationAt(lines: string[], line: number): Declaration | null {
  if (line < 0 || line >= lines.length) return null;
  // The header: from the name's line up to the body, `;`, `=>`, an initializer or the next enum member.
  let header = "";
  let depth = 0;
  scan: for (let i = line; i < Math.min(lines.length, line + 12); i++) {
    const l = stripLineComment(lines[i]);
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (c === "(" || c === "[" || c === "<") depth++;
      else if (c === ")" || c === "]" || (c === ">" && l[j - 1] !== "=")) depth--;
      else if (depth <= 0 && (c === "{" || c === ";" || (c === "=" && l[j + 1] !== "=") || (c === "," && /^\s*\w+\s*$/.test(header + l.slice(0, j))))) {
        header += " " + l.slice(0, j);
        break scan;
      }
    }
    header += " " + l;
  }
  header = header.replace(/\s+/g, " ").trim();
  // Attributes on the same line (`[SerializeField] private int x`) and the lines above.
  const attributes: string[] = [];
  for (let m; (m = /^\[[^\]]*\]\s*/.exec(header)); ) {
    attributes.push(m[0].trim());
    header = header.slice(m[0].length);
  }
  if (!header) return null;
  let above = line - 1;
  for (; above >= 0 && /^\s*\[.*\]\s*$/.test(stripLineComment(lines[above])); above--) {
    attributes.unshift(stripLineComment(lines[above]).trim());
  }
  const docLines: string[] = [];
  for (; above >= 0 && /^\s*\/\//.test(lines[above]); above--) docLines.unshift(lines[above]);
  let doc: DocSections | undefined;
  if (docLines.length && docLines.every((l) => /^\s*\/\/\//.test(l))) {
    doc = parseXmlDoc(docLines.map((l) => l.replace(/^\s*\/\/\/ ?/, "")).join("\n"));
  } else if (docLines.length) {
    doc = parseMetadataDoc(docLines.map((l) => l.replace(/^\s*\/\//, "")));
  }
  const assembly = /^﻿?#region Assembly ([^,\s]+)/.exec(lines[0] ?? "")?.[1];
  return { attributes, header, doc, ...enclosing(lines, line), ...(assembly ? { assembly } : {}) };
}

/** Whether a Roslyn hover signature names a type or member (not a local, parameter, namespace or label). */
export function isMemberSignature(signature: string): boolean {
  return !/^(\(|namespace\b|\w+ in\b)/.test(signature);
}

/** A member's name in its header: `Jump` in `public bool Jump<T>(int h)`, `Hp` in `public int Hp`. */
function memberName(header: string): string | undefined {
  const head = header.split("(")[0].replace(/<[^<>]*>\s*$/, "");
  return /(@?\w+)\s*$/.exec(head)?.[1];
}

/** `bool Player<T>.Jump(int h)` → `bool Jump(int h)`: Rider names the type below instead. */
function unqualified(sig: string, name: string): string {
  const m = new RegExp(`\\.${name.replace(/^@/, "")}(?!\\w)`).exec(sig);
  if (!m) return sig;
  let i = m.index;
  for (let depth = 0; i > 0; i--) {
    const c = sig[i - 1];
    if (c === ">") depth++;
    else if (c === "<") depth--;
    else if (depth === 0 && /[\s(]/.test(c)) break;
  }
  return sig.slice(0, i) + sig.slice(m.index + 1);
}

/** The declaration as Rider shows it: attributes, modifiers and, for types, base types and constraints. */
function signatureFor(roslyn: string, decl: Declaration): string {
  let sig: string;
  if (TYPE_DECL.test(decl.header.split("(")[0])) sig = decl.header;
  else {
    // Roslyn's own signature has the generic arguments filled in (`List<int>.Add(int item)`).
    const name = memberName(decl.header);
    sig = (name ? unqualified(roslyn, name) : roslyn).replace(/\[([^[\]]+ = [^[\]]+)\]/g, "$1");
    const mods: string[] = [];
    for (const w of decl.header.split(" ")) {
      if (!MODIFIERS.has(w)) break;
      if (!new RegExp(`^(\\w+ )*${w}\\b`).test(sig.split("(")[0])) mods.push(w);
    }
    if (mods.length) sig = mods.join(" ") + " " + sig;
  }
  return [...decl.attributes, sig].join("\n");
}

const ICONS: Record<string, string> = {
  class: "symbol-class",
  record: "symbol-class",
  struct: "symbol-struct",
  interface: "symbol-interface",
  enum: "symbol-enum",
  namespace: "symbol-namespace",
};
const icon = (kind: string) => `<span class="codicon codicon-${ICONS[kind] ?? "symbol-misc"}"></span>`;

/** A doc text in one table cell. */
const cell = (md: string) => md.replace(/```\w*\n?/g, "").trim().replace(/\n+/g, "<br>");

/** The hover's parts, shown with a line between them like Rider's: the declaration,
 *  its docs (summary, then a Params / Returns / Exceptions / Remarks table) and where it is declared. */
export function buildHover(roslyn: string, decl: Declaration | null): string[] {
  const m = /^```csharp\n([\s\S]*?)\n```/.exec(roslyn);
  if (!m) return [roslyn];
  const code = (sig: string) => "```csharp\n" + sig + "\n```";
  const rest = roslyn.slice(m[0].length).trim();
  // Locals and parameters: `(local variable) List<int> l` → the declaration, its kind below.
  const local = /^\(([\w ]+)\) ([\s\S]*)$/.exec(m[1]);
  if (local) return [code(local[2]), rest, `<small>${local[1]}</small>`].filter(Boolean);
  if (!decl || !isMemberSignature(m[1])) return [code(m[1]), rest].filter(Boolean);

  const doc = decl.doc;
  const body: string[] = [];
  // Without a doc comment Roslyn's text (from an XML doc file, or "T is int" notes) is all there is.
  if (!doc) body.push(rest);
  else {
    if (doc.summary) body.push(doc.summary);
    const rows: [string, string][] = [];
    const pairs = (label: string, list: [string, string][]) => {
      if (list.length) rows.push([label, list.map(([n, t]) => `\`${n}\`${t ? " – " + cell(t) : ""}`).join("<br>")]);
    };
    pairs("Type params:", doc.typeParams);
    pairs("Params:", doc.params);
    if (doc.returns) rows.push(["Returns:", cell(doc.returns)]);
    pairs("Exceptions:", doc.exceptions);
    if (doc.remarks) rows.push(["Remarks:", cell(doc.remarks)]);
    // The table's empty header row is hidden (styles.css).
    if (rows.length) body.push("| | |\n|-|-|\n" + rows.map(([l, t]) => `| ${l} | ${t} |`).join("\n"));
    const notes = rest.split("\n").filter((l) => /&nbsp;is&nbsp;/.test(l));
    if (notes.length) body.push(notes.join("\n"));
  }

  const where: string[] = [];
  const isType = TYPE_DECL.test(decl.header.split("(")[0]);
  if (!isType && decl.container) where.push(`${icon(decl.container.kind)} in ${decl.container.kind} **${decl.container.name}**`);
  else if (decl.namespace) where.push(`${icon("namespace")} in namespace **${decl.namespace}**`);
  if (decl.assembly) where.push(`<span class="codicon codicon-library"></span> ${decl.assembly}`);

  return [code(signatureFor(m[1], decl)), body.filter(Boolean).join("\n\n"), where.join(" &nbsp; ")].filter(Boolean);
}
