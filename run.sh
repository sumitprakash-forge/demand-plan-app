#!/bin/bash
# Demand Plan App — One-command setup + start
# Usage: bash run.sh
# Prerequisites (do once, not handled here):
#   1. databricks auth login ... --profile=logfood
#   2. gcloud auth login --enable-gdrive-access

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BOLD}=== Demand Plan App ===${NC}"
echo ""

# ── Check Python ────────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}ERROR: python3 not found. Install Python 3.10+ from https://python.org${NC}"
  exit 1
fi
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo -e "  Python:  ${GREEN}${PY_VER}${NC}"

# ── Check Node ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}ERROR: node not found. Install Node.js 18+ from https://nodejs.org${NC}"
  exit 1
fi
NODE_VER=$(node --version)
echo -e "  Node:    ${GREEN}${NODE_VER}${NC}"

# ── Install backend dependencies ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installing backend dependencies...${NC}"
cd "$DIR/server"
pip3 install -q -r requirements.txt
echo -e "  ${GREEN}Done${NC}"

# ── Install frontend dependencies ────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installing frontend dependencies...${NC}"
cd "$DIR/frontend"
if [ ! -d "node_modules" ]; then
  npm install --silent
  echo -e "  ${GREEN}Done${NC}"
else
  # Only reinstall if package.json changed since last install
  if [ "package.json" -nt "node_modules/.package-lock.json" ] 2>/dev/null; then
    npm install --silent
    echo -e "  ${GREEN}Updated${NC}"
  else
    echo -e "  ${GREEN}Already installed (skipped)${NC}"
  fi
fi

# ── Start servers ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Starting servers...${NC}"
echo -e "  Backend:  ${GREEN}http://localhost:8000${NC}"
echo -e "  Frontend: ${GREEN}http://localhost:5173${NC}"
echo ""

cd "$DIR/server"
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1 2>&1 &
BACKEND_PID=$!

cd "$DIR/frontend"
npx vite --host 0.0.0.0 --port 5173 2>&1 &
FRONTEND_PID=$!

echo -e "Open ${BOLD}http://localhost:5173${NC} in your browser."
echo -e "Press ${BOLD}Ctrl+C${NC} to stop."
echo ""

trap "echo ''; echo 'Stopping...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
