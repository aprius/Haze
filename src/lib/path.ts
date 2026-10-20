// Path helpers that work with both `/` and `\` separators, since paths come
// straight from the OS.

export function sepOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return "";
  // Keep the root separator (`/` or `C:\`).
  return i === 0 || /^[A-Za-z]:$/.test(trimmed.slice(0, i)) ? trimmed.slice(0, i + 1) : trimmed.slice(0, i);
}

export function join(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `path` is `ancestor` or lies below it. */
export function isWithin(path: string, ancestor: string): boolean {
  const p = norm(path);
  const a = norm(ancestor);
  return p === a || p.startsWith(a + "/");
}

export function relative(root: string, path: string): string {
  const p = norm(path);
  const r = norm(root);
  if (p === r) return "";
  return p.startsWith(r + "/") ? p.slice(r.length + 1) : p;
}

/** Ancestors of `path` up to and including `root`, nearest first. */
export function ancestors(path: string, root: string): string[] {
  const out: string[] = [];
  let cur = dirname(path);
  while (cur && isWithin(cur, root)) {
    out.push(cur);
    if (norm(cur) === norm(root)) break;
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return out;
}

export function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
