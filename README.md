# pi-math-renderer

A pi extension that renders LaTeX math as real images inside pi's markdown, using the kitty graphics protocol.

Instead of reading `∫₀¹ x² dx = 1/3` as a line of Unicode, the formula is typeset by [typst](https://typst.app) (LaTeX via [MiTeX](https://github.com/mitex-rs/mitex)) and drawn as an image in place of the source, in the current theme's text colour.

```
$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$
```

becomes a formula spanning as many terminal cells as it needs, and scrolls, resizes and redraws like ordinary text. Display math and inline math both render: an inline `$x^{2}$` becomes a one-cell-tall image inside its sentence, cut at the cell edges rather than scaled down, and streamed messages render as they arrive.

## Requirements

- pi's default `regular` TUI mode (see [Limitations](#limitations))
- A terminal whose kitty graphics support includes the parts the placement uses: PNG images (`f=100`) transmitted by **file path** (`t=f`), `C=1` (the host owns cursor movement) and `q=2` (which also means an unsupported command fails silently rather than drawing a fallback). Detection uses pi-tui's capability probe, which only distinguishes the protocol, not these features; `PI_IMAGE_PROTOCOL` overrides it if a terminal is mis-detected.
- The render service from [math-conceal.nvim](https://github.com/pxwg/math-conceal.nvim):

  ```vim
  :Rocks install math-conceal-service
  ```

  or a source build of `service/` from that repository. The extension looks for `typst-concealer-service` in the rocks tree (`$XDG_DATA_HOME/nvim/rocks/bin`), then on `PATH`.

The service embeds typst, so no LaTeX or typst toolchain is needed. The MiTeX package itself (`@preview/mitex`) comes from typst's package cache: a previous math-conceal render or a `:Rocks install` populates it, and **the first render of a formula on a machine where it is missing fetches it from the network**. For an offline or air-gapped setup, pre-populate the cache or point `TYPST_PACKAGE_PATH` (a directory of already unpacked packages) and `TYPST_PACKAGE_CACHE_PATH` at it; those are the service's own environment variables.

## Install

Install this directory as a local pi package:

```bash
pi install /path/to/math-renderer
```

Or load it for a single run:

```bash
pi --extension /path/to/math-renderer/src/index.ts
```

## How it works

1. A [markdown transformer](https://github.com/earendil-works/pi) scans each rendered message for math, using the same rules as pi's own renderer. pi runs the hook for user, assistant and thinking markdown only, so tool output is never transformed, and neither is Markdown rendered by other components. Display math is `$$…$$` or `\[…\]` at the start of a line (at most three leading spaces), closing at end of line; inline math is `$…$`, `\(…\)` or `\[…\]` inside a line, with pi's guards against prices, `A_B` identifiers, whitespace-padded bodies and code spans. Fenced code blocks and indented code blocks are skipped.
2. Uncached formulas are rendered in one batch by the math-conceal service (`render_formulas` over stdio JSON). The service is invoked synchronously so the image exists while the line is being produced; a cold batch costs ~140 ms regardless of how many formulas it contains, and cached formulas never reach the service.
3. Streaming messages are transformed too, so a `$$…$$` block becomes an image on the delta that closes it instead of when the message is delivered. Nothing half-written reaches typst: a block only matches once its closing delimiter is at end of line, and a formula whose source is still changing simply keeps its LaTeX until it settles.
4. Each formula becomes an image line plus blank filler lines: a kitty placement (`c`x`r` cells, transmitted by file path, `C=1` so the terminal does not move the cursor) followed by the blank lines that occupy the rest of the rectangle. pi writes image lines verbatim and pads the filler lines, so the image occupies its rows without pi needing to know anything about images.
5. Every placement is drawn with its own image id, and the id stays inside signed 32-bit. pi tracks images by the id on a line, and deleting that id removes *every* placement carrying it, so two placements that shared an id would erase each other; a negative id is dropped by the terminal outright.
6. The image line starts with a reset escape before its centring spaces: a markdown line whose first character is a space would be indented by four or more columns and read as a code block.
7. Inline math is placed at the cursor with `r=1` and the cursor is advanced over it with spaces, so the image occupies its cell run inside the line. pi never wraps a line that carries a placement, so the pass re-flows the line itself: each placement is an unbreakable run of `cols` cells, the source line's block structure (indentation, `> ` markers, list alignment) is repeated on continuation rows, and a line that cannot be made to fit — a formula wider than the whole line — keeps its LaTeX for pi's Unicode renderer.

Inline formulas are rendered in MiTeX's inline mode and clipped to exactly one cell (`clip: true`, `align(horizon)` — the anchor math-conceal.nvim uses). A formula taller than the line is **cut** at the cell edges rather than scaled down, so its size stays consistent with the surrounding text; upstream grows the box above 1.5 cells and scales that whole image back into one row, which would shrink the formula mid-sentence.

Geometry is exact rather than approximate: formulas are rendered at a ppi that maps the 11pt baseline onto one cell height, and the typst document snaps the formula box to whole cells, so a 13x3 cell placement is a 13x3 cell image.

Rows are deliberately *not* one line per image row. pi renders one markdown paragraph per line, and consecutive paragraphs are separated by an empty line, which would cut a multi-row image into bands. The `test/image-block.test.ts` layout test renders the block through pi's own `Markdown` component and asserts the block occupies exactly as many lines as the image has rows.

## Caching

`~/.pi/agent/math-renderer/` holds the rendered PNGs and an `index.json` mapping render kind to file. The key covers the LaTeX source, theme colour, baseline, cell size and ppi, so:

- a formula renders once per machine, colour, cell size, ppi and display kind, then is served from disk,
- switching themes re-renders formulas in the new colour (pi invalidates its render cache on a theme change, which re-runs the transformer),
- a failure (unsupported LaTeX, missing package) is remembered for the session instead of retrying on every render.

Nothing evicts this cache: PNGs and index entries accumulate, one per distinct key, and `PI_MATH_RENDERER_DEBUG` appends to `debug.log` without rotating. `rm -rf ~/.pi/agent/math-renderer` resets it; the next render rebuilds what it needs (roughly 140 ms per batch).

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_MATH_RENDERER` | on | `0` disables the extension |
| `PI_MATH_RENDERER_SERVICE` | auto | Path or name of `typst-concealer-service` |
| `PI_MATH_RENDERER_COLOR` | theme text colour | `#rrggbb` override for formula colour |
| `PI_MATH_RENDERER_BASELINE_PT` | `11` | Typst baseline, one baseline equals one cell |
| `PI_MATH_RENDERER_PPI` | derived | Override the derived ppi (see below) |
| `PI_MATH_RENDERER_TIMEOUT_MS` | `30000` | Per-batch service timeout |
| `PI_MATH_RENDERER_DEBUG` | off | Append a log to `~/.pi/agent/math-renderer/debug.log` |

CLI flag and command:

- `--no-math-images` disables rendering for one run
- `/math-renderer` reports whether rendering is active, which service binary is in use, and the baseline

`PI_MATH_RENDERER_PPI` is a diagnostic override. The derived value is what makes one typst baseline exactly one terminal cell, so the typst box snaps to whole cells and `px -> cells` stays exact; an arbitrary ppi generally breaks that and the placement is scaled to a rounded cell box. Leave it unset unless you are chasing a rendering problem.

The transformer runs inside pi's render path, so a formula that is not cached yet blocks the frame for the length of one service call (~140 ms) — once per formula, at the moment it first appears; every later redraw, including each streaming delta, is served from the cache. A transform renders all of its uncached formulas in that single call, because one batch costs the same as one formula and a deferred render has no reliable second chance.

## Limitations

- **A formula wider than the line stays as LaTeX.** Kitty placements cannot be split across terminal rows, so a formula that needs more than the full content width (a wide matrix, say) is left to pi's Unicode renderer. Multi-line inline math (`$…$` spanning lines) is also left alone.
- **Inline math makes its whole line an image line to pi.** Such a line is written verbatim, which is what lets the re-flow own the layout — but pi then skips it for selection and search highlighting. The text is still in the session for the model, and copying reads the line with the escapes stripped.
- **Fullscreen TUI mode is not supported.** pi's alternate-screen renderer manages images itself, from a metadata registry that only its own `Image` component populates. A placement injected through markdown is not in that registry, so a frame that needs an image redraw deletes every placement and re-emits only the rows it changed — the markdown image lines above come back blank. In `fullscreen` mode the extension stays inactive and display math falls back to pi's Unicode renderer.
- **Kitty graphics only.** Detection uses pi-tui's terminal capabilities; `PI_IMAGE_PROTOCOL` overrides it.
- **A formula is one image line to pi.** pi can only reserve rows for an image whose following lines are zero-width, and markdown pads every non-image line to the full width, so a block is booked as a single image row. A formula placed on the last row of the viewport is therefore clipped by the terminal until the screen next scrolls; kitty keeps the whole placement and redraws it complete at the new position.
- **Formulas are images:** they cannot be selected or copied as text, and the LaTeX source remains in the session for the model.

## Development

```bash
npm install
npm run check     # typecheck + unit tests
```

Unit tests cover kitty command building, cell geometry, typst document shape, markdown scanning, the transform pass (including the streaming path), block assembly and image ids, the render index, configuration guards, and the rendered line structure of an image block.

There is no automated terminal test. These kitty behaviours were established by driving a hidden kitty window through `kitty-use` and reading the captured pixels; they are the constraints the placement code is built around:

- `i=` ids are accepted up to 32-bit unsigned, but a placement with a **negative** id is dropped with no response at all (`q=2` silences the error). JavaScript's `&` turns any id above 2^31 negative, which is why ids are clamped numerically instead.
- `d=I,i=<id>` deletes the image data **and every placement** of that id, so an id must never be shared.
- Erasing a line (`CSI 2 K`) does not remove a placement that overlaps it.
- A placement that extends past the bottom row is clipped, and kitty redraws it whole once the content scrolls.
- Placements get a fresh image id on every transform, because ids must never be shared. A streaming message is transformed on every delta, so its placements are re-emitted each time — about 100 bytes each and no image data, since `t=f` only sends the path.

When capturing a screen for pixel checks: a framebuffer thumbnail only reflects the most recent frame, so an image drawn earlier comes back missing even though it is on screen. Redraw the frame you want to inspect before capturing.

## Acknowledgements

- [math-conceal.nvim](https://github.com/pxwg/math-conceal.nvim) — the cell-grid sizing (`grid.lua`), the typst snapping wrapper (`image/wrapper.lua`) and the styling prelude are ports of its Lua implementation, and the render service is its Rust binary. Its Unicode-placeholder encoding is deliberately *not* used: pi writes a line carrying an escape verbatim, so a placeholder grid cannot span rows here.
- [MiTeX](https://github.com/mitex-rs/mitex) — LaTeX parsing for typst.
