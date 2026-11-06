# Tủ Bàn: văn phòng AI agent

Một văn phòng pixel art 2D. Mỗi AI agent là một nhân vật: ngồi gõ phím khi đang làm việc, đi tới tủ sách khi tra cứu, giơ tay khi cần bạn duyệt. Bên cạnh là dashboard để giao việc, duyệt hành động và theo dõi agent đang làm gì.

![Văn phòng](assets/preview/scene.png)

## Chạy thử

Cần Node.js 22 trở lên.

```bash
npm install
```

```bash
npm run dev
```

Mở http://localhost:5173. Server chạy ở cổng 8787, web (Vite) ở cổng 5173.

Khi **không có `ANTHROPIC_API_KEY`**, app chạy ở chế độ **Demo**: các agent làm theo kịch bản có sẵn, không tốn tiền. Dùng chế độ này để xem giao diện và hành vi của nhân vật.

### Chạy với Claude thật (chế độ Live)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run dev
```

Các agent Claude (Manager, Researcher, Writer) chạy bằng **Claude Agent SDK**, có sẵn công cụ đọc/ghi file, chạy lệnh, tìm kiếm web. Agent làm việc trong thư mục `workspace/` (đổi bằng biến `TU_BAN_WORKDIR`).

- Công cụ chỉ đọc (Read, Grep, Glob, WebSearch, WebFetch) chạy luôn, không cần hỏi.
- Mọi công cụ khác (Bash, Write, Edit…) phải được **bạn duyệt** trên dashboard trước khi chạy.
- Mỗi task bị giới hạn bởi `MAX_BUDGET_USD` (mặc định $1) và `MAX_TURNS` (mặc định 30).

### Chạy production (một tiến trình)

```bash
npm run build
```

```bash
npm start
```

Server phục vụ luôn bản web đã build ở http://localhost:8787.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `TU_BAN_MODE` | `live` nếu có `ANTHROPIC_API_KEY`, ngược lại `demo` | Ép chạy `demo` hoặc `live` |
| `ANTHROPIC_API_KEY` |  | Khoá API cho các agent Claude |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model cho các agent Claude (đổi riêng từng agent trong `apps/server/src/agents.ts`) |
| `MAX_BUDGET_USD` | `1` | Trần chi phí mỗi task |
| `MAX_TURNS` | `30` | Số lượt tối đa mỗi task |
| `TU_BAN_WORKDIR` | `workspace` | Thư mục làm việc của agent |
| `CURSOR_AGENT_CMD` | `cursor-agent` | Lệnh chạy Cursor CLI |
| `DEMO_SPEED` | `1` | Hệ số tốc độ kịch bản demo (nhỏ hơn = nhanh hơn) |
| `PORT` | `8787` | Cổng server |

## Các agent

| Agent | Provider | Việc |
|---|---|---|
| Manager | Claude | Lập kế hoạch, chia việc |
| Researcher | Claude | Tìm kiếm, đọc tài liệu |
| Writer | Claude | Viết báo cáo, nội dung |
| Dev Cursor | Cursor CLI (**thử nghiệm**) | Sửa code trong repo local |
| Dev Copilot | GitHub Copilot (**chưa làm**) | Issue → PR |

Khi bạn không chọn agent, Manager tự giao việc theo từ khoá trong task (ví dụ "tìm/so sánh" → Researcher, "sửa lỗi/code" → Dev Cursor, "issue/PR" → Dev Copilot). Lúc đó nhân vật Manager đi tới bàn của agent được giao.

Ở chế độ Live, provider nào chưa dùng được sẽ tự chạy bằng kịch bản demo. Dashboard hiện nhãn "demo" bên cạnh agent đó.

- **Cursor:** cần cài Cursor CLI. Adapter đọc output `stream-json`. CLI này thay đổi nhanh, nên kiểm tra lại cờ và định dạng output trong `apps/server/src/providers/cursor.ts`.
- **Copilot:** mới là khung trống; luồng dự kiến được ghi trong `apps/server/src/providers/copilot.ts`.

## Cấu trúc

```
apps/server/        Fastify + Socket.IO, orchestrator, các provider (claude, cursor, copilot, mock)
apps/web/           React dashboard + Phaser 3 (văn phòng 2D)
packages/shared/    Kiểu dữ liệu dùng chung (AgentEvent, Task, Approval…)
assets/             Pixel art: ảnh gốc, bản đã xử lý cho game, ảnh xem trước (xem assets/README.md)
tools/              Script Python xử lý asset
```

Mọi provider đều phát ra cùng một kiểu `AgentEvent`. Mỗi event mang một `activity` (`thinking`, `search`, `code`, `write`, `approval`…), và game dựa vào đó để chọn chỗ nhân vật đi tới, tư thế, icon và bong bóng thoại. Muốn thêm provider mới thì viết một file trong `apps/server/src/providers/` theo interface `AgentProvider`.

## Lưu ý

- Dữ liệu (task, log) đang lưu trong bộ nhớ, sẽ mất khi khởi động lại server.
- Dashboard **chưa có đăng nhập**. Đừng mở cổng ra Internet khi đang chạy chế độ Live.
