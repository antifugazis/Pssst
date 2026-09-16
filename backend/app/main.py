from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .connection import connection_secret
from .routers import connect_router, router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Schema is owned by Alembic migrations: run `alembic upgrade head`.
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    connection_secret()
    yield


app = FastAPI(title="pssst backend", version="0.1.0", lifespan=lifespan)
app.include_router(router)
app.include_router(connect_router)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
