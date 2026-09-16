# pi-math-renderer

A pi extension that draws LaTeX math as real images inside pi's markdown, using the terminal's kitty graphics protocol. This context covers the transformer that decides what becomes an image, the geometry that makes an image land on the terminal grid, and the cache that keeps a repeat render free.

## Language

### The message

**Message**:
A block of markdown that pi hands to the transformer for rendering, which is user text, assistant text or thinking.
_Avoid_: content, document, output

**Transformer**:
The single entry point pi calls with a message, returning markdown in which some math has become images. It runs the display pass, then the inline pass.
_Avoid_: hook, plugin, renderer

**Streaming delta**:
A message that is still being written by the assistant.
_Avoid_: partial message, chunk

**Finalized message**:
A message the assistant has finished writing. The transformer runs again with `isStreaming` false, which is the pass that normally draws the images.
_Avoid_: complete message, message end

**In-flight rendering**:
Transforming streaming deltas as well as finalized messages. Off by default and experimental, because every delta re-scans the message and re-places its formulas.
_Avoid_: live rendering, streaming mode

### The two maths

**Math span**:
A run of LaTeX source in a message together with its delimiters. A span is source text, and the same source can appear in many spans.
_Avoid_: expression, snippet

**Formula**:
The mathematics a span asks to be typeset. Two spans with the same source and the same kind are the same formula, which is what makes one render serve many placements.
_Avoid_: equation, latex, math

**Display math**:
A formula typeset on its own, from `$$…$$` or `\[…\]` at the start of a line. Its image is snapped to whole cells in both directions.
_Avoid_: block math, centred math

**Inline math**:
A formula typeset inside a sentence, from `$…$`, `\(…\)` or `\[…\]` within a line. Its image is clipped to one cell tall, at any height, rather than scaled down.
_Avoid_: in-text math, sentence math

**Display pass**:
The transformer pass that replaces display math with image blocks.
_Avoid_: block pass, first pass

**Inline pass**:
The transformer pass that replaces inline math with one-row images inside their lines, and re-flows those lines.
_Avoid_: second pass, reflow pass

### Images in the terminal

**Placement**:
One image drawn on screen, occupying a rectangle of terminal cells starting where the cursor was. A formula can have many placements and only one render.
_Avoid_: image, picture, graphic

**Image line**:
A line carrying a placement. pi writes such a line verbatim, without wrapping or padding, which is why a pass that wants images in text has to own the line's layout.
_Avoid_: image row, escape line

**Image block**:
What a display formula becomes in the markdown: an image line followed by the filler lines that reserve the rest of the rectangle.
_Avoid_: image paragraph

**Filler line**:
A line that occupies one row of an image block's rectangle so that following content cannot land inside it.
_Avoid_: spacer, padding

**Cell**:
One terminal character cell. Placements are measured in cells, and a formula is rendered so that its image is an exact multiple of them.
_Avoid_: character, tile

**Baseline**:
The typst text size that is made exactly one cell tall. Formulas are rendered at a ppi derived from it, which is what keeps the cell grid exact.
_Avoid_: font size, line height

### Rendering and caching

**Render service**:
The external typst process that typesets formulas. Distinct from the renderer, which is this extension's module that calls it.
_Avoid_: renderer, typst service, backend

**Render key**:
Everything that changes the pixels of a formula: its source, its kind, the formula colour, the baseline, the cell size and the ppi. Two renders with the same key produce the same image.
_Avoid_: hash, cache key, id

**Render index**:
The record of which render keys already have an image on disk, so a formula is rendered once per key and then served from disk, including across restarts.
_Avoid_: cache, manifest

**Failed formula**:
A formula whose render failed and whose failure is remembered for the session, so it is not retried on every render. Its source stays in the message.
_Avoid_: bad formula, error case

**Formula colour**:
The colour formulas are rendered in, taken from the theme. It is part of the render key, so a theme switch produces new images rather than recolouring the old ones.
_Avoid_: text colour, theme colour

### Markdown structure

**Line structure**:
What a line is before any pass rewrites it: whether it is inside a fence, the block structure in front of its content, and whether it is indented code.
_Avoid_: line type, metadata

**Fence**:
A fenced code block. Its contents, markers included, are examples rather than markdown, so no pass transforms math inside one.
_Avoid_: code block (that is the general case; a fence is the backtick or tilde form)

**Block structure**:
The blockquote markers, list marker and indentation in front of a line's content, which a re-flowed line has to keep on every row it becomes.
_Avoid_: prefix, indentation

**Indented code**:
A line indented four columns, which markdown reads as code. Its LaTeX is left alone.
_Avoid_: code indent

**Inline re-flow**:
Rewriting a line into rows around its placements, because pi never wraps a line that carries one. The pass that does this owns the line's width arithmetic.
_Avoid_: wrap, word wrap

**Fullscreen mode**:
pi's alternate-screen TUI, where a redraw deletes every placement and re-emits only the rows it considers changed. Placements injected through markdown do not survive that, so the extension stays inactive there.
_Avoid_: alt screen
