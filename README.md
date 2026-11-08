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

### Đăng nhập

Dashboard cần đăng nhập. Lần chạy đầu tiên, nếu chưa có tài khoản nào, màn hình đầu tiên là **tạo tài khoản admin**. Nếu server mở ra mạng, hãy tạo admin trước bằng biến môi trường để không ai khác giành quyền tạo admin:

```bash
ADMIN_USERNAME=minh ADMIN_PASSWORD='mat-khau-dai' npm run dev
```

Biến này chỉ có tác dụng khi chưa có tài khoản nào.

| Vai trò | Được làm |
|---|---|
| **Admin** | Mọi thứ: cấu hình agent và skill, **duyệt / từ chối lệnh**, quản lý người dùng |
| **Thành viên** | Giao việc, xem văn phòng và lịch sử, huỷ task do chính mình tạo |

- Mật khẩu băm bằng scrypt. Phiên đăng nhập lưu 7 ngày, cookie `httpOnly` + `SameSite=Lax`, kèm `Secure` khi `PUBLIC_URL` là https (hoặc đặt `COOKIE_SECURE=1`).
- Request thay đổi dữ liệu phải có header `x-tuban: 1` (chống CSRF). Socket.IO từ chối kết nối không có phiên hoặc đến từ trang web khác.
- Đăng nhập sai 10 lần trong 15 phút thì tạm khoá. Không thể tự khoá, tự hạ quyền hay xoá admin cuối cùng.
- Khoá tài khoản, đổi vai trò hoặc đổi mật khẩu thì các phiên đang mở của người đó bị đăng xuất ngay.
- Lịch sử ghi lại ai giao task, ai duyệt lệnh, ai sửa cấu hình.
- Không có `DATABASE_URL` thì tài khoản chỉ nằm trong bộ nhớ: tắt server là mất, lần sau phải tạo lại (hoặc dùng `ADMIN_USERNAME` / `ADMIN_PASSWORD`).

### Bảng tổng quan & bàn giao

Tab **Bảng tổng quan** (cạnh tab Văn phòng) cho thấy cả văn phòng trên một màn hình:

- **Mỗi agent một cột:**
  - Đang làm gì (task, bước hiện tại, đã chạy bao lâu, có đang chờ duyệt không).
  - **Hàng đợi** các việc sắp làm.
  - Các việc **vừa xong**.
- **Luồng công việc đang mở:** mỗi yêu cầu hiện các bước theo thứ tự (Manager điều phối → các việc con → review) và **đang chờ agent nào**.
- **Chuyển việc:** đưa một task chưa bắt đầu trong hàng đợi sang agent khác (vd. agent đang rảnh). Thành viên chỉ chuyển được task của mình. Việc con không chuyển được cho Manager, vì Manager đang chờ chính việc đó.
- **Bàn giao tiếp:** từ một việc đã xong, giao việc tiếp theo cho agent khác.
  - Kết quả cũ được chuyển kèm làm bối cảnh.
  - Có gợi ý nên giao cho ai (Researcher → Writer, Dev → Researcher review…).
  - Task mới ghi lại là "tiếp nối" task cũ, xem được trong Lịch sử.

### Thống kê & ngân sách

Nút **Thống kê** (mọi người xem được):
- Chi phí hôm nay so với ngân sách ngày.
- Số yêu cầu, tỉ lệ thành công.
- Biểu đồ chi phí và số yêu cầu theo ngày (7 / 14 / 30 ngày).
- Bảng theo từng agent: số task, tỉ lệ thành công, thời gian trung bình, token, chi phí.

Ngày được tính theo múi giờ của server (biến `TZ`).

**Hạn mức** (chỉ admin sửa, áp dụng ngay cho task bắt đầu sau đó):

| Hạn mức | Mặc định | Ý nghĩa |
|---|---|---|
| Ngân sách mỗi ngày | `DAILY_BUDGET_USD` = 0 | 0 = không giới hạn. Hết ngân sách thì task mới báo lỗi và không chạy; mỗi task Claude chỉ được tiêu tối đa phần còn lại trong ngày |
| Tối đa mỗi yêu cầu | `MAX_TREE_BUDGET_USD` = 5 | Cho cả nhóm (Manager + việc con) |
| Tối đa mỗi task | `MAX_BUDGET_USD` = 1 | Một agent Claude dừng khi vượt |
| Số việc con / lần review / lượt | 8 / 2 / 30 | Như trước, giờ sửa được trên dashboard |

Biến môi trường chỉ là giá trị khởi đầu; giá trị admin lưu trên dashboard nằm trong bảng `app_settings` và được ưu tiên hơn.

### Thông báo (Telegram / Slack)

Đặt biến môi trường trên server rồi khởi động lại:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=987654321 npm run dev
```

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npm run dev
```

- Telegram: tạo bot với @BotFather để lấy token, nhắn cho bot một tin rồi lấy `chat_id` (người hoặc nhóm nhận tin).
- Slack: tạo *Incoming Webhook* cho kênh muốn nhận tin.

Admin vào **menu người dùng → Thông báo** để xem kênh nào đã cấu hình, bấm **Gửi thử**, và bật/tắt từng loại:
- Agent cần duyệt.
- Yêu cầu hoàn thành (không tính việc con), kèm tóm tắt kết quả.
- Yêu cầu lỗi.
- Ngân sách ngày chạm 80% và 100%.

Lưu ý:
- Token và webhook chỉ nằm trong biến môi trường: không lưu vào database, không hiện trên dashboard, không ghi vào log.
- Tin nhắn có link về `PUBLIC_URL`, nên đặt biến này thành địa chỉ thật của dashboard.
- Gửi lỗi (mạng, token sai…) không làm hỏng việc của agent: lỗi được ghi log và hiện ở màn hình Thông báo.

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

Khi **không có `ANTHROPIC_API_KEY` hay `NINEROUTER_URL`**, app chạy ở chế độ **Demo**: các agent làm theo kịch bản có sẵn, không tốn tiền. Dùng chế độ này để xem giao diện và hành vi của nhân vật.

### Chạy với Claude thật (chế độ Live)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run dev
```

Các agent Claude (Manager, Researcher, Writer) chạy bằng **Claude Agent SDK**, có sẵn công cụ đọc/ghi file, chạy lệnh, tìm kiếm web. Agent làm việc trong thư mục `workspace/` (đổi bằng biến `TU_BAN_WORKDIR`).

- Mặc định, công cụ đọc file và tìm web chạy luôn; ghi file và chạy lệnh phải được **bạn duyệt** trên dashboard. Đổi cho từng agent trong **Quản lý agent → Quyền dùng công cụ**.
- Mỗi task bị giới hạn bởi `MAX_BUDGET_USD` (mặc định $1) và `MAX_TURNS` (mặc định 30).

### Bộ nhớ chung (context memory)

Mọi agent dùng chung một **bộ nhớ**, bất kể chạy bằng Claude, Cursor hay model nào sau 9router. Có ba phạm vi:

| Phạm vi | Ai thấy | Ví dụ |
|---|---|---|
| **Chung** | Mọi agent | "Khách hàng muốn báo cáo bằng tiếng Việt, tối đa 2 trang" |
| **Riêng agent** | Chỉ agent đó | "Writer: dùng giọng văn thân thiện" |
| **Theo yêu cầu** | Các agent cùng làm một yêu cầu | Researcher để lại nguồn tài liệu cho Writer |

Bộ nhớ được dùng theo các cách sau:
- **Tự nhắc lại:** trước mỗi task, server tìm những ghi nhớ liên quan nhất và đưa vào hướng dẫn cho agent (agent Cursor nhận chúng trong prompt).
- **Tự ghi nhớ:** khi một yêu cầu xong, kết quả được lưu vào bộ nhớ chung. Với Mem0 có model, Mem0 tự rút ra các ý chính và gộp với điều đã biết.
- **Công cụ cho agent Claude:** `memory_search` và `memory_save` (luôn được phép, không cần duyệt).
- **Dashboard → Bộ nhớ:** mọi người tìm và xem; admin thêm, sửa, xoá và bật/tắt tự nhắc, tự ghi nhớ.

Có hai cách lưu:

1. **Mặc định (không cần cài thêm):** lưu trong Postgres, tìm theo từ khoá. Tìm không phân biệt dấu: "bao cao" vẫn ra "báo cáo".
2. **[Mem0](https://github.com/mem0ai/mem0) (Apache-2.0):** tìm theo nghĩa bằng vector (pgvector) và tự gộp ghi nhớ trùng nhau. Embedding dùng model tiếng Việt [AITeamVN/Vietnamese_Embedding](https://huggingface.co/AITeamVN/Vietnamese_Embedding) (BGE-M3 fine-tune, 1024 chiều). Model chạy bằng Hugging Face text-embeddings-inference, còn việc rút ý chính đi qua 9router.

Cách chạy Mem0:

```bash
export MEM0_API_KEY=$(openssl rand -hex 24)
```

```bash
docker compose --profile memory up -d
```

```bash
MEM0_URL=http://localhost:8888 MEMORY_EMBED_URL=http://tei \
MEM0_NINEROUTER_URL=http://host.docker.internal:20128 MEMORY_LLM_MODEL=<model-id-trong-9router> \
DATABASE_URL=postgres://tuban:tuban@localhost:5432/tuban npm run dev
```

Lưu ý khi dùng Mem0:
- Lúc khởi động, server gửi cấu hình model cho Mem0 (`POST /configure`). Mem0 lưu vector trong bảng `tuban_memories_<số chiều>` của database `mem0`.
- `MEMORY_EMBED_URL` và `MEM0_NINEROUTER_URL` là địa chỉ **Mem0** gọi tới, tính từ bên trong Docker, nên khác địa chỉ server văn phòng dùng.
- Không có `MEMORY_EMBED_URL` thì embedding đi qua `/v1/embeddings` của 9router: đặt `MEMORY_EMBED_MODEL` và `MEMORY_EMBED_DIMS` theo model đó.
- Volume Postgres đã tạo từ trước khi có Mem0 thì cần tạo database cho Mem0 một lần: `docker compose exec postgres bash /docker-entrypoint-initdb.d/init-db.sh`.
- Mem0 lỗi hoặc tắt không làm hỏng việc của agent: task vẫn chạy, chỉ thiếu phần nhớ lại. Lỗi hiện ở màn hình Bộ nhớ.
- Ghi nhớ nằm trong `memories` (mặc định) hoặc trong Mem0. Đổi cách lưu không tự chuyển dữ liệu cũ.

### Dùng 9router

[9router](https://github.com/decolua/9router) là gateway chạy ở máy bạn (mặc định `http://localhost:20128`), gom nhiều tài khoản AI về một chỗ. Đặt `NINEROUTER_URL` (và `NINEROUTER_KEY` nếu bạn bật API key trong 9router) thì:
- Agent Claude gửi request qua 9router (`ANTHROPIC_BASE_URL`), nên không cần `ANTHROPIC_API_KEY`. Nếu vẫn có `ANTHROPIC_API_KEY` thì khoá này không được gửi cho gateway.
- Văn phòng chạy ở chế độ Live.
- Model của từng agent (Quản lý agent → Model) phải là model mà 9router nhận. Chi phí mà SDK báo là ước tính theo giá Anthropic, có thể khác chi phí thật qua 9router.

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
| `TU_BAN_MODE` | `live` nếu có `ANTHROPIC_API_KEY` hoặc `NINEROUTER_URL`, ngược lại `demo` | Ép chạy `demo` hoặc `live` |
| `ANTHROPIC_API_KEY` |  | Khoá API cho các agent Claude |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model mặc định cho các agent Claude (đổi riêng từng agent trong **Quản lý agent**) |
| `MAX_BUDGET_USD` | `1` | Trần chi phí mỗi task |
| `MAX_TURNS` | `30` | Số lượt tối đa mỗi task |
| `TU_BAN_WORKDIR` | `workspace` | Thư mục làm việc của agent |
| `CURSOR_AGENT_CMD` | `cursor-agent` | Lệnh chạy Cursor CLI |
| `DEMO_SPEED` | `1` | Hệ số tốc độ kịch bản demo (nhỏ hơn = nhanh hơn) |
| `PORT` | `8787` | Cổng server |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` |  | Tạo admin đầu tiên khi chưa có tài khoản nào |
| `PUBLIC_URL` | `http://localhost:PORT` | Địa chỉ công khai của dashboard (link trong thông báo; https thì bật cookie `Secure`) |
| `COOKIE_SECURE` | theo `PUBLIC_URL` | `1` để chỉ gửi cookie qua HTTPS |
| `DAILY_BUDGET_USD` | `0` | Ngân sách ngày ban đầu (0 = không giới hạn; sửa được trên dashboard) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` |  | Gửi thông báo qua Telegram |
| `SLACK_WEBHOOK_URL` |  | Gửi thông báo qua Slack |
| `TZ` | múi giờ máy | Múi giờ dùng để tính "ngày" cho thống kê và ngân sách, vd. `Asia/Ho_Chi_Minh` |
| `NINEROUTER_URL` / `NINEROUTER_KEY` |  | Gọi agent Claude qua 9router (xem **Dùng 9router**) |
| `MEM0_URL` / `MEM0_API_KEY` |  | Dùng Mem0 cho bộ nhớ chung. Để trống thì tìm theo từ khoá trong Postgres |
| `MEM0_NINEROUTER_URL` | `NINEROUTER_URL` | Địa chỉ 9router tính từ Mem0 (Mem0 chạy trong Docker: `http://host.docker.internal:20128`) |
| `MEMORY_LLM_MODEL` |  | Model trong 9router mà Mem0 dùng để rút ý chính |
| `MEMORY_EMBED_URL` |  | Server embedding (text-embeddings-inference) tính từ Mem0, vd. `http://tei` |
| `MEMORY_EMBED_MODEL` / `MEMORY_EMBED_DIMS` | `AITeamVN/Vietnamese_Embedding` / `1024` | Model embedding và số chiều vector |
| `MEM0_CONFIGURE` | `1` | `0` = không gửi cấu hình model cho Mem0 lúc khởi động |

## Các agent

Bấm **Quản lý agent** trên dashboard để sửa từng agent mà không cần sửa code hay khởi động lại server:
- Tên hiển thị, vai trò, provider (Claude / Cursor / Copilot), model Claude (chọn trong danh sách hoặc nhập model id khác), system prompt, quyền dùng công cụ và skill.
- Bật/tắt agent. Agent tắt không nhận việc mới (kể cả từ Manager) và rời khỏi văn phòng; việc đang làm vẫn chạy nốt. Manager luôn bật.
- **Khôi phục mặc định** từng agent.

### Quyền dùng công cụ (agent Claude)

Mỗi agent có 4 nhóm công cụ, mỗi nhóm chọn **Tắt / Hỏi trước / Tự chạy**:

| Nhóm | Công cụ | Mặc định |
|---|---|---|
| Đọc file | Read, Glob, Grep… | Tự chạy |
| Tìm trên web | WebSearch, WebFetch | Tự chạy |
| Ghi / sửa file | Write, Edit, MultiEdit… | Hỏi trước |
| Chạy lệnh | Bash… | Hỏi trước |

- "Tắt": agent không thấy nhóm công cụ đó.
- "Hỏi trước": agent phải chờ bạn bấm Duyệt trên dashboard.
- Công cụ làm việc nhóm của Manager luôn được dùng.

### Skill (agent Claude)

Tab **Thư viện skill** trong Quản lý agent: tạo, sửa, xoá skill. Mỗi skill là `workspace/.claude/skills/<tên>/SKILL.md`, có phần mô tả (agent dựa vào mô tả để quyết định khi nào dùng) và nội dung Markdown. Có thể tự chép thêm file kèm theo (script, mẫu…) vào thư mục của skill.

Trong form của từng agent, tích chọn skill mà agent được dùng; agent chỉ thấy các skill được tích. Xoá skill thì skill tự gỡ khỏi mọi agent.

- Để nạp được skill, server đọc thư mục `.claude/` **của thư mục làm việc** (`settingSources: ["project"]`). Cấu hình cá nhân trong `~/.claude` trên máy chạy server không bao giờ được nạp.
- Skill không phải hàng rào bảo mật: agent vẫn đọc được file của skill không được bật cho nó. Đừng để mật khẩu hay khoá API trong skill.
- Skill nằm trên ổ đĩa, không nằm trong database. Khi deploy, thư mục làm việc phải được giữ lại giữa các lần khởi động.

Thay đổi áp dụng cho task kế tiếp. Có `DATABASE_URL` thì thay đổi được lưu vào bảng `agent_settings`; bảng này chỉ lưu những gì khác mặc định, nên khi code cập nhật giá trị mặc định thì agent chưa chỉnh sẽ tự nhận giá trị mới. Không có database thì thay đổi mất khi tắt server.

Danh sách thành viên nhóm và các giới hạn trong prompt của Manager được **tự sinh khi chạy** từ cấu hình hiện tại, nên đổi tên hoặc tắt agent thì Manager biết ngay. API: `GET /api/agents/settings`, `PUT /api/agents/:id/settings`, `POST /api/agents/:id/settings/reset`.

Giá trị mặc định:

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
apps/server/        Fastify + Socket.IO, orchestrator, các provider (claude, cursor, copilot, mock), Postgres (db.ts), bộ nhớ chung (memory.ts)
apps/web/           React dashboard + Phaser 3 (văn phòng 2D)
packages/shared/    Kiểu dữ liệu dùng chung (AgentEvent, Task, Approval…)
assets/             Pixel art: ảnh gốc, bản đã xử lý cho game, ảnh xem trước (xem assets/README.md)
tools/              Script Python xử lý asset
deploy/             Script khởi tạo Postgres (database cho Mem0)
```

Mọi provider đều phát ra cùng một kiểu `AgentEvent`. Mỗi event mang một `activity` (`thinking`, `search`, `code`, `write`, `approval`…), và game dựa vào đó để chọn chỗ nhân vật đi tới, tư thế, icon và bong bóng thoại. Muốn thêm provider mới thì viết một file trong `apps/server/src/providers/` theo interface `AgentProvider`.

## Lưu ý

- Bộ nhớ chung cũng có API: `GET /api/memory?q=&scope=office|agent|request&agentId=&runId=` (mọi người), `POST /api/memory`, `PUT` / `DELETE /api/memory/<id>` (admin).
- Dashboard hiển thị 100 task và 200 event gần nhất. Lịch sử cũ hơn lấy qua API: `GET /api/tasks?limit=50&before=<ms>&agentId=<id>` và `GET /api/tasks/<id>/events`.
- Khi mở dashboard ra Internet, đặt server sau HTTPS (reverse proxy) và đặt `PUBLIC_URL` là địa chỉ https.
