"""Publishing: turn a rendered clip into platform-ready metadata (and, later,
an actual upload). Kept separate from the render pipeline so you can publish a
workdir that's already done, and re-run publishing without re-rendering."""
