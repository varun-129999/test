#!/usr/bin/env python3
"""Scrabble-style solver: finds the highest-scoring legal move.

Rules enforced (standard crossword rules, per the game):
  - The main word you form must be a real dictionary word.
  - EVERY perpendicular word created by a newly placed tile must also be a
    real word (so POUT+S is only legal if the column it touches still reads
    a real word -- S on top of VIRUS making SVIRUS is rejected).
  - New tiles must all sit in one row/column, fill the gaps contiguously,
    and connect to the existing tiles.

Scoring: letter premiums (DL/TL) and word premiums (DW/TW) apply only to
newly placed tiles; premiums stack across all words formed this turn; a
7-tile play earns the bingo bonus.

Usage:
    python3 solver.py [board.json]      # defaults to board.json next to this file
"""

import json
import sys
from collections import Counter
from pathlib import Path

EMPTY = "."


def load_config(path):
    cfg = json.loads(Path(path).read_text())
    board = [list(row.upper().replace(" ", EMPTY)) for row in cfg["board"]]
    prem = [list(row) for row in cfg["premiums"]]
    size = len(board)
    assert all(len(r) == size for r in board), "board must be square"
    assert len(prem) == size and all(len(r) == size for r in prem)
    return {
        "board": board,
        "prem": prem,
        "size": size,
        "rack": cfg["rack"].upper(),
        "values": {k.upper(): v for k, v in cfg["letter_values"].items()},
        "bingo": cfg.get("bingo_bonus", 35),
        "dictionary": cfg.get("dictionary", "enable1.txt"),
    }


def load_words(path, max_len):
    words = set()
    with open(path) as f:
        for line in f:
            w = line.strip().upper()
            if 2 <= len(w) <= max_len and w.isalpha():
                words.add(w)
    return words


def transpose(grid):
    return [list(row) for row in zip(*grid)]


def runs(board, size):
    """For each empty square, the contiguous letters above and below it."""
    up = [[""] * size for _ in range(size)]
    down = [[""] * size for _ in range(size)]
    for r in range(size):
        for c in range(size):
            if board[r][c] != EMPTY:
                continue
            i = r - 1
            while i >= 0 and board[i][c] != EMPTY:
                i -= 1
            up[r][c] = "".join(board[k][c] for k in range(i + 1, r))
            i = r + 1
            while i < size and board[i][c] != EMPTY:
                i += 1
            down[r][c] = "".join(board[k][c] for k in range(r + 1, i))
    return up, down


def gen_direction(board, prem, size, words, rack, values, bingo, flip):
    """All legal horizontal moves on `board` (call with the transposed board
    for vertical moves; `flip` restores real coordinates)."""
    rack_count = Counter(rack)
    up, down = runs(board, size)
    moves = []
    board_letters = Counter(ch for row in board for ch in row if ch != EMPTY)
    usable = set(rack) | set(board_letters)

    for word in words:
        if not set(word) <= usable:
            continue
        L = len(word)
        need_all = Counter(word)
        # quick impossibility check: more copies of a letter than rack+board hold
        if any(need_all[ch] > rack_count[ch] + board_letters[ch] for ch in need_all):
            continue
        for r in range(size):
            row = board[r]
            for c in range(size - L + 1):
                if c > 0 and row[c - 1] != EMPTY:
                    continue
                if c + L < size and row[c + L] != EMPTY:
                    continue
                placed, ok, connected = [], True, False
                for i in range(L):
                    b = row[c + i]
                    if b != EMPTY:
                        if b != word[i]:
                            ok = False
                            break
                        connected = True
                    else:
                        placed.append((c + i, word[i]))
                if not ok or not placed:
                    continue
                need = Counter(ch for _, ch in placed)
                if any(need[ch] > rack_count[ch] for ch in need):
                    continue

                main = 0
                mult = 1
                cross_total = 0
                cross_words = []
                for i in range(L):
                    cc = c + i
                    ch = word[i]
                    if row[cc] != EMPTY:
                        main += values[ch]
                        continue
                    p = prem[r][cc]
                    lv = values[ch] * (2 if p == "d" else 3 if p == "t" else 1)
                    wm = 2 if p == "D" else 3 if p == "T" else 1
                    main += lv
                    mult *= wm
                    u, d = up[r][cc], down[r][cc]
                    if u or d:
                        cw = u + ch + d
                        if cw not in words:
                            ok = False
                            break
                        connected = True
                        cs = (sum(values[x] for x in u + d) + lv) * wm
                        cross_total += cs
                        cross_words.append((cw, cs))
                if not ok or not connected:
                    continue
                total = main * mult + cross_total
                if len(placed) == len(rack):
                    total += bingo
                tiles = [(flip(r, cc), ch) for cc, ch in placed]
                moves.append(
                    {
                        "word": word,
                        "score": total,
                        "start": flip(r, c),
                        "dir": "across" if flip(0, 1) == (0, 1) else "down",
                        "tiles": tiles,
                        "words": [(word, main * mult)] + cross_words,
                        "bingo": len(placed) == len(rack),
                    }
                )
    return moves


def solve(cfg, words):
    h = gen_direction(
        cfg["board"], cfg["prem"], cfg["size"], words, cfg["rack"],
        cfg["values"], cfg["bingo"], lambda r, c: (r, c),
    )
    v = gen_direction(
        transpose(cfg["board"]), transpose(cfg["prem"]), cfg["size"], words,
        cfg["rack"], cfg["values"], cfg["bingo"], lambda r, c: (c, r),
    )
    moves = h + v
    moves.sort(key=lambda m: -m["score"])
    return moves


def render(cfg, move):
    grid = [row[:] for row in cfg["board"]]
    for (r, c), ch in move["tiles"]:
        grid[r][c] = ch.lower()
    lines = ["    " + " ".join(f"{i+1:>2}" for i in range(cfg["size"]))]
    for r, row in enumerate(grid):
        cells = []
        for c, ch in enumerate(row):
            if ch == EMPTY:
                p = cfg["prem"][r][c]
                cells.append({"d": "dl", "t": "tl", "D": "DW", "T": "TW"}.get(p, " ."))
            else:
                cells.append(" " + ch)
        lines.append(f"{r+1:>3} " + " ".join(cells))
    return "\n".join(lines)


def main():
    here = Path(__file__).parent
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else here / "board.json"
    cfg = load_config(cfg_path)
    dict_path = Path(cfg["dictionary"])
    if not dict_path.is_absolute():
        dict_path = here / dict_path
    words = load_words(dict_path, cfg["size"])
    moves = solve(cfg, words)
    if not moves:
        print("No legal moves found.")
        return
    seen = set()
    shown = 0
    print(f"Rack: {cfg['rack']}   ({len(moves)} legal moves found)\n")
    for m in moves:
        key = (m["word"], m["start"], m["dir"])
        if key in seen:
            continue
        seen.add(key)
        shown += 1
        r, c = m["start"]
        tiles = ", ".join(f"{ch}@r{tr+1}c{tc+1}" for (tr, tc), ch in m["tiles"])
        ws = " + ".join(f"{w}({s})" for w, s in m["words"])
        star = "  *BINGO*" if m["bingo"] else ""
        print(f"{m['score']:>4}  {m['word']:<12} {m['dir']:<6} from r{r+1}c{c+1}  "
              f"place: {tiles}  words: {ws}{star}")
        if shown == 1:
            print("\n" + render(cfg, m) + "\n")
        if shown >= 15:
            break


if __name__ == "__main__":
    main()
