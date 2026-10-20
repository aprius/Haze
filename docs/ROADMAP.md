# Lộ trình Haze

Mục tiêu: thay Rider trong quy trình "để AI viết code", giữ lại những gì Rider làm tốt nhất (Git, điều hướng code, tìm/thay thế) mà nhẹ hơn và không báo lỗi C# sai.

## 1. Khung app — xong

Thanh project, cây file (git status, lồng file, thao tác đầy đủ, kéo thả), editor Monaco (tab xem trước, giữ encoding/EOL, không ghi đè âm thầm, bản nháp), terminal sống qua lần tắt app, Ctrl+click đường dẫn, khôi phục trạng thái.

## 2. Editor và tìm kiếm — xong

- Double Shift (Search Everywhere: All / Files / Actions / Text), Go to File, Find Action, Recent Files; tab Symbols sẽ thêm ở giai đoạn 3.
- Find in Files / Replace in Files đủ 8 điểm đã bàn: regex có lookaround/backreference (`fancy-regex`), phạm vi + file mask + bỏ `bin/obj`, lọc ngữ cảnh C# bằng tree-sitter, Preserve case, giữ encoding/BOM/CRLF, thay trong buffer với file đang mở, kiểm tra lại nội dung trước khi ghi, xem trước + tick từng chỗ + Undo cả lượt.
- Copy Context, phím tắt kiểu Rider, xem Markdown và ảnh.

Còn để sau: Structural Search & Replace (ast-grep), phạm vi "Solution" (cần đọc `.sln`, làm cùng giai đoạn 3), lọc ngữ cảnh cho ngôn ngữ khác C#.

## 3. C# — xong

- Roslyn Language Server (`roslyn-language-server` trên nuget.org, chạy `--stdio --autoLoadProjects`), dự phòng `csharp-ls`; client LSP tự viết, đồng bộ tăng dần nội dung editor, báo file đổi trên đĩa.
- Go to Definition (Ctrl+B), Find Usages (Alt+F7), Go to Implementation (Ctrl+Alt+B), Rename (Shift+F6) qua nhiều file có Undo, Alt+Enter (code action của Roslyn), hover, completion, signature help, document highlight, File Structure (Ctrl+F12), format (Ctrl+Alt+L), tab Symbols trong Double Shift.
- Không lấy diagnostics từ language server; lỗi lấy từ `dotnet build` (panel Build + vạch đỏ trong editor).
- Run configuration từ `launchSettings.json`, `dotnet test`; phạm vi "Solution" trong Find in Files.

Còn để sau: debug (cần DAP, ví dụ netcoredbg), semantic highlighting, inlay hints, đổi tên file khi đổi tên class.

## 4. Git kiểu Rider/Rebased

Tự viết lại (IdeaGitTool chỉ dùng tham khảo hành vi: giấy phép trong repo của họ không rõ ràng — `package.json` ghi Apache-2.0 nhưng file LICENSE là điều khoản build của JetBrains).

**4a — xong:** cửa sổ Commit (tick file, không cần staging, amend, commit and push, rollback), cửa sổ Git (log + đồ thị nhánh, lọc, chi tiết commit, console), Branches popup với Smart Checkout, Push dialog, Update Project, cherry-pick / revert / reset / undo commit, diff dạng tab (sửa được bên phải), Annotate (blame), Show History, Compare with HEAD.

**4b — còn lại:**
- cửa sổ merge 3 khung (Yours / Result / Theirs) và danh sách Conflicts với Accept Yours/Theirs;
- interactive rebase (reword, squash, fixup, drop, sắp xếp lại);
- Shelf (cất thay đổi theo từng file), stash UI đầy đủ (danh sách, xem, apply/pop/drop — hiện mới có qua lệnh);
- changelists;
- thêm từ Tervia: đánh dấu "đã review" từng file, checkpoint trước khi để AI chạy;
- Local History.

## 5. AI agent

- Hook của Claude Code/Codex: trạng thái đang làm / chờ duyệt / xong trên tab terminal, thông báo desktop; dùng `HAZE_TERMINAL_ID`.
- Worktree: mỗi worktree có terminal, tab và bản nháp riêng, để nhiều agent chạy song song.
- Local History.
