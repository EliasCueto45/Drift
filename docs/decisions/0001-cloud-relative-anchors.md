# 0001 - Optional cloud-relative anchors (PROPOSAL, not yet adopted)

**Status:** proposed. Contract v1 as committed is unchanged. Needs review by Owners 1-3.

**Problem.** v1 stores an absolute `anchor` per message and has the worker send an `AnchorUpdate` for every message each batch. That forces per-message versions, 409 retry loops, and large batches, and it invites bbox-rescale bugs under overcast.

**Proposal (additive, optional).** Add `anchorLocal: {eastM, northM}` to Message: an offset from the cloud's reference point in its local metric frame. The server derives the absolute `anchor` from `cloud.geometry` + `anchorLocal` on read. A rigid cloud move then moves every message with zero `AnchorUpdate`s; the worker only sends updates for merge/split/expire and non-rigid overcast deformation.

**Compatibility.** Optional field, so it may stay v1. Clients that ignore it keep working off `anchor`.

**Affected.** Owner 2 (read path), Owner 3 (fewer updates), Owner 4 (fixtures). Owner 1: none.

**Decide by:** end of the walking-skeleton milestone, before the worker is wired to real data.
