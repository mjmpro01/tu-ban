# Assets

Asset pixel art cho văn phòng AI agent. Gồm 3 thư mục:

- `source/`: ảnh gốc do AI tạo ra. **Không sửa trực tiếp file trong này.**
- `game/`: asset đã xử lý, game dùng thư mục này. File do script tạo ra.
- `preview/`: ảnh phóng to để xem nhanh. `preview/scene.png` là cảnh văn phòng ghép thử.

Tạo lại toàn bộ `game/` và `preview/` từ ảnh gốc:

```bash
pip install -r tools/requirements.txt
python tools/build_assets.py
```

Khi có ảnh gốc mới, ghi đè file trong `source/` (giữ đúng tên) rồi chạy lại lệnh trên.

## Nội dung `game/`

| File | Mô tả |
|---|---|
| `characters/char_<name>.png` | Spritesheet frame **32×32**, lưới 4 cột × 12 hàng. Nhân vật cao khoảng 30px, chân đặt ở đáy frame |
| `characters/characters.json` | Tên animation → chỉ số frame + frameRate (5 nhân vật dùng chung bố cục) |
| `portraits/portrait_<name>.png` | Chân dung **64×64** cho dashboard |
| `tiles/tiles_floor.png` + `.json` | 32 tile sàn **16×16** (gỗ, thảm cam/xanh, caro, xi măng, mép thảm) |
| `tiles/tiles_wall.png` + `.json` | Tile tường 16×16. Mặt tường cao 2 tile; cửa sổ và cửa ra vào rộng 2×2 tile; `wall_top` là tường nhìn từ trên xuống |
| `objects/objects.png` + `.json` | Atlas Phaser (JSON hash): 36 món nội thất + 8 món treo tường, gọi theo tên |
| `ui/emotes.png` + `.json` | 12 emote × 4 frame, mỗi frame 16×16 |
| `ui/bubbles.png` | 4 bong bóng 9-slice 24×24, góc 8px: `speech`, `thought`, `alert`, `error` |
| `ui/bubble_tails.png` | 4 đuôi bong bóng 8×8, cùng thứ tự với bong bóng |
| `ui/emote_frame.png` | Khung nền 20×20 cho emote |

`<name>` là một trong: `manager`, `researcher`, `writer`, `cursor`, `copilot`.

### Animation nhân vật (theo thứ tự hàng)

`idle_down`, `idle_up`, `idle_right`, `idle_left` (2 frame) ·
`walk_down`, `walk_up`, `walk_right`, `walk_left` (4 frame) ·
`type` (4) · `think` (2) · `doze` (2) · `ask` (2)

Các frame ngồi (`type`, `think`, `doze`) nhìn từ phía trước và đã được cân lại để cùng tỉ lệ đầu với frame đứng.

### Emote (theo thứ tự hàng)

`thinking`, `alert`, `question`, `sleep`, `angry`, `done`, `search`, `code`, `coffee`, `remote`, `handoff`, `celebrate`

## Ghi chú về ảnh gốc

- Tên file nhân vật trong bộ ảnh gen ra bị **tráo lẫn nhau**. File trong `source/characters/` đã được đổi lại theo đúng nhân vật trong ảnh.
- Hai file `furniture_meeting_source.png` và `furniture_decor_source.png` bị **tráo nội dung**. Giữ nguyên tên file; script đặt tên các món theo nội dung thật (xem `tools/process_environment.py`).
- Ảnh tường gốc có đường kẻ lưới vẽ xuyên qua tường. Script tự xoá các đường này trước khi cắt.
- Chưa có font chữ. Cần chọn một font pixel có license và hỗ trợ tiếng Việt có dấu.
