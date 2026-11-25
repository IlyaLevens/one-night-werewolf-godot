#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    echo "Python 3.9 or newer is required."
    exit 1
  fi
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import sys; print("Python " + sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "The Python in .venv is too old or the environment is broken."
  echo "Install Python 3.9+, remove only this project's .venv folder and rerun."
  exit 1
fi
if ! .venv/bin/python -c 'import flask, waitress, mutagen' >/dev/null 2>&1; then
  .venv/bin/python install_dependencies.py
fi
exec .venv/bin/python app.py "$@"
