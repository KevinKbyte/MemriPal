# MemriPal

MemriPal turns any place you know into a memory palace for whatever you need to memorize: exam facts, a speech,
vocabulary. Photograph a familiar space (a room, a library aisle, a campus walk); SAM 3.1 segments distinct objects
into an ordered walking route of loci; Muse Spark splits your study list into items and writes a validated KAVE COGS
association tying each item to its locus; Muse Image renders each scene onto your photo. Spark then quizzes you by
walking the route and re-reviews the loci you miss. The full encode-and-recall loop runs live against the Meta Model
API or offline from recorded fixtures.

## Built during the hackathon (Oct 26 - Nov 4 2026)

All code in this repo was written during the Meta Global AI Hackathon 2026 (Indie track), starting 2026-10-26.

## APIs called

Via the Meta Model API (not original work):

- SAM 3.1: segments the photo into ordered loci.
- Muse Spark: splits the list, writes associations, runs the quiz.
- Muse Image: renders each mnemonic scene onto the photo.

## Modes

Set `MEMRIPAL_MODE`:

- `fixture` (default): offline replay of recorded responses under `fixtures/`; no network, no key.
- `meta`: live Meta Model API calls; requires `META_API_KEY` in the environment.

## Setup

```bash
uv sync
git config core.hooksPath .githooks
uv run python scripts/make_synthetic_fixtures.py
uv run uvicorn memripal.app:app
```

The pre-commit hook blocks staged files containing API keys/signed URLs or images carrying EXIF.

## Credits

The KAVE COGS association channels follow the method of Anthony Metivier (Magnetic Memory Method), paraphrased; none
of his material is copied.

## License

MIT
