"""Install the bundled dependencies without contacting PyPI or changing system proxy settings."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys


def install_environment():
    # Ignore pip configuration only inside the installer subprocess. A configured
    # remote find-links URL can otherwise cause network requests even with no-index.
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith('PIP_')
                   and key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}}
    environment.update(PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK='1',
                       PIP_NO_INPUT='1', PIP_NO_INDEX='1')
    return environment


def main():
    if sys.version_info < (3, 9):
        print('Python 3.9 or newer is required.')
        return 1
    if sys.prefix == sys.base_prefix:
        print('Run this installer inside the game virtual environment:')
        print(r'.venv\Scripts\python.exe install_dependencies.py' if os.name == 'nt'
              else '.venv/bin/python install_dependencies.py')
        return 1
    root = Path(__file__).resolve().parent
    wheels = root / 'wheels'
    requirements = root / 'requirements-offline.txt'
    if not requirements.is_file() or not wheels.is_dir() or not any(wheels.glob('*.whl')):
        print('Offline packages are missing. Extract the complete game archive, including wheels.')
        return 1
    environment = install_environment()
    if importlib.util.find_spec('pip') is None:
        print('Restoring pip from the Python installation...', flush=True)
        result = subprocess.run([sys.executable, '-m', 'ensurepip', '--upgrade'], env=environment)
        if result.returncode:
            return result.returncode
    print('Installing bundled packages OFFLINE. No internet connection is needed.', flush=True)
    result = subprocess.run([
        sys.executable, '-m', 'pip', '--disable-pip-version-check', 'install',
        '--no-index', '--find-links', str(wheels), '--only-binary=:all:',
        '--no-cache-dir', '--force-reinstall', '--require-hashes',
        '-r', str(requirements),
    ], cwd=str(root), env=environment)
    if result.returncode:
        print('Offline installation failed. Keep the error above and check that the archive was fully extracted.')
        return result.returncode
    # Check imports in a fresh process so earlier failed imports cannot hide a repair.
    result = subprocess.run([sys.executable, '-c', 'import flask, waitress, mutagen; print("Game dependencies are ready.")'],
                            cwd=str(root), env=environment)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
