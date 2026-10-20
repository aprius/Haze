# Lộ trình Haze

Mục tiêu: thay Rider trong quy trình "để AI viết code", giữ lại những gì Rider làm tốt nhất (Git, điều hướng code, tìm/thay thế) mà nhẹ hơn và không báo lỗi C# sai.

## 1. Khung app — xong

Thanh project, cây file (git status, lồng file, thao tác đầy đủ, kéo thả), editor Monaco (tab xem trước, giữ encoding/EOL, không ghi đè âm thầm, bản nháp), terminal sống qua lần tắt app, Ctrl+click đường dẫn, khôi phục trạng thái.

## 2. Editor và tìm kiếm

- **Double Shift (Search Everywhere)**: tìm mờ tên file bằng `nucleo`, sau đó thêm symbol (giai đoạn 3) và lệnh.
- **Find in Files / Replace in Files** (Ctrl+Shift+F / Ctrl+Shift+R) dùng thư viện của ripgrep (`grep`, `ignore`) trong Rust:
  - regex đầy đủ qua PCRE2 (lookaround, backreference), thay thế `$1` / `${name}`;
  - phạm vi Project / Directory / Solution / file đang mở, file mask, mặc định bỏ `bin/` và `obj/`;
  - lọc ngữ cảnh "In comments / In string literals / Except…" bằng tree-sitter-c-sharp;
  - Preserve case;
  - giữ encoding, BOM, CRLF khi ghi;
  - file đang mở thì sửa trong buffer, chạy lại regex lúc bấm Replace và báo nếu file đã đổi;
  - xem trước, bỏ chọn từng chỗ trúng, hoàn tác cả lượt.
- Copy Context (Ctrl+Shift+C trong editor): đoạn code kèm đường dẫn và số dòng để dán cho AI.
- Xem Markdown, xem ảnh.

## 3. C#

- Roslyn Language Server (`Microsoft.CodeAnalysis.LanguageServer`), dự phòng `csharp-ls`. Monaco 0.5x đã có sẵn LSP client.
- Go to Definition (Ctrl+B / F12), Find Usages (Alt+F7), Rename (Shift+F6), Go to Symbol, Go to Implementation.
- **Mặc định tắt diagnostics của language server**; bảng lỗi lấy từ `dotnet build` thật (MSBuild output), nên không có lỗi "ảo".
- Run/Debug configuration đọc từ `.sln`/`.slnx`, `.csproj`, `launchSettings.json` → `dotnet build/test/run` trong terminal riêng.

## 4. Git kiểu Rebased

Chuyển từ IdeaGitTool (Apache-2.0, TypeScript, gọi git CLI):
- Log với commit graph theo màu lane của IntelliJ, lọc theo branch/user/ngày/đường dẫn;
- Commit theo changelist (tick file, không cần staging), amend, Commit and Push;
- Shelf, Stash, Branches popup, Update Project (Ctrl+T);
- cửa sổ merge 3 khung, interactive rebase, cherry-pick, File History, Annotate (blame);
- thêm từ Tervia: đánh dấu "đã review" từng file, checkpoint trước khi để AI chạy.

## 5. AI agent

- Hook của Claude Code/Codex: trạng thái đang làm / chờ duyệt / xong trên tab terminal, thông báo desktop; dùng `HAZE_TERMINAL_ID`.
- Worktree: mỗi worktree có terminal, tab và bản nháp riêng, để nhiều agent chạy song song.
- Local History.
