# Formula images are answered as placements, not as cache entries

Status: accepted

Both markdown passes need images, and each had grown its own idea of what the renderer offers: a cache lookup, a cell placement for a found entry, and a batched render of what was missing. Three names for one interface, and placing a single formula meant asking the cache twice, because the map the batched render returned was thrown away and the entry fetched again.

We decided the interface is one method: the formulas of a message go in, and a placement per request comes back in the same order, or nothing for a formula that could not be rendered. The renderer owns the render key, the index, the batched service call, the failure memory and the cell geometry. The passes own markdown, and they own image ids, because they place one image per occurrence.

## Considered options

- **Return entries and let callers ask for a cell placement.** This is what the code did, and it kept the cache and the pixel geometry on the interface, so every new caller had to learn both and remember to look the cache up a second time.
- **Return a map keyed by a render key or a request id.** Rejected: it puts a key convention across the seam. The test stubs had already drifted from production on that convention, which is the kind of bug a keyed lookup hides.
- **Place one formula at a time.** Rejected: a cold batch costs the same whether it holds one formula or thirty, so batching belongs to the renderer, and only the caller knows when a message's formulas have all been collected.

## Consequences

Cell geometry sits on the rendering side of the seam even though it is a terminal concern. That is deliberate: the ppi and cell size are part of the render key, so the party that decides whether a render is already cached is the only party that can answer in cells without risking a mismatch. A caller that needs a narrower block fits the rectangle it was given and does not re-render.
