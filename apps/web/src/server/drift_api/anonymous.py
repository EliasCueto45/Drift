"""Account-free browser identities. Only token hashes are stored in MongoDB."""

import hashlib
import re
import secrets
from datetime import timedelta
from uuid import uuid4
from .auth import rate_limit
from .database import collection

COOKIE = "drift_anonymous"
SESSION_DAYS = 180


def anonymous_identity(ctx, token):
    if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return None
    row = collection(ctx, "anonymous_sessions").find_one(
        {"_id": hashlib.sha256(token.encode()).hexdigest(), "expires_at": {"$gt": ctx.now}}
    )
    if not row:
        return None
    return {"id": row["principal_id"], "displayName": "Anonymous", "avatarUrl": None, "isAnonymous": True}


def start_session(ctx, previous_token, candidate):
    user = anonymous_identity(ctx, previous_token)
    token = previous_token if user else candidate
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not user:
        # Shared issuance cap also bounds repeated cookie resets. Per-principal
        # posting limits remain enforced by the existing transactional limiter.
        rate_limit(ctx, "anonymous-bootstrap", "session", 120)
        user = {
            "id": "anon_" + uuid4().hex,
            "displayName": "Anonymous",
            "avatarUrl": None,
            "isAnonymous": True,
        }
    collection(ctx, "anonymous_sessions").update_one(
        {"_id": digest},
        {
            "$set": {"principal_id": user["id"], "expires_at": ctx.now + timedelta(days=SESSION_DAYS)},
            "$setOnInsert": {"created_at": ctx.now},
        },
        upsert=True,
    )
    return {"data": user, "_session_token": token}


def new_token():
    return secrets.token_urlsafe(32)
