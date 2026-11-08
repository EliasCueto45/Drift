import base64
import hmac
import os
import re
from datetime import UTC, datetime
from functools import lru_cache

import httpx
import jwt

from .database import collection
from .validation import compact, fail, require


def worker_auth(request):
    secret = os.getenv("TRACKING_INGEST_SECRET")
    if not secret:
        fail(503, "NOT_CONFIGURED", "Worker authentication is not configured")
    if not hmac.compare_digest(
        request.headers.get("authorization", "").encode(), f"Bearer {secret}".encode()
    ):
        fail(401, "UNAUTHENTICATED", "Worker credential required")


def clerk_issuer():
    key = os.getenv("CLERK_PUBLISHABLE_KEY") or os.getenv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") or ""
    try:
        encoded = key.split("_", 2)[2]
        domain = (
            base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True).decode().removesuffix("$")
        )
        require(
            re.fullmatch(r"[a-zA-Z0-9.-]+", domain) and "." in domain,
            "Invalid Clerk configuration",
            "NOT_CONFIGURED",
            503,
        )
        return f"https://{domain}"
    except (ValueError, IndexError):
        fail(503, "NOT_CONFIGURED", "Clerk publishable key is required")


@lru_cache(maxsize=4)
def jwks(issuer):
    return jwt.PyJWKClient(f"{issuer}/.well-known/jwks.json", timeout=10)


def request_identity(required, request):
    authorization = request.headers.get("authorization")
    token = request.cookies.get("__session")
    if not authorization and not token:
        if required:
            fail(401, "UNAUTHENTICATED", "Sign in required")
        return None
    if authorization:
        require(
            re.fullmatch(r"Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", authorization),
            "Valid Clerk session required",
            "UNAUTHENTICATED",
            401,
        )
        token = authorization[7:]
    if not os.getenv("CLERK_SECRET_KEY"):
        fail(503, "NOT_CONFIGURED", "Set the complete CLERK_SECRET_KEY in apps/web/.env.local")
    issuer = clerk_issuer()
    try:
        signing_key = jwks(issuer).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "iat", "nbf", "iss", "sub", "sid"], "verify_aud": False},
        )
        require(
            claims.get("sts") in (None, "active"),
            "Complete sign-in before continuing",
            "UNAUTHENTICATED",
            401,
        )
        origin = os.getenv("DRIFT_APP_ORIGIN") or str(request.base_url).rstrip("/")
        # azp can be absent for non-browser requests; present values must match.
        require(
            not claims.get("azp") or claims["azp"] == origin,
            "Valid Clerk session required",
            "UNAUTHENTICATED",
            401,
        )
        require(
            isinstance(claims["sub"], str)
            and claims["sub"].startswith("user_")
            and isinstance(claims["sid"], str)
            and claims["sid"].startswith("sess_"),
            "Valid Clerk session required",
            "UNAUTHENTICATED",
            401,
        )
    except jwt.PyJWTError:
        fail(401, "UNAUTHENTICATED", "Valid Clerk session required")
    try:
        response = httpx.get(
            f"https://api.clerk.com/v1/users/{claims['sub']}",
            headers={"Authorization": f"Bearer {os.environ['CLERK_SECRET_KEY']}"},
            timeout=10,
            follow_redirects=False,
        )
        response.raise_for_status()
        user = response.json()
    except (httpx.HTTPError, ValueError):
        fail(503, "IDENTITY_UNAVAILABLE", "Identity service unavailable")
    return {
        "id": claims["sub"],
        "displayName": user.get("username")
        or " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))
        or None,
        "avatarUrl": user.get("image_url"),
    }


def check_origin(request):
    origin = request.headers.get("origin")
    expected = os.getenv("DRIFT_APP_ORIGIN") or str(request.base_url).rstrip("/")
    if origin:
        require(origin == expected, "Cross-origin mutation forbidden", "FORBIDDEN", 403)


def upsert_profile(ctx, user):
    if user:
        collection(ctx, "profiles").update_one(
            {"_id": user["id"]}, {"$set": {"id": user["id"], "public_profile": user}}, upsert=True
        )


def rate_limit(ctx, user_id, action, maximum):
    window = int(ctx.now.timestamp() // 60)
    id = compact([user_id, action, window])
    rows = collection(ctx, "rate_windows")
    rows.update_one(
        {"_id": id},
        {
            "$inc": {"count": 1},
            "$setOnInsert": {
                "user_id": user_id,
                "action": action,
                "expires_at": datetime.fromtimestamp((window + 3) * 60, UTC),
            },
        },
        upsert=True,
    )
    require(rows.find_one({"_id": id})["count"] <= maximum, "Try again next minute", "RATE_LIMIT", 429)
