import json
import logging
import re
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .auth import check_origin, request_identity, upsert_profile, worker_auth
from .database import close_database, transaction
from .discovery import cloud_detail, message_page, sky
from .mutations import create_cloud, create_message, delete_cloud, delete_message, upvote
from .storage import artwork, complete_asset, playback_url, upload_url
from .tracking import ingest, tracking_state
from .validation import ApiError, fail, require, validate
from .idempotency import create_once


async def read_json(request, maximum=2 * 1024 * 1024):
    require(
        request.headers.get("content-type", "").split(";")[0].strip() == "application/json",
        "application/json required",
    )
    length = request.headers.get("content-length")
    if length:
        require(length.isdigit(), "Invalid content length")
        require(int(length) <= maximum, "Request exceeds size limit", "TOO_LARGE", 413)
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        require(len(content) <= maximum, "Request exceeds size limit", "TOO_LARGE", 413)
    try:
        return json.loads(content, parse_constant=lambda _: fail(422, "INVALID", "Malformed JSON"))
    except (ValueError, UnicodeError, RecursionError):
        fail(422, "INVALID", "Malformed JSON")


def create_app(identity=request_identity, run=transaction, worker=worker_auth):
    @asynccontextmanager
    async def lifespan(app):
        yield
        await run_in_threadpool(close_database)

    app = FastAPI(title="Drift API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    async def handle(request: Request, path: str):
        request_id = str(uuid4())
        headers = {
            "cache-control": "private, no-store",
            "x-request-id": request_id,
            "x-content-type-options": "nosniff",
        }
        try:
            path, method, params = "/" + path, request.method, request.query_params
            execute, user, status = None, None, 200
            create_kind = None
            if path.startswith("/api/internal/"):
                worker(request)
                if path == "/api/internal/tracking/batches" and method == "POST":
                    body = await read_json(request, 10 * 1024 * 1024)

                    def execute(ctx):
                        return ingest(ctx, body)
                elif path == "/api/internal/tracking/state" and method == "GET":

                    def execute(ctx):
                        return tracking_state(ctx, params)
            else:
                writes = method in ("POST", "PUT", "DELETE", "PATCH")
                if writes:
                    check_origin(request)
                user = await run_in_threadpool(identity, writes, request)
                if writes and not user:
                    fail(401, "UNAUTHENTICATED", "Sign in required")
                if path == "/api/v1/sky" and method == "GET":

                    def execute(ctx):
                        return sky(ctx, params, user)
                elif path == "/api/v1/messages" and method == "GET":
                    ids = list(dict.fromkeys(params.getlist("id")))
                    require(1 <= len(ids) <= 50, "Supply 1..50 message IDs")
                    for message_id in ids:
                        validate("Id", message_id)

                    def execute(ctx):
                        from .database import collection
                        from .records import public_message

                        messages = []
                        for row in collection(ctx, "messages").find({"_id": {"$in": ids}}):
                            message = public_message(ctx, row, user["id"] if user else None)
                            if message:
                                messages.append(message)
                        return {"data": messages}
                elif path == "/api/v1/clouds" and method == "POST":
                    body = await read_json(request)
                    execute, status = lambda ctx: create_cloud(ctx, body, user), 201
                    create_kind = "cloud"
                elif match := re.fullmatch(r"/api/v1/clouds/([^/]+)/messages", path):
                    id = match[1]
                    if method == "GET":

                        def execute(ctx):
                            return message_page(ctx, id, params, user)
                    elif method == "POST":
                        body = await read_json(request)
                        execute, status = lambda ctx: create_message(ctx, id, body, user), 201
                        create_kind = "message"
                elif match := re.fullmatch(r"/api/v1/clouds/([^/]+)", path):
                    id = match[1]
                    if method == "GET":

                        def execute(ctx):
                            return cloud_detail(ctx, id)
                    elif method == "DELETE":

                        def execute(ctx):
                            return delete_cloud(ctx, id, user)
                elif (match := re.fullmatch(r"/api/v1/messages/([^/]+)/upvote", path)) and method == "PUT":
                    id, body = match[1], await read_json(request)

                    def execute(ctx):
                        return upvote(ctx, id, body, user)
                elif (match := re.fullmatch(r"/api/v1/messages/([^/]+)", path)) and method == "DELETE":
                    id = match[1]

                    def execute(ctx):
                        return delete_message(ctx, id, user)

                elif (match := re.fullmatch(r"/api/v1/messages/([^/]+)", path)) and method == "GET":
                    id = match[1]

                    def execute(ctx):
                        from .database import collection
                        from .records import public_message

                        row = collection(ctx, "messages").find_one({"_id": id})
                        if not row:
                            fail(404, "NOT_FOUND", "Message not found")
                        message = public_message(ctx, row, user["id"] if user else None)
                        if message is None:
                            fail(410, "CONTENT_UNAVAILABLE", "Post is no longer visible")
                        return {"data": message}
                elif path == "/api/v1/assets/upload-url" and method == "POST":
                    body = await read_json(request)

                    def execute(ctx):
                        return upload_url(ctx, body, user)
                elif (match := re.fullmatch(r"/api/v1/assets/([^/]+)/complete", path)) and method == "POST":
                    id = match[1]

                    def execute(ctx):
                        return complete_asset(ctx, id, user)
                elif (match := re.fullmatch(r"/api/v1/assets/([^/]+)/url", path)) and method == "GET":
                    id = match[1]

                    def execute(ctx):
                        return playback_url(ctx, id, user)
                elif (match := re.fullmatch(r"/api/v1/messages/([^/]+)/artwork", path)) and method == "GET":
                    id = match[1]

                    def execute(ctx):
                        return artwork(ctx, id, user)

            if execute is None:
                fail(404, "NOT_FOUND", "Route not found")

            def perform(ctx):
                upsert_profile(ctx, user)
                if create_kind:
                    return create_once(
                        ctx, user, request.headers.get("idempotency-key"), path, body, execute, create_kind
                    )
                return execute(ctx)

            result = await run_in_threadpool(run, perform)
            return JSONResponse(result, status_code=status, headers=headers)
        except ApiError as error:
            return JSONResponse(
                {"error": {"code": error.code, "message": error.message, "requestId": request_id}},
                status_code=error.status,
                headers=headers,
            )
        except Exception as error:
            # Driver exceptions can contain credentials and private submitted data.
            logging.getLogger("drift").error(
                "API failure request=%s category=%s", request_id, type(error).__name__
            )
            return JSONResponse(
                {
                    "error": {
                        "code": "INTERNAL",
                        "message": "Request could not be completed",
                        "requestId": request_id,
                    }
                },
                status_code=500,
                headers=headers,
            )

    return app


app = create_app()
