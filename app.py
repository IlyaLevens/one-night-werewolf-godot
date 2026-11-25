"""HTTP API и раздача интерфейса. Запуск: python app.py."""
import sys

if sys.version_info < (3, 9):
    raise SystemExit(
        "Нужен Python 3.9 или новее. Сейчас запущен Python "
        + sys.version.split()[0]
        + ". Установите подходящий Python и пересоздайте папку .venv проекта."
    )

import argparse
from collections import defaultdict, deque
import os
import socket
import time
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException

from werewolf.game import GameService, GameError, require
from werewolf.roles import ROLES
from werewolf.music import MusicCatalog, MUSIC_TYPES


def create_app(service=None):
    app = Flask(__name__)
    app.config.update(MAX_CONTENT_LENGTH=8192, MUSIC_DIR=str(Path(app.root_path) / "music"))
    game = service or GameService()
    music_catalog = MusicCatalog()
    game.music_tracks = lambda: music_catalog.tracks(app.config['MUSIC_DIR'])
    app.extensions["game"] = game
    attempts = defaultdict(deque)

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; form-action 'self'")
        return response

    @app.errorhandler(GameError)
    def game_error(error):
        return jsonify(error=str(error)), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        messages = {400: "Некорректный запрос.", 404: "Адрес не найден.",
                    413: "Слишком большой запрос.", 415: "Ожидается JSON."}
        return jsonify(error=messages.get(error.code, "Запрос не выполнен.")), error.code

    def body():
        require(request.is_json, "Ожидается JSON.", 415)
        data = request.get_json()
        require(isinstance(data, dict), "Ожидается объект JSON.")
        return data

    def rate_limit():
        # Не доверяем клиентским X-Forwarded-For; лимит достаточно велик для общей Wi-Fi сети.
        now = time.monotonic()
        for key in list(attempts):
            if not attempts[key] or now - attempts[key][-1] > 60:
                del attempts[key]
        bucket = attempts[request.remote_addr or "local"]
        while bucket and now - bucket[0] > 60:
            bucket.popleft()
        require(len(bucket) < 90, "Слишком много попыток входа. Подождите минуту.", 429)
        bucket.append(now)

    def auth(code):
        room = game.get_room(code)
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        return room, game.authenticate(room, token)

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.get("/api/roles")
    def roles():
        return jsonify(roles=ROLES)

    @app.get("/api/music")
    def music_list():
        return jsonify(tracks=game.music_tracks())

    @app.get("/music/<filename>")
    def music_track(filename):
        path = music_catalog.files(app.config['MUSIC_DIR']).get(filename)
        require(path is not None, "Музыкальный файл не найден.", 404)
        # A filesystem path enables streaming and HTTP Range for seeking, including large MP4s.
        return send_file(path, mimetype=MUSIC_TYPES[path.suffix.lower()], conditional=True)

    @app.post("/api/rooms")
    def create():
        data = body()
        with game.lock:
            rate_limit()
            room, p = game.create(data.get("name"))
            return jsonify(code=room.code, token=p.token, state=game.view(room, p)), 201

    @app.post("/api/rooms/<code>/join")
    def join(code):
        data = body()
        with game.lock:
            rate_limit()
            room, p = game.join(code, data.get("name"))
            return jsonify(code=room.code, token=p.token, state=game.view(room, p))

    @app.get("/api/rooms/<code>")
    def state(code):
        with game.lock:
            room, p = auth(code)
            return jsonify(game.view(room, p))

    @app.post("/api/rooms/<code>/<action>")
    def command(code, action):
        data = body()
        with game.lock:
            room, p = auth(code)
            game.command(room, p, action, data)
            if action == "leave":
                return jsonify(ok=True)
            return jsonify(game.view(room, p))

    return app


def main():
    from waitress import serve

    parser = argparse.ArgumentParser(description="One Night Werewolf — общий сервер лобби")
    parser.add_argument("--host", default="0.0.0.0", help="0.0.0.0 для локальной сети; 127.0.0.1 только для этого ПК")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    print(f"\nOne Night Werewolf\nНа этом ПК: http://127.0.0.1:{args.port}", flush=True)
    if args.host == "0.0.0.0":
        try:
            addresses = set(socket.gethostbyname_ex(socket.gethostname())[2])
            for ip in sorted(addresses):
                if not ip.startswith("127."):
                    print(f"В локальной сети: http://{ip}:{args.port}", flush=True)
        except OSError:
            pass
    print("Друзья открывают адрес сервера и вводят код лобби.\nОстановка: Ctrl+C.\n", flush=True)
    # Одна память процесса = один сервер. Несколько потоков обслуживают игроков одновременно.
    serve(create_app(), host=args.host, port=args.port, threads=8,
          max_request_body_size=8192, channel_timeout=30)


if __name__ == "__main__":
    main()
