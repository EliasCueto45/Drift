"""Explicit smoke checks against a running stack. Signed-in checks can be skipped."""

import os
from copy import deepcopy
from urllib.parse import quote
import httpx
from drift_api.validation import validate, require
from .common import scenarios, haversine_m
from .replay import post_batch


def smoke(base, secret, token=None):
    results = []
    scenario = next(s for s in scenarios() if s["name"] == "scattered-advection")
    first, second = [entry["body"] for entry in scenario["batches"]]
    message = scenario["meta"]["seed"]["messages"][0]
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    def run(name, fn):
        try:
            result = fn()
            results.append({"name": name, "status": "SKIP" if result == "SKIP" else "PASS"})
        except Exception as error:
            results.append({"name": name, "status": "FAIL", "category": type(error).__name__})

    def post(batch, worker_secret=secret):
        response = post_batch(batch, base, worker_secret)
        require(response["status"] < 300, "Batch rejected")
        return response

    with httpx.Client(base_url=base, timeout=30, follow_redirects=False) as client:
        run(
            "bad worker secret rejected",
            lambda: require(
                post_batch(first, base, "wrong-secret")["status"] in (401, 403), "Worker accepted bad secret"
            ),
        )
        run("ingest first batch", lambda: post(first))
        run(
            "duplicate acknowledgement",
            lambda: require(post(first)["body"]["data"]["sequence"] == 1, "Wrong acknowledgement"),
        )
        skipped = {**deepcopy(second), "batchId": "smoke-skip", "sequence": 7}
        run(
            "out-of-order rejected",
            lambda: require(
                400 <= post_batch(skipped, base, secret)["status"] < 500, "Skipped sequence accepted"
            ),
        )

        def check_sky():
            response = client.get(
                "/api/v1/sky",
                params={
                    "lat": 42.7284,
                    "lng": -73.6918,
                    "radiusM": 50000,
                    "datasetId": scenario["meta"]["datasetId"],
                },
            )
            require(response.status_code == 200, "Sky failed")
            data = validate("SkyResponse", response.json())
            require(
                set(scenario["meta"]["expect"]["activeCloudIds"])
                <= {item["cloud"]["id"] for item in data["data"]["clouds"]},
                "Clouds missing",
            )

        run("sky matches contract", check_sky)
        route = f"/api/v1/clouds/{quote(message['cloudId'])}/messages"

        def check_messages():
            response = client.get(route, params={"scope": "all"})
            require(response.status_code == 200, "Messages failed")
            data = validate("MessagesResponse", response.json())
            require(any(item["id"] == message["id"] for item in data["data"]), "Seed missing")

        run("seed messages present", check_messages)

        def movement():
            post(second)
            data = client.get(route, params={"scope": "all"}).json()["data"]
            moved = next(item for item in data if item["id"] == message["id"])
            require(
                abs(haversine_m(message["anchor"], moved["anchor"]) - 6000) < 100, "Incorrect displacement"
            )

        run("worker moves notes approximately 6 km", movement)
        run(
            "anonymous write rejected",
            lambda: require(client.post(route, json={}).status_code == 401, "Anonymous mutation accepted"),
        )

        def signed_in():
            if not token:
                return "SKIP"
            cloud = second["snapshots"][0]
            ring = cloud["geometry"]["coordinates"][0][0]
            anchor = {
                "longitude": sum(point[0] for point in ring[:-1]) / (len(ring) - 1),
                "latitude": sum(point[1] for point in ring[:-1]) / (len(ring) - 1),
            }
            response = client.post(
                route,
                json={
                    "kind": "text",
                    "body": "smoke test",
                    "anchor": anchor,
                    "expectedCloudVersion": cloud["version"],
                },
                headers=headers,
            )
            require(response.status_code == 201, "Post failed")
            id = response.json()["data"]["id"]
            for _ in range(2):
                response = client.put(f"/api/v1/messages/{id}/upvote", json={"active": True}, headers=headers)
                require(
                    response.status_code == 200 and response.json()["data"]["voteCount"] == 1,
                    "Vote is not idempotent",
                )

        run("signed-in post and idempotent vote", signed_in)
    return results


def main():
    results = smoke(
        os.getenv("DRIFT_API_BASE_URL", "http://localhost:3000"),
        os.environ["TRACKING_INGEST_SECRET"],
        os.getenv("SMOKE_AUTH_TOKEN"),
    )
    for result in results:
        print(f"{result['status']}: {result['name']}")
    return int(any(result["status"] == "FAIL" for result in results))
