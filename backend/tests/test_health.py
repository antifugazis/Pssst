from fastapi.testclient import TestClient
from app.main import app

def test_healthz_reports_ready():
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
