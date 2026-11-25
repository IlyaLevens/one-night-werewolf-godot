FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt requirements-offline.txt ./
COPY wheels ./wheels
RUN pip install --no-cache-dir --no-index --find-links=/app/wheels --require-hashes -r requirements-offline.txt
COPY app.py .
COPY werewolf ./werewolf
COPY templates ./templates
COPY static ./static
COPY music ./music
RUN useradd --create-home game
USER game
EXPOSE 8000
CMD ["python", "app.py"]
