# Math in a table cell is written the way the table renderer reads it

Status: accepted

A table is the one piece of markdown the inline pass does not own. pi's table
renderer sizes every column from the widest cell in it, pads the rest, and wraps
a cell that does not fit, all from the markdown source. The pass had treated a
table row as a paragraph, and a table with math in it broke in two ways.

A row longer than the available width was re-flowed, and the parser reads a line
break anywhere in a row as another row: the table came back with its columns
resized, cells moved into other columns, and spurious rows and rules, at 7
rendered lines where the same table rendered 5 without the transform. And a row
that did fit still lost the run of advance spaces a placement needs, because the
parser trims a cell's trailing whitespace: the cell then measured zero cells
wide, the column collapsed to the width of its header, and the image was drawn
across the cell border and into the next cell.

We decided a table is a unit the pass decides about as a whole. The scan marks
the lines the parser reads as one table (a header row, a delimiter row with as
many cells as the header, and the rows that follow), and the inline pass writes
each of them on one line, never re-flowed, with the placement's advance spaces
closed by the reset escape the image block already uses (`RESET_ESCAPE`), which
keeps them off the end of the cell. Whether a table can carry images at all is
decided for the table, before anything is placed: if the columns would exceed
the available width once the formulas are images, the table keeps its LaTeX and
pi's Unicode renderer typesets it. Math is also searched per cell rather than
per line, because a pipe ends a cell and a `$` pair that spans two of them is
not math to pi. A display block that begins on a table row is a row to the
parser rather than a block, so the display pass leaves it alone for the same
reason a cell's formula is left alone: a block's image line would end the table.

## Considered options

- **Leave tables alone.** This is what the code did, and it is what the previous
  diagnosis proposed, but a table is a place math is wanted and the extension
  exists to render it. Leaving the source in a table is not a safe default
  either: the row is re-flowed as a paragraph, which is the worse half of the
  bug.
- **Port the table renderer's column arithmetic and scale each placement into
  its final column.** Rejected: it duplicates an algorithm that belongs to pi and
  changes with it, and a formula scaled into a narrow column reads worse than
  the Unicode it replaces.
- **Pad each cell to its column ourselves.** Rejected: a column's width comes
  from every row of the table and from the wrapping pi does at render time, so a
  line-level pass cannot know it, and the parser trims the cell before the table
  measures it, so the width the pass adds is not the width the table sees. This
  is why the decision is taken for the whole table instead, and why a table that
  would not fit keeps its LaTeX.
- **Own the table's layout**, writing the rows as our own image lines with box
  drawing and placements inside them. Rejected: it reimplements GFM tables
  (wrapping, alignment, escaped pipes, inline styling), makes every row of every
  table an image line rather than only the rows with math, and would drift from
  pi's own table look.
- **Give the table renderer the measurement it needs**, so that a cell holding a
  placement measures the placement's `c=` cells and is treated as unbreakable.
  This is the cleaner fix and would retire the reset escape and the width test,
  but it is a change to pi, and the extension cannot wait on one.
- **Ask the parser for the table ranges instead of mirroring its rule.** Rejected
  for now: a table token carries its `raw` source but no offset, so mapping
  tokens back to lines is a scan of its own; the line scan already exists for
  fences, and its approximation is bounded in the safe direction.

## Consequences

- The parser's table rule is now in `structure.ts`, next to the fence rule, with
  its three surprises recorded: a row needs no pipe, a delimiter row must hold a
  `:` or a `|`, and the header and the delimiter row have to agree on their cell
  count. A parser change there is a change this code has to follow.
- Both passes consult the one fact the scan produces, so a cell's formula and a
  display block that begins on a table row cannot drift apart.
- The mirror is hand-written, so a markdown shape it has not been taught can stay
  unguarded. `test/structure.test.ts` pins the shapes it knows (quoted and
  list-item tables, dash-only delimiter rows, rows with no pipe, mismatched cell
  counts), and `test/table.test.ts` pins the rendered geometry through pi's own
  `Markdown` component, which is the seam where the reported breakage lived.
- The width test over-counts what a cell carries, because it measures the
  markdown source rather than pi's rendered inline text. A table pi could just
  fit may therefore keep its LaTeX. Erring this way is deliberate: the estimate
  can only accept a table the renderer will not shrink, and a shrunk column
  wraps the placement.
- A table row carrying math is an image line, so pi skips that row for selection
  and search highlighting, and a formula in a cell is clipped to one cell tall
  and rendered in the theme's text colour rather than a header's bold.
- A table that is a list item is detected through the item's content, but its
  rows are checked against the line as its container sees it, so a `- item` or a
  nested `> quote` under a table ends the table instead of being read as a row.
