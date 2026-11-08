import base64
import json
from types import SimpleNamespace
from datetime import timedelta
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.requests import Request
from drift_api import auth
from drift_api.validation import ApiError, now
from drift_api.geometry import covers, validate_geometry, footprint_distance_m


@pytest.fixture
def clerk(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    domain = "test.clerk.accounts.dev"
    publishable = "pk_test_" + base64.b64encode((domain + "$").encode()).decode().rstrip("=")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", publishable)
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_synthetic_not_a_real_secret")
    monkeypatch.setenv("DRIFT_APP_ORIGIN", "http://localhost:3000")
    monkeypatch.setattr(
        auth,
        "jwks",
        lambda issuer: SimpleNamespace(
            get_signing_key_from_jwt=lambda token: SimpleNamespace(key=key.public_key())
        ),
    )

    class Profile:
        def raise_for_status(self):
            pass

        def json(self):
            return {"username": "test", "image_url": None, "email_addresses": ["private@invalid.test"]}

    monkeypatch.setattr(auth.httpx, "get", lambda *a, **kw: Profile())
    clock = now()
    claims = {
        "iss": "https://" + domain,
        "sub": "user_test",
        "sid": "sess_test",
        "iat": clock,
        "nbf": clock,
        "exp": clock + timedelta(minutes=1),
        "azp": "http://localhost:3000",
    }
    return key, claims


def request(token):
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "server": ("localhost", 3000),
            "path": "/",
            "headers": [(b"authorization", ("Bearer " + token).encode())],
        }
    )


def test_valid_clerk_session_only_public_fields(clerk):
    key, claims = clerk
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})
    profile = auth.request_identity(True, request(token))
    assert profile == {"id": "user_test", "displayName": "test", "avatarUrl": None}
    assert "private@" not in json.dumps(profile)


@pytest.mark.parametrize(
    "change", ["expired", "issuer", "azp", "signature", "machine-token", "pending-session"]
)
def test_invalid_clerk_sessions(clerk, change):
    key, claims = clerk
    if change == "expired":
        claims["exp"] = now() - timedelta(minutes=1)
    elif change == "issuer":
        claims["iss"] = "https://evil.test"
    elif change == "azp":
        claims["azp"] = "https://evil.test"
    elif change == "signature":
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    elif change == "machine-token":
        claims["sub"] = "machine_test"
    elif change == "pending-session":
        claims["sts"] = "pending"
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})
    with pytest.raises(ApiError) as raised:
        auth.request_identity(True, request(token))
    assert raised.value.status == 401


def test_holes_boundaries_and_invalid_geometry():
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[-74, 42], [-73, 42], [-73, 43], [-74, 43], [-74, 42]],
            [[-73.7, 42.3], [-73.3, 42.3], [-73.3, 42.7], [-73.7, 42.7], [-73.7, 42.3]],
        ],
    }
    validate_geometry(polygon)
    assert covers(polygon, {"longitude": -74, "latitude": 42.5})
    assert not covers(polygon, {"longitude": -73.5, "latitude": 42.5})
    assert footprint_distance_m(polygon, {"longitude": -73.5, "latitude": 42.5}) > 10000
    invalid = {"type": "Polygon", "coordinates": [[[-74, 42], [-73, 43], [-73, 42], [-74, 43], [-74, 42]]]}
    with pytest.raises(ApiError):
        validate_geometry(invalid)
