"""Self-hosted pssst connection links. OpenRouter is deliberately unrelated."""
import hmac
import os
import secrets
from pathlib import Path
from fastapi import Header, HTTPException
from .config import settings

_secret: str | None = None

def connection_secret() -> str:
    global _secret
    if _secret: return _secret
    if settings.connection_secret: _secret = settings.connection_secret; return _secret
    path = settings.storage_dir / ".connection-secret"
    if path.exists(): _secret = path.read_text().strip(); return _secret
    _secret = secrets.token_urlsafe(48); path.write_text(_secret); os.chmod(path, 0o600); return _secret

def connection_link() -> str: return f"{settings.public_base_url.rstrip('/')}/connect/{connection_secret()}"
def authorize(authorization: str | None = Header(default=None)) -> None:
    if not hmac.compare_digest((authorization or "").removeprefix("Bearer "), connection_secret()): raise HTTPException(401, "Invalid pssst connection")
def revoke_and_regenerate() -> str:
    global _secret
    _secret = secrets.token_urlsafe(48); path = settings.storage_dir / ".connection-secret"; path.write_text(_secret); os.chmod(path, 0o600); return connection_link()
