# MemriPal

MemriPal turns any place you know into a memory palace for whatever you need to memorize: exam facts, a speech,
vocabulary. Photograph a familiar space (a room, a library aisle, a campus walk); SAM 3.1 segments distinct objects
into an ordered walking route of loci; Muse Spark splits your study list into items and writes a validated KAVE COGS
association tying each item to its locus; Muse Image renders each scene onto your photo. Spark then quizzes you by
walking the route and re-reviews the loci you miss. The full encode-and-recall loop runs live against the Meta Model
API or offline from recorded fixtures.

## Built during the hackathon (Oct 26 - Nov 4 2026)

Everything in this repo was created during the Meta Global AI Developer Hackathon (kickoff 2026-10-26); git history is the
record.

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

The pre-commit hook blocks staged files containing API keys/signed URLs or images carrying EXIF, and
staged `*.py` files that fail `uv run ruff format --check`.

Run all checks (ruff, pytest, node tests):

```bash
sh scripts/check.sh
```

## Live mode: Meta API key setup

1. Run once in your own PowerShell (prompts for the key; nothing lands in shell history or the repo):

   ```powershell
   New-Item -ItemType Directory -Force ~/.secrets | Out-Null; Read-Host "Meta API key" -AsSecureString | ConvertFrom-SecureString | Set-Content ~/.secrets/meta-api-key.dpapi
   ```

2. The file is DPAPI-encrypted to your Windows user account. Never put the key in `.env`, the repo, or chat.
3. Live mode (`MEMRIPAL_MODE=meta`) is started only by the developer via `scripts/run_live.ps1` (below). Default mode
   is fixture replay and needs no key.

The Meta Model API needs the hackathon credits claimed and a card on the Billing page before live calls work.

## Live probe / run_live

The developer runs these; Claude never runs live mode.

```powershell
powershell -File scripts/run_live.ps1 [-KeyFile <path>] uv run python scripts/probe_live.py --photo <demo photo>
```

- `run_live.ps1` decrypts the DPAPI key file (`-KeyFile <path>`, honored only as the FIRST argument; default
  `~/.secrets/meta-api-key.dpapi`) and sets
  `META_API_KEY` + `MEMRIPAL_MODE=meta` only in the child process env; it never writes or logs the key, and exits with
  the child's exit code (missing key file: exit 2). With no child command it starts the app
  (`uv run uvicorn memripal.app:app --port 8000`).
- `probe_live.py` exercises Spark, SAM 3.1 and Muse Image on one photo and writes `report.json` (+ `tier1.webp`,
  `tier2.webp`) to `fixtures/raw/probe/<UTC timestamp>/` (gitignored; override with `--out <dir>`). It reads the key
  only from `META_API_KEY` (unset, or photo not found: exit 2) and prints the kept-loci count and the 5 plan checks.
- Add `--audio <clip.wav>` (mono 16-bit WAV, 16 or 24 kHz) to also probe Meta speech-to-text:
  `powershell -File scripts/run_live.ps1 [-KeyFile <path>] uv run python scripts/probe_live.py --photo <demo photo>
  --audio <clip.wav>`; the report gains `asr_ok`, `asr_transcript_nonempty`, `asr_has_duration` and an `asr` block.

## Deploy

GCP Cloud Run with Secret Manager keys: [docs/runbooks/deploy-gcp.md](docs/runbooks/deploy-gcp.md).

## Architecture decisions

Options, pros/cons and rationale per decision: [docs/decisions/](docs/decisions/README.md).

## Credits

The KAVE COGS association channels follow the method of Anthony Metivier (Magnetic Memory Method), paraphrased; none
of his material is copied.

## License

MIT
