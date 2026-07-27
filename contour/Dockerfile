FROM python:3.12-alpine
WORKDIR /app
COPY app.py .
USER nobody
ENV PORT=8080 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --retries=5 CMD wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["python", "app.py"]
