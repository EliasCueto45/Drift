"""Read-only HTTP checks with actual configured persistence and production auth."""

import os
import httpx
from .http import create_app
from .validation import require, validate


def atlas_smoke():
    from drift_tools.testing import running_api

    secret = os.environ["TRACKING_INGEST_SECRET"]
    dataset_id = os.getenv("DRIFT_DATASET_ID", "troy-demo")
    with running_api(create_app()) as base, httpx.Client(base_url=base, timeout=30) as client:
        response = client.get(
            "/api/v1/sky", params={"lat": 42.7284, "lng": -73.6918, "datasetId": dataset_id}
        )
        require(response.status_code == 200, "Anonymous sky request failed")
        validate("SkyResponse", response.json())
        require(client.post("/api/v1/clouds", json={}).status_code == 401, "Anonymous mutation was accepted")
        require(
            client.get("/api/internal/tracking/state", params={"datasetId": dataset_id}).status_code == 401,
            "Missing worker secret was accepted",
        )
        require(
            client.get(
                "/api/internal/tracking/state",
                params={"datasetId": dataset_id},
                headers={"Authorization": "Bearer incorrect-worker-secret"},
            ).status_code
            == 401,
            "Incorrect worker secret was accepted",
        )
        response = client.get(
            "/api/internal/tracking/state",
            params={"datasetId": dataset_id},
            headers={"Authorization": f"Bearer {secret}"},
        )
        require(
            response.status_code == 200, "Authenticated worker state failed; provision the configured dataset"
        )
        print("5 HTTP checks passed against configured persistence; no user content was created.")
