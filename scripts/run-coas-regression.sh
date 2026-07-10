#!/usr/bin/env bash

# Deliberately omit `set -e`: run_step owns failure handling so --continue can
# finish the suite and report every failed step.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLATFORM_ROOT="$(cd "${BACKEND_REPO}/.." && pwd)"
CODEPOD_REPO="/Users/jan/codepod-clean-filesafe"
CODEDEMO_REPO="${PLATFORM_ROOT}/codedemo-deploy"

CONTINUE_ON_FAILURE=0
LIVE_REQUESTED=0
FAILURES=()

usage() {
  cat <<'EOF'
Usage: scripts/run-coas-regression.sh [--continue] [--live]

  --continue  Run all standard steps and report every failure.
  --live      Request the live suite. This is currently a gated placeholder.
EOF
}

for argument in "$@"; do
  case "${argument}" in
    --continue)
      CONTINUE_ON_FAILURE=1
      ;;
    --live)
      LIVE_REQUESTED=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: ${argument}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${LIVE_REQUESTED}" -eq 1 ]]; then
  if [[ "${COAS_LIVE:-0}" != "1" ]]; then
    echo "ERROR: --live requires COAS_LIVE=1." >&2
    exit 2
  fi
  if [[ -z "${COAS_API_BASE:-}" ]]; then
    echo "ERROR: --live requires an explicit COAS_API_BASE target." >&2
    exit 2
  fi
  if [[ "${COAS_ALLOW_PRODUCTION:-0}" != "1" ]]; then
    echo "ERROR: Live regression is blocked without COAS_ALLOW_PRODUCTION=1." >&2
    exit 2
  fi
fi

require_repo() {
  local label="$1"
  local path="$2"
  local marker="$3"

  if [[ ! -d "${path}" ]]; then
    echo "ERROR: ${label} repository directory is missing: ${path}" >&2
    exit 2
  fi
  if [[ ! -e "${path}/${marker}" ]]; then
    echo "ERROR: ${label} repository marker is missing: ${path}/${marker}" >&2
    exit 2
  fi
}

require_file() {
  local path="$1"

  if [[ ! -f "${path}" ]]; then
    echo "ERROR: Required regression file is missing: ${path}" >&2
    exit 2
  fi
}

report_repo_state() {
  local label="$1"
  local path="$2"

  echo
  echo "--- ${label}: ${path}"
  if git -C "${path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "branch: $(git -C "${path}" branch --show-current)"
    echo "status:"
    git -C "${path}" status --short
  else
    echo "git: not a Git repository"
  fi
}

check_playwright_ports() {
  local port

  echo
  echo "--- Playwright port pre-check"
  if ! command -v lsof >/dev/null 2>&1; then
    echo "WARN: lsof is unavailable; ports 4173 and 5176-5180 were not checked."
    return 0
  fi

  for port in 4173 5176 5177 5178 5179 5180; do
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "WARN: Port ${port} is already in use. Existing processes are left untouched."
      lsof -nP -iTCP:"${port}" -sTCP:LISTEN
    else
      echo "OK: Port ${port} is available."
    fi
  done
}

run_step() {
  local label="$1"
  local repo="$2"
  shift 2

  echo
  echo "==> ${label}"
  echo "    repo: ${repo}"
  echo "    command: $*"

  if (cd "${repo}" && "$@"); then
    echo "PASS: ${label}"
    return 0
  fi

  echo "FAIL: ${label}" >&2
  FAILURES+=("${label}")

  if [[ "${CONTINUE_ON_FAILURE}" -eq 0 ]]; then
    exit 1
  fi
}

CODETONE_REPO="${PLATFORM_ROOT}/codenxt-final-deploy"
CODEPERKS_REPO="${PLATFORM_ROOT}/codeperks-deploy"
CODEPAGE_REPO="${PLATFORM_ROOT}/codepage-deploy"
CODESTACK_REPO="${PLATFORM_ROOT}/codestack-deploy"
CODECLIP_REPO="${PLATFORM_ROOT}/codeclip-deploy"
BACKEND_TESTS=("${BACKEND_REPO}"/*.test.js)

require_repo "Backend" "${BACKEND_REPO}" "server.js"
require_repo "codeDemo" "${CODEDEMO_REPO}" "playwright.coas.config.js"
require_repo "codeTone" "${CODETONE_REPO}" "playwright.config.js"
require_repo "codePerks" "${CODEPERKS_REPO}" "playwright.config.js"
require_repo "codePage" "${CODEPAGE_REPO}" "playwright.config.js"
require_repo "codeStack" "${CODESTACK_REPO}" "playwright.config.js"
require_repo "codePod" "${CODEPOD_REPO}" "playwright.config.ts"
require_repo "codeClip" "${CODECLIP_REPO}" "playwright.config.ts"

require_file "${CODEDEMO_REPO}/package.json"
require_file "${CODEDEMO_REPO}/playwright.coas.config.js"
require_file "${CODEDEMO_REPO}/tests/codedemo-coas-regression.spec.js"
require_file "${CODETONE_REPO}/tests/codetone-exclusive-runtime.spec.js"
require_file "${CODETONE_REPO}/tests/codetone-product-journey.spec.js"
require_file "${CODEPERKS_REPO}/tests/codeperks-product-journey.spec.js"
require_file "${CODEPERKS_REPO}/tests/codeperks-join-reward.spec.js"
require_file "${CODEPAGE_REPO}/tests/codepage-product-journey.spec.js"
require_file "${CODESTACK_REPO}/tests/codestack-product-journey.spec.js"
require_file "${CODEPOD_REPO}/e2e/codepod-screen-video-guardrail.spec.ts"
require_file "${CODECLIP_REPO}/frontend-vertical-isolation.test.js"

echo "COAS regression suite"
echo "Backend: ${BACKEND_REPO}"
echo "Mode: standard mock/local regression"
echo "Execution: sequential"

report_repo_state "Backend" "${BACKEND_REPO}"
report_repo_state "codeDemo" "${CODEDEMO_REPO}"
report_repo_state "codeTone" "${CODETONE_REPO}"
report_repo_state "codePerks" "${CODEPERKS_REPO}"
report_repo_state "codePage" "${CODEPAGE_REPO}"
report_repo_state "codeStack" "${CODESTACK_REPO}"
report_repo_state "codePod" "${CODEPOD_REPO}"
report_repo_state "codeClip" "${CODECLIP_REPO}"
check_playwright_ports

run_step "Backend test suite" "${BACKEND_REPO}" node --test "${BACKEND_TESTS[@]}"
run_step "Backend syntax check" "${BACKEND_REPO}" node --check server.js

run_step "codeDemo build" "${CODEDEMO_REPO}" npm run build
run_step "codeDemo mock regression" "${CODEDEMO_REPO}" \
  npm run test:coas -- --project=chromium

run_step "codeTone build" "${CODETONE_REPO}" npm run build
run_step "codeTone COAS regression" "${CODETONE_REPO}" \
  npm run test:coas -- --project=chromium

run_step "codePerks build" "${CODEPERKS_REPO}" npm run build
run_step "codePerks mock regression" "${CODEPERKS_REPO}" \
  npm run test:e2e -- \
  tests/codeperks-product-journey.spec.js \
  tests/codeperks-join-reward.spec.js \
  --project=chromium

run_step "codePage build" "${CODEPAGE_REPO}" npm run build
run_step "codePage mock regression" "${CODEPAGE_REPO}" \
  npm run test:e2e -- tests/codepage-product-journey.spec.js --project=chromium

run_step "codeStack build" "${CODESTACK_REPO}" npm run build
run_step "codeStack mock regression" "${CODESTACK_REPO}" \
  npm run test:e2e -- tests/codestack-product-journey.spec.js --project=chromium

run_step "codePod build" "${CODEPOD_REPO}" npm run build
run_step "codePod containment guardrail" "${CODEPOD_REPO}" \
  npm run test:e2e -- e2e/codepod-screen-video-guardrail.spec.ts --project=chromium

run_step "codeClip frontend isolation guardrail" "${CODECLIP_REPO}" \
  node --test frontend-vertical-isolation.test.js
run_step "codeClip build" "${CODECLIP_REPO}" npm run build

if [[ "${LIVE_REQUESTED}" -eq 1 ]]; then
  echo
  echo "LIVE PLACEHOLDER: Target approved: ${COAS_API_BASE}"
  echo "No live tests are configured or executed yet."
fi

echo
if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  echo "COAS regression completed with ${#FAILURES[@]} failure(s):" >&2
  printf ' - %s\n' "${FAILURES[@]}" >&2
  exit 1
fi

echo "COAS regression completed successfully. Standard package ran every active COAS vertical."
