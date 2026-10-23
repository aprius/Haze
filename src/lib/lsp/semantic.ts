// Semantic tokens from the C# server, cut down to what is coloured by
// meaning. Monaco paints a semantic token even when no theme rule names it
// (in the default colour), so only identifiers are kept: keywords, strings,
// comments and punctuation stay as the grammar (csharpGrammar.ts) coloured them.

export interface LspSemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** Token names Haze emits; the theme (lib/monaco.ts) colours them. */
export const SEMANTIC_LEGEND = {
  tokenTypes: ["type.cs", "method.cs", "parameter.cs", "constant.cs", "static.cs", "variable.cs"],
  tokenModifiers: [] as string[],
};
const [TYPE, METHOD, PARAMETER, CONSTANT, STATIC, VARIABLE] = SEMANTIC_LEGEND.tokenTypes.map((_, i) => i);
const DROP = -1;

// Roslyn names its types after its classifications ("class name", or
// camelCased "extensionMethod"); csharp-ls uses the LSP's standard ones.
const KINDS: Record<string, number> = {};
const kind = (names: string, k: number) => names.split(" ").forEach((n) => (KINDS[n] = k));
kind("class struct interface enum delegate typeparameter recordclass recordstruct module type", TYPE);
kind("method function extensionmethod localfunction label", METHOD);
kind("parameter", PARAMETER);
kind("enummember constant", CONSTANT);
// Static members turn purple; namespaces stay plain.
kind("field property event variable local namespace", VARIABLE);
const MEMBERS = new Set(["field", "property", "event"]);

const normalize = (name: string) => name.toLowerCase().replace(/ name$/, "").replace(/[^a-z]/g, "");

/** Maps the server's encoded tokens onto SEMANTIC_LEGEND, dropping the rest. */
export function semanticTranslator(legend: LspSemanticLegend): (data: ArrayLike<number>) => Uint32Array {
  const types = legend.tokenTypes.map((t) => {
    const n = normalize(t);
    return { kind: KINDS[n] ?? DROP, member: MEMBERS.has(n) };
  });
  const staticBit = legend.tokenModifiers.findIndex((m) => /^static/i.test(m));
  return (data) => {
    const out: number[] = [];
    let line = 0;
    let char = 0;
    let lastLine = 0;
    let lastChar = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      const dl = data[i];
      line += dl;
      char = dl ? data[i + 1] : char + data[i + 1];
      const t = types[data[i + 3]];
      if (!t || t.kind === DROP) continue;
      const isStatic = staticBit >= 0 && (data[i + 4] & (1 << staticBit)) !== 0;
      const k = t.member && isStatic ? STATIC : t.kind;
      out.push(line - lastLine, line === lastLine ? char - lastChar : char, data[i + 2], k, 0);
      lastLine = line;
      lastChar = char;
    }
    return new Uint32Array(out);
  };
}
