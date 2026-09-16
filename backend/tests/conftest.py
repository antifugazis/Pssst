import asyncio
import os
import struct
import tempfile

os.environ.setdefault("PSSST_CONNECTION_SECRET", "test-connection-secret")
os.environ.setdefault("PSSST_STORAGE_DIR", tempfile.mkdtemp(prefix="pssst-test-"))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import get_db
from app.main import app
from app.models import Base

AUTH = {"Authorization": "Bearer test-connection-secret"}


def wav_bytes(payload_size: int = 400) -> bytes:
    """Minimal 48kHz stereo PCM16 WAV with `payload_size` bytes of silence."""
    data = b"\x00" * payload_size
    header = (
        b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 2, 48000, 192000, 4, 16)
        + b"data" + struct.pack("<I", len(data))
    )
    return header + data


@pytest.fixture
def engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")

    async def create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create())
    yield engine
    asyncio.run(engine.dispose())


@pytest.fixture
def client(engine):
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db():
        async with Session() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def db(engine):
    """Synchronous helper for seeding/inspecting rows outside the app loop."""
    Session = async_sessionmaker(engine, expire_on_commit=False)

    def run(coro):
        return asyncio.run(coro)

    return Session, run
