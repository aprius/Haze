import { File, FileCode, FileJson, FileText, Folder, FolderOpen, Image, Link } from "lucide-react";
import { extname } from "../lib/path";

/** Icon by file type, shared by the Project view and the Git file lists. */
export function FileIcon({ name, isDir = false, isSymlink = false, open = false }: { name: string; isDir?: boolean; isSymlink?: boolean; open?: boolean }) {
  if (isSymlink) return <Link size={14} className="ico ico-link" />;
  if (isDir) return open ? <FolderOpen size={14} className="ico ico-folder" /> : <Folder size={14} className="ico ico-folder" />;
  const ext = extname(name);
  if (["cs", "fs", "vb", "ts", "tsx", "js", "jsx", "rs", "go", "py", "java", "kt", "cpp", "c", "h", "razor", "cshtml", "xaml", "axaml", "sql", "sh", "ps1"].includes(ext))
    return <FileCode size={14} className={"ico ico-code ext-" + ext} />;
  if (["json", "jsonc"].includes(ext)) return <FileJson size={14} className="ico ico-json" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext)) return <Image size={14} className="ico ico-image" />;
  if (["md", "txt", "log", "csproj", "sln", "slnx", "props", "targets", "xml", "yml", "yaml", "toml", "config"].includes(ext))
    return <FileText size={14} className="ico ico-text" />;
  return <File size={14} className="ico" />;
}
