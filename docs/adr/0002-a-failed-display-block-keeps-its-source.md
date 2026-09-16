# A display block that fails to render keeps its source

Status: accepted

A display formula can fail to render: unsupported LaTeX, a missing package, an unreachable service. When that happens the block stays in the message as its LaTeX source, and the inline pass leaves the line alone.

The inline pass defers to the display pass for any line that begins display math, `\[…\]` as well as `$$…$$`. The rule comes from one predicate, so a block is treated the same way whichever delimiter it used. Before this rule was shared, the inline pass skipped lines starting with `$$` but not lines starting with `\[`, so a single-line `\[x^2\]` block whose display render had failed was typeset as inline math: a second render under a second key, drawn as a one-cell-tall clipped image of a formula that was meant to be displayed.

## Considered options

- **Fall back to inline typesetting when a display render fails.** Rejected: it shows a display formula as a clipped one-row image, it costs a second render under a different key for a formula that just failed, and it makes the same failure look different depending on which delimiter the author used.
- **Fall back to pi's own Unicode rendering of the LaTeX.** Not ours to choose: leaving the source in the message is what hands the block back to pi, which typesets it however it typesets any other math in an unrendered message.

## Consequences

A message can show raw LaTeX for a formula that failed, which is intended. The failure is remembered for the session, so a broken formula does not respawn the service on every render, and the source stays visible rather than silently vanishing.
