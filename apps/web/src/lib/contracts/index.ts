export type {
  Anchor,
  ApiError,
  ArtworkTransform,
  Cloud,
  CloudWithPreviews,
  CreateMessageRequest,
  CreateCloudRequest,
  Message,
  MessagesResponse,
  MultiPolygon,
  Polygon,
  Position,
  SkyResponse,
  User,
  Wind,
} from "./generated";

import type { Cloud, SkyResponse } from "./generated";

export type SkyData = SkyResponse["data"];
export type Freshness = SkyData["freshness"];

/** `PUT /messages/:id/upvote` result (route contract in README API v1). */
export interface VoteState {
  voteCount: number;
  viewerHasUpvoted: boolean;
}

/** `GET /clouds/:id` result. Expired detail reveals lifecycle metadata only. */
export type CloudDetail =
  | { cloud: Cloud; lifecycle: unknown[]; successorIds: string[] }
  | {
      id: string;
      status: "expired";
      lifecycle: unknown[];
      successorIds: string[];
    };

/** UI post types mapped onto contract v1 message kinds (decision 0002). */
export const POST_KIND = { text: "text", link: "song" } as const;

/** Hosts the backend currently accepts for `song` (link) posts. Mirrors drift_api/validation.py. */
export const LINK_HOSTS = [
  "open.spotify.com",
  "music.apple.com",
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  "soundcloud.com",
  "music.youtube.com",
  "bandcamp.com",
] as const;

export const LIMITS = {
  textChars: 2000,
  linkChars: 2048,
  defaultRadiusM: 25000,
  maxRadiusM: 50000,
} as const;
