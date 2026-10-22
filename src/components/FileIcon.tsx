// File and folder icons from JetBrains' new UI (IntelliJ Platform and the
// Rider Unity plugin, Apache 2.0; see src/assets/jb/LICENSE).
import { Link } from "lucide-react";
import { iconName, type FolderKind } from "../lib/fileIcons";
import { useTheme } from "../lib/theme";

const urls = import.meta.glob("../assets/jb/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function iconUrl(name: string, dark: boolean): string | undefined {
  return (dark && urls[`../assets/jb/${name}_dark.svg`]) || urls[`../assets/jb/${name}.svg`];
}

/** Icon by file type, shared by the Project view and the Git file lists. */
export function FileIcon({
  name,
  isDir = false,
  isSymlink = false,
  unity = false,
  kind,
}: {
  name: string;
  isDir?: boolean;
  isSymlink?: boolean;
  /** Marks Unity's special folders (Editor, Resources, …). */
  unity?: boolean;
  kind?: FolderKind;
}) {
  const dark = useTheme((s) => s.mode === "dark");
  if (isSymlink) return <Link size={14} className="ico ico-link" />;
  const url = iconUrl(iconName(name, isDir, unity, kind), dark);
  return url ? <img className="jb-ico" src={url} alt="" draggable={false} /> : null;
}
