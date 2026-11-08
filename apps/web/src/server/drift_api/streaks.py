"""Posting days use server receipt time in the person's pinned IANA time zone."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .database import collection
from .validation import fail, iso, require, validate


def time_zone(value):
    value = value or "UTC"
    require(isinstance(value, str) and 1 <= len(value) <= 80, "Valid IANA time zone required")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        fail(422, "INVALID_TIME_ZONE", "Valid IANA time zone required")
    return value


def initial_streak(id, zone):
    return {
        "_id": id,
        "time_zone": zone,
        "current_days": 0,
        "longest_days": 0,
        "posting_days": 0,
        "total_posts": 0,
        "last_posted_on": None,
    }


def advance(row, at):
    today = at.astimezone(ZoneInfo(row["time_zone"])).date()
    previous = date.fromisoformat(row["last_posted_on"]) if row["last_posted_on"] else None
    result = {**row, "total_posts": row["total_posts"] + 1}
    if previous == today:
        return result
    # Request times are supplied by the server, never by a post/replay payload.
    require(previous is None or today > previous, "Posting clock moved backwards", "CLOCK_CONFLICT", 409)
    result["current_days"] = row["current_days"] + 1 if previous == today - timedelta(days=1) else 1
    result["longest_days"] = max(row["longest_days"], result["current_days"])
    result["posting_days"] = row["posting_days"] + 1
    result["last_posted_on"] = today.isoformat()
    return result


def streak_summary(row, at, anonymous=False):
    zone = ZoneInfo(row["time_zone"])
    today = at.astimezone(zone).date()
    previous = date.fromisoformat(row["last_posted_on"]) if row["last_posted_on"] else None
    current = row["current_days"] if previous in (today, today - timedelta(days=1)) else 0
    reset = datetime.combine(today + timedelta(days=1), time.min, tzinfo=zone).astimezone(UTC)
    return validate(
        "PostingStreak",
        {
            "currentDays": current,
            "longestDays": row["longest_days"],
            "totalPostingDays": row["posting_days"],
            "totalPosts": row["total_posts"],
            "lastPostedOn": row["last_posted_on"],
            "postedToday": previous == today,
            "timeZone": row["time_zone"],
            "nextResetAt": iso(reset),
            "isAnonymous": anonymous,
        },
    )


def get_row(ctx, user, requested_zone):
    rows = collection(ctx, "posting_streaks")
    row = rows.find_one({"_id": user["id"]})
    # Once initialized, a different browser time zone must not manufacture an
    # extra posting day. Travel/time-zone changes need an explicit future policy.
    zone = time_zone(requested_zone)
    if row is None:
        row = initial_streak(user["id"], zone)
        if user.get("isAnonymous"):
            row["expires_at"] = ctx.now + timedelta(days=180)
        rows.insert_one(row)
    return row


def posting_streak(ctx, user, requested_zone=None):
    row = get_row(ctx, user, requested_zone)
    return {"data": streak_summary(row, ctx.now, bool(user.get("isAnonymous")))}


def record_post(ctx, user, requested_zone=None):
    row = advance(get_row(ctx, user, requested_zone), ctx.now)
    if user.get("isAnonymous"):
        row["expires_at"] = ctx.now + timedelta(days=180)
    collection(ctx, "posting_streaks").replace_one({"_id": user["id"]}, row)
