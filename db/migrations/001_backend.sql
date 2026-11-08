CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE profiles (
  id text PRIMARY KEY,
  public_profile jsonb NOT NULL
);
-- Replay clocks advance only when a batch commits. Live clocks use wall time.
CREATE TABLE datasets (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('live','replay')),
  run_id text NOT NULL,
  sequence integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clouds (
  id text PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES datasets(id),
  payload jsonb NOT NULL,
  footprint geometry(MultiPolygon,4326) NOT NULL,
  deleted_at timestamptz,
  CHECK (ST_IsValid(footprint) AND NOT ST_IsEmpty(footprint))
);
CREATE INDEX clouds_footprint_gist ON clouds USING gist ((footprint::geography));
CREATE INDEX clouds_dataset ON clouds(dataset_id);
CREATE TABLE cloud_history (
  cloud_id text NOT NULL REFERENCES clouds(id),
  version integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(cloud_id,version)
);
CREATE TABLE assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES profiles(id),
  payload jsonb NOT NULL,
  upload_key text NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_message_id text UNIQUE
);
CREATE TABLE messages (
  id text PRIMARY KEY,
  cloud_id text NOT NULL REFERENCES clouds(id),
  author_id text NOT NULL REFERENCES profiles(id),
  asset_id text UNIQUE REFERENCES assets(id),
  payload jsonb NOT NULL,
  anchor geometry(Point,4326) NOT NULL,
  strokes jsonb,
  held boolean NOT NULL DEFAULT false,
  position_at timestamptz NOT NULL,
  expired_at timestamptz
);
CREATE INDEX messages_anchor_gist ON messages USING gist ((anchor::geography));
CREATE INDEX messages_cloud ON messages(cloud_id) WHERE expired_at IS NULL;
CREATE TABLE votes (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES profiles(id),
  PRIMARY KEY(message_id,user_id)
);
CREATE TABLE tracking_batches (
  batch_id text PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES datasets(id),
  sequence integer NOT NULL,
  acknowledgement jsonb NOT NULL,
  UNIQUE(dataset_id,sequence)
);
CREATE TABLE lifecycle_events (
  event_id text PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES datasets(id),
  payload jsonb NOT NULL
);
-- Contains identifiers only; failed S3 deletion leaves the task retryable.
CREATE TABLE cleanup_jobs (
  message_id text PRIMARY KEY REFERENCES messages(id),
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE rate_windows (
  user_id text NOT NULL,
  action text NOT NULL,
  window_at timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(user_id,action,window_at)
);
-- Opaque random tokens bind frozen ordering/state to the exact query and viewer.
CREATE TABLE query_snapshots (
  id text PRIMARY KEY,
  binding text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
