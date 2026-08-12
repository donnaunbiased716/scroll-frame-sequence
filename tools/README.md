# tools

Four scripts. They only need `ffmpeg`, `ffprobe`, Pillow and numpy — no build
step, no framework, no service.

| script | what it is for |
|---|---|
| `extract_frames.py` | video → numbered frame sequence (uniform or motion-weighted) |
| `build_spritesheet.py` | frame sequence → one spritesheet + the grid numbers your player needs |
| `make_loop.py` | short clip → hold-loop frames, and an honest verdict on whether it can loop |
| `contact_sheet.py` | any of the above → a numbered contact sheet for review |

```bash
pip install -r requirements.txt
```

Every script prints the numbers you have to hand to the player (grid size, CSS
offset formula, loop mode, cycle length) rather than leaving you to work them out.
