# ── Build stage ────────────────────────────────────────────────
FROM python:3.12-slim

# Keep Python from writing .pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (layer-cache friendly)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY app.py        .
COPY templates/    templates/
COPY static/       static/

# Cloud Run injects PORT; default to 8080 for local docker runs
ENV PORT=8080

# Expose the port (documentation only – Cloud Run ignores this)
EXPOSE 8080

# Start uvicorn bound to the injected PORT
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1
