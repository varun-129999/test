# Scrabble Solver

Finds the highest-scoring legal move for Scrabble-style word games
(Words With Friends, Love Letters, etc.). Enforces the full crossword rule:
every perpendicular word created by a new tile must be a real word, so a
play like POUTS is rejected if it would simultaneously spell SVIRUS down
a column.

## Usage

```
python3 solver.py [board.json]
```

Edit `board.json` to describe your game:

- `board` — one string per row; letters are existing tiles, `.` is empty.
- `premiums` — same shape; `d`=DL, `t`=TL, `D`=DW, `T`=TW (only squares
  not yet covered by a tile matter).
- `rack` — your letters.
- `letter_values`, `bingo_bonus`, `dictionary` — scoring config. The
  bundled dictionary is ENABLE (`enable1.txt`), the base word list used by
  most mobile word games.

Output is the top 15 moves with placement coordinates (row/col, 1-indexed
from top-left), every word formed with its score, and a board diagram of
the best move (new tiles in lowercase).
