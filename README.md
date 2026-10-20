# Haze

Không gian làm việc nhẹ dành cho việc lập trình cùng AI agent (Claude Code, Codex…), hướng tới người dùng .NET quen với Rider: cây file và quản lý Git kiểu Rider, editor đủ dùng để đọc và điều hướng code, terminal không bao giờ mất phiên.

> A lightweight, AI-first workspace: Rider-style project view and Git tooling, a capable editor, and terminals that survive restarts.

![Haze](docs/screenshot.png)

Trạng thái: **giai đoạn 1** (khung app). Lộ trình đầy đủ: [docs/ROADMAP.md](docs/ROADMAP.md).

## Đã có (giai đoạn 1)

**Project**
- Thanh project bên trái: mở nhiều project, yêu thích, sắp xếp, đóng/mở lại; màn hình Welcome liệt kê project gần đây.
- Khôi phục toàn bộ khi mở lại: project, thư mục đang mở rộng, tab editor, kích thước panel, terminal.

**Cây file (Project view)**
- Tải từng cấp, ảo hóa (chỉ vẽ dòng đang thấy), tự cập nhật khi file trên đĩa thay đổi.
- Màu theo trạng thái git như Rider: sửa (xanh), mới thêm (xanh lá), chưa track (đỏ), bị ignore (vàng nhạt), xung đột; thư mục chứa thay đổi cũng được tô màu.
- Lồng file kiểu Rider: `appsettings.Development.json` dưới `appsettings.json`, `Index.razor.cs` dưới `Index.razor`, `Strings.Designer.cs` dưới `Strings.resx`, `App.csproj.user` dưới `App.csproj`…
- New File / New Directory (Alt+Insert), Rename (Shift+F6 / F2), Delete vào thùng rác, Cut/Copy/Paste (Ctrl+X/C/V), kéo thả để di chuyển (giữ Ctrl để copy), Copy Path (Ctrl+Shift+C), Open in Terminal, Reveal in File Manager.
- Chọn nhiều bằng Ctrl/Shift, điều hướng bằng bàn phím.

**Editor (Monaco)**
- Tab xem trước (click một lần: tab nghiêng, bị thay bởi file kế tiếp; double-click hoặc sửa thì giữ lại).
- Giữ nguyên encoding (UTF-8, UTF-8 BOM, UTF-16) và kiểu xuống dòng (LF/CRLF) khi lưu; ghi file an toàn qua file tạm.
- **Không ghi đè âm thầm**: file chưa sửa tự tải lại khi AI sửa trên đĩa; file đang sửa dở thì hiện thông báo với "Load disk version" / "Overwrite with mine"; lưu bị chặn nếu file trên đĩa đã đổi.
- Bản nháp chưa lưu được giữ qua lần tắt/mở app.
- Ctrl+S lưu tất cả, Ctrl+F4 đóng tab, Ctrl+Tab chuyển tab.

**Terminal**
- Shell chạy trong một tiến trình nền riêng (PTY host): **đóng hay cập nhật Haze không giết shell hay AI agent đang chạy**; mở lại là nối lại đúng phiên, phát lại output gần nhất (4 MB/phiên).
- Nhiều tab, tìm trong output (Ctrl+Shift+F), Ctrl+C copy khi có vùng chọn.
- **Ctrl+click vào đường dẫn** để mở file đúng dòng/cột: hiểu định dạng lỗi MSBuild/`dotnet build` (`Program.cs(12,5): error CS1002`) lẫn `file:line:col`.
- Alt+F12 bật/tắt terminal như Rider, Alt+1 bật/tắt Project view.
- Biến môi trường `HAZE_TERMINAL_ID` có sẵn trong mỗi terminal (dùng cho hook AI agent ở giai đoạn 5).

## Chạy và build

Yêu cầu: Node.js 20+, Rust stable, git; trên Linux cần thêm `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`.

```bash
npm install
npm run tauri dev        # chạy bản dev
npm run tauri build      # build bản cài đặt
```

Kiểm tra:

```bash
npm run build && npm test                       # TypeScript + Vite + Vitest
cd src-tauri && cargo test && cargo clippy      # Rust
```

## Kiến trúc

| Phần | Công nghệ |
|---|---|
| Vỏ app | Tauri 2 (Rust) |
| Giao diện | React 19 + TypeScript + zustand |
| Editor | Monaco |
| Terminal | xterm.js + `portable-pty`, PTY host riêng nói chuyện qua local socket (`interprocess`) |
| Theo dõi file | `notify` |
| Git | git CLI của hệ thống |

```
src/                    giao diện (React)
  components/           FileTree, EditorArea, TerminalPanel, Shell, Overlays
  lib/                  ipc (gọi Rust), buffers (file đang mở), monaco, path, termLinks
  store/                workspace (project, tab), tree, terminals, persist
src-tauri/src/
  fs_ops.rs             thao tác file, đọc/ghi giữ encoding
  nesting.rs            luật lồng file kiểu Rider
  git.rs                git status cho cây file
  watcher.rs            theo dõi thay đổi trên đĩa
  pty/                  PTY host (host.rs), client (client.rs), giao thức (protocol.rs)
```

Tiến trình PTY host chính là file chạy `haze` với tham số `--pty-host`. Nó tự thoát sau 60 giây khi không còn cửa sổ Haze nào kết nối và không còn shell nào đang chạy.

## Giấy phép

Chưa chọn. Haze chỉ tham khảo **ý tưởng** từ Tervia (AGPL-3.0), không dùng code của Tervia.
