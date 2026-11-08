import httpx


def post_batch(batch, base, secret):
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        response = client.post(
            base.rstrip("/") + "/api/internal/tracking/batches",
            json=batch,
            headers={"Authorization": f"Bearer {secret}"},
        )
    try:
        body = response.json()
    except ValueError:
        body = None
    return {"status": response.status_code, "body": body}
