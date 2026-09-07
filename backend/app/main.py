from fastapi import FastAPI
from .config import settings
from .models import Base
from .db import engine
from .routers import router, connect_router
from .connection import connection_secret

app = FastAPI(title="pssst backend", version="0.1.0")
app.include_router(router)
app.include_router(connect_router)
@app.on_event("startup")
async def startup() -> None:
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    connection_secret()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
@app.get("/healthz")
async def healthz() -> dict[str, str]: return {"status": "ok"}
