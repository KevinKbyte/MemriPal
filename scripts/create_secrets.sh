#!/usr/bin/env bash
# Creates the Secret Manager secrets deploy_cloud_run.sh maps (runbook s3; ADR 0005, MEM-104):
#   memripal-access-key  generated if missing; printed ONCE for the Project Description
#   memripal-record-key  generated if missing; never printed
#   meta-api-key         from META_API_KEY if set; else decrypted from the DPAPI file at
#                        MEMRIPAL_META_KEY_FILE via powershell; else a hidden prompt on a terminal.
#                        New secret -> create, existing -> new version.
# Values are piped to gcloud --data-file=- with no trailing newline; the Meta key is never echoed or logged.
# Usage: sh scripts/create_secrets.sh   (Cloud Shell: bash scripts/create_secrets.sh)
# Env: GCP_PROJECT (default: gcloud config project);
#      MEMRIPAL_META_KEY_FILE (default: $HOME/.secrets/meta-api-key.dpapi);
#      META_API_KEY (optional; overrides the key file).
set -euo pipefail
set +x

# A Windows install puts gcloud under LOCALAPPDATA; a Git Bash child may not have it on PATH.
if ! command -v gcloud >/dev/null 2>&1 && [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  PATH="$(cygpath -u "$LOCALAPPDATA")/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"
fi
command -v gcloud >/dev/null 2>&1 || { echo "create_secrets: gcloud not found" >&2; exit 1; }

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project)}"
[ -n "$PROJECT" ] || { echo "create_secrets: no GCP project set" >&2; exit 1; }

exists() { gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; }
create() { # name value
  printf %s "$2" | gcloud secrets create "$1" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
  echo "created $1"
}
gen() { python -c "import secrets,sys;sys.stdout.write(secrets.token_urlsafe(24))"; }

if exists memripal-access-key; then
  echo "memripal-access-key exists, kept"
else
  access="$(gen)"
  create memripal-access-key "$access"
  echo "JUDGES' ACCESS KEY (put in the Project Description; shown once): $access"
  unset access
fi

if exists memripal-record-key; then echo "memripal-record-key exists, kept"; else create memripal-record-key "$(gen)"; fi

# The key-file path reaches powershell via the env, never argv; the Security module is imported by
# full path because a Git Bash child's PSModulePath can miss it.
PS_DECRYPT='$ErrorActionPreference='"'"'Stop'"'"'; Import-Module (Join-Path $PSHOME '"'"'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'"'"'); $s = ConvertTo-SecureString -String (Get-Content -LiteralPath $env:MEMRIPAL_META_KEY_FILE -Raw).Trim(); [Console]::Out.Write((New-Object System.Net.NetworkCredential('"''"', $s)).Password)'

meta="${META_API_KEY:-}"
if [ -z "$meta" ]; then
  KEYFILE="${MEMRIPAL_META_KEY_FILE:-$HOME/.secrets/meta-api-key.dpapi}"
  if [ -f "$KEYFILE" ]; then
    if command -v cygpath >/dev/null 2>&1; then win_path="$(cygpath -w "$KEYFILE")"; else win_path="$KEYFILE"; fi
    meta="$(MEMRIPAL_META_KEY_FILE="$win_path" powershell -NoProfile -NonInteractive -Command "$PS_DECRYPT")" \
      || { echo "create_secrets: could not decrypt $KEYFILE" >&2; exit 1; }
    meta="${meta%$'\r'}"
  elif [ -t 0 ]; then
    read -rsp "META_API_KEY not in env; paste it (hidden), then Enter: " meta; echo
  else
    echo "create_secrets: META_API_KEY unset and key file not found: $KEYFILE" >&2
    exit 1
  fi
fi
[ -n "$meta" ] || { echo "create_secrets: empty META_API_KEY" >&2; exit 1; }
if exists meta-api-key; then
  printf %s "$meta" | gcloud secrets versions add meta-api-key --project "$PROJECT" --data-file=- >/dev/null
  echo "added meta-api-key version"
else
  create meta-api-key "$meta"
fi
unset meta
