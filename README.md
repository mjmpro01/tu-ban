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

### Lưu dữ liệu vào Postgres

Task, lịch sử hoạt động, yêu cầu duyệt và chỉ số token / chi phí của từng agent được lưu vào Postgres khi có biến `DATABASE_URL`. Bảng tự tạo lúc server khởi động (migration nằm trong `apps/server/src/db.ts`).

```bash
docker compose up -d
```

```bash
DATABASE_URL=postgres://tuban:tuban@localhost:5432/tuban npm run dev
```

Không đặt `DATABASE_URL` thì mọi thứ chỉ nằm trong bộ nhớ, tắt server là mất.

Task đang chạy dở khi server tắt không thể chạy tiếp: lần khởi động sau, task đó được đánh dấu lỗi "Server khởi động lại khi task đang chạy", còn yêu cầu duyệt đang chờ thì chuyển thành từ chối.

### Chế độ Demo

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
| `DATABASE_URL` |  | Chuỗi kết nối Postgres. Để trống thì chỉ lưu trong bộ nhớ |
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
| Manager | Claude | Lập kế hoạch, giao việc, tổng hợp |
| Researcher | Claude | Tìm kiếm, đọc tài liệu, review |
| Writer | Claude | Viết báo cáo, nội dung |
| Dev Cursor | Cursor CLI (**thử nghiệm**) | Sửa code trong repo local |
| Dev Copilot | GitHub Copilot (**chưa làm**) | Issue → PR |

### Làm việc nhóm

Khi bạn không chọn agent, yêu cầu được giao cho **Manager**. Manager tự lập kế hoạch và điều phối cả nhóm bằng 3 công cụ riêng (`apps/server/src/providers/claude.ts`):

| Công cụ | Việc |
|---|---|
| `delegate_task` | Giao việc con cho một agent, có thể đính kèm kết quả của các bước trước (`context_task_ids`) |
| `wait_for_tasks` | Chờ các việc con xong và đọc kết quả |
| `request_review` | Nhờ Researcher (hoặc Writer, nếu việc cần review là của Researcher) kiểm tra một việc con. Trả về APPROVED hoặc CHANGES_REQUESTED kèm góp ý |

Manager chạy việc độc lập song song, chuyển kết quả bước trước cho bước sau, review sau khi sửa code, rồi tổng hợp thành câu trả lời cuối. Việc con vẫn qua hàng đợi, xin duyệt và tính chi phí như task bình thường; agent làm việc con không được giao tiếp việc cho ai khác.

**Giới hạn cho mỗi yêu cầu:**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MAX_SUBTASKS` | `8` | Số việc con tối đa |
| `MAX_REVIEW_ROUNDS` | `2` | Số lần review tối đa |
| `MAX_TREE_BUDGET_USD` | `5` | Trần chi phí cho cả nhóm. Hết ngân sách thì Manager không giao thêm việc được và phải tổng kết |

**Trong văn phòng:** Manager đi tới bàn agent để giao việc, agent mang kết quả về bàn Manager, và khi gom đủ kết quả từ 2 người trở lên thì cả nhóm họp ở bàn họp.

**Trên dashboard:** tab Task hiển thị dạng cây (yêu cầu → việc con). Màn hình Lịch sử có mục "Việc con", liên kết về task cha, và tổng token / chi phí của cả nhóm. Huỷ một yêu cầu thì huỷ luôn mọi việc con.

Ở chế độ Demo, Manager làm theo kịch bản nhưng vẫn đi qua đúng các API trên:
- Yêu cầu viết/tìm hiểu: Researcher và Writer làm song song → họp → Writer viết bản cuối.
- Yêu cầu sửa code / GitHub: Dev làm → review yêu cầu sửa → Dev sửa → review duyệt.

Ở chế độ Live, provider nào chưa dùng được sẽ tự chạy bằng kịch bản demo. Dashboard hiện nhãn "demo" bên cạnh agent đó.

- **Cursor:** cần cài Cursor CLI. Adapter đọc output `stream-json`. CLI này thay đổi nhanh, nên kiểm tra lại cờ và định dạng output trong `apps/server/src/providers/cursor.ts`.
- **Copilot:** mới là khung trống; luồng dự kiến được ghi trong `apps/server/src/providers/copilot.ts`.

## Cấu trúc

```
apps/server/        Fastify + Socket.IO, orchestrator, các provider (claude, cursor, copilot, mock), Postgres (db.ts)
apps/web/           React dashboard + Phaser 3 (văn phòng 2D)
packages/shared/    Kiểu dữ liệu dùng chung (AgentEvent, Task, Approval…)
assets/             Pixel art: ảnh gốc, bản đã xử lý cho game, ảnh xem trước (xem assets/README.md)
tools/              Script Python xử lý asset
```

Mọi provider đều phát ra cùng một kiểu `AgentEvent`. Mỗi event mang một `activity` (`thinking`, `search`, `code`, `write`, `approval`…), và game dựa vào đó để chọn chỗ nhân vật đi tới, tư thế, icon và bong bóng thoại. Muốn thêm provider mới thì viết một file trong `apps/server/src/providers/` theo interface `AgentProvider`.

## Lưu ý

- Dashboard hiển thị 100 task và 200 event gần nhất. Lịch sử cũ hơn lấy qua API: `GET /api/tasks?limit=50&before=<ms>&agentId=<id>` và `GET /api/tasks/<id>/events`.
- Dashboard **chưa có đăng nhập**. Đừng mở cổng ra Internet khi đang chạy chế độ Live.
