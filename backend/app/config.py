from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="PSSST_")
    database_url: str = "postgresql+asyncpg://pssst:pssst_dev@localhost:5433/pssst"
    storage_dir: Path = Path("./data")
    whisper_model: str = "medium"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    openrouter_endpoint: str = "https://openrouter.ai/api/v1/chat/completions"
    public_base_url: str = "http://127.0.0.1:8000"
    connection_secret: str | None = None

settings = Settings()
