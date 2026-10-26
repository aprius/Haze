// Which JetBrains icon (src/assets/jb) a file or folder gets.
import { extname } from "./path";

const BY_EXT: Record<string, string> = {};
const add = (icon: string, exts: string) => exts.split(" ").forEach((e) => (BY_EXT[e] = icon));
add("Csharp", "cs csx");
add("json", "json jsonc");
add("xml", "xml csproj fsproj vbproj props targets xaml axaml resx nuspec plist");
add("module", "sln slnx");
add("config", "config cfg conf ini env");
add("text", "txt log");
add("markdown", "md markdown");
add("yaml", "yml yaml");
add("toml", "toml");
add("shell", "sh bash zsh fish ps1 bat cmd command");
add("typeScript", "ts tsx mts cts");
add("javaScript", "js jsx mjs cjs");
add("css", "css scss sass less");
add("html", "html htm cshtml razor");
add("sql", "sql");
add("archive", "zip gz tgz tar 7z rar unitypackage nupkg jar");
add("font", "ttf otf woff woff2");
add("image", "png jpg jpeg gif svg webp ico bmp tga tif tiff psd exr hdr icns");
add("editorConfig", "editorconfig");
add("properties", "properties");
add("csv", "csv tsv");
add("c", "c");
add("cpp", "cpp cc cxx");
add("h", "h hpp hh");
add("shader", "shader hlsl hlsli cginc compute raytrace fx fxh usf ush glsl glslinc vert frag geom comp tesc tese vsh fsh shadergraph shadersubgraph");
add("java", "java kt");
add("patch", "patch diff");
add("http", "http");
add("binaryData", "dll so dylib exe bin a lib pdb");
// Unity
add("FileUnity", "unity");
add("FileUnityPrefab", "prefab");
add("FileUnityAsset", "asset mat physicmaterial physicsmaterial2d lighting mixer rendertexture spriteatlas terrainlayer brush flare guiskin cubemap playable signal");
add("FileUnityMeta", "meta");
add("FileAnimationClip", "anim");
add("FileAnimatorController", "controller overridecontroller mask");
add("Asmdef", "asmdef");
add("Asmref", "asmref");
add("InputActions", "inputactions");
add("uss", "uss tss");
add("uxml", "uxml");

const BY_NAME: Record<string, string> = {
  ".gitignore": "gitignore",
  ".gitattributes": "gitignore",
  ".gitmodules": "gitignore",
  ".dockerignore": "gitignore",
  dockerfile: "docker",
};

/** Unity's special folders, marked with their own icons. */
const UNITY_FOLDERS: Record<string, string> = {
  Assets: "FolderAssets",
  Editor: "FolderEditor",
  "Editor Default Resources": "FolderEditorResources",
  Gizmos: "FolderGizmos",
  Plugins: "FolderPlugins",
  Resources: "FolderResources",
  StreamingAssets: "FolderStreamingAssets",
  Packages: "FolderDependencies",
};

export type FolderKind = "packageReferenced" | "packageEmbedded" | "packageLocal";

const FOLDER_KIND: Record<FolderKind, string> = {
  packageReferenced: "FolderPackageReferenced",
  packageEmbedded: "FolderPackageEmbedded",
  packageLocal: "FolderPackageLocal",
};

export function iconName(name: string, isDir: boolean, unity = false, kind?: FolderKind): string {
  if (kind) return FOLDER_KIND[kind];
  if (isDir) return (unity && UNITY_FOLDERS[name]) || "folder";
  return BY_NAME[name.toLowerCase()] ?? BY_EXT[extname(name)] ?? "unknown";
}
