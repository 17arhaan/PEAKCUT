# studio/

Everything Peakcut generates, in one place (was scattered across the Desktop).

```
brand/     logos, avatar, banners — the channel/site identity assets
gallery/   clip runs: <YYYY-MM-DD>_<name>/NN_Hook_Title.mp4 (+ .jpg thumb, run.json receipt)
```

Export any pipeline run into the gallery with proper names:

```bash
cd worker && uv run shorts export --from <workdir> --name my-video-slug
```

Media-heavy: everything here except this README is gitignored.
