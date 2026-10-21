// What a diff or merge editor tab shows, encoded in the tab's path.
import { basename } from "./path";

export interface DiffSpec {
  root: string;
  rel: string;
  /** Path on the left side when the file was renamed. */
  oldRel?: string | null;
  /** Revision of the left side; `null` = empty (added file). */
  left: string | null;
  /** `"working"` = the file on disk / in the editor, else a revision (`null` content if deleted there). */
  right: string;
}

export interface MergeSpec {
  root: string;
  rel: string;
}

const DIFF = "haze-diff:";
const MERGE = "haze-merge:";

function parse<T>(prefix: string, path: string): T | null {
  if (!path.startsWith(prefix)) return null;
  try {
    return JSON.parse(path.slice(prefix.length)) as T;
  } catch {
    return null;
  }
}

export const diffPath = (spec: DiffSpec) => DIFF + JSON.stringify(spec);
export const parseDiffPath = (path: string) => parse<DiffSpec>(DIFF, path);
export const mergePath = (spec: MergeSpec) => MERGE + JSON.stringify(spec);
export const parseMergePath = (path: string) => parse<MergeSpec>(MERGE, path);

const short = (rev: string) => (/^[0-9a-f]{40}/.test(rev) ? rev.slice(0, 8) + rev.slice(40) : rev);

export function diffTitle(spec: DiffSpec): string {
  const left = spec.left ? short(spec.left) : "∅";
  const right = spec.right === "working" ? "Local" : short(spec.right);
  return `${basename(spec.rel)} (${left} ↔ ${right})`;
}

export const mergeTitle = (spec: MergeSpec) => `Merge ${basename(spec.rel)}`;
