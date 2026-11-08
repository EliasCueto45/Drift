import { timingSafeEqual } from 'node:crypto';
import { fail, requireThat } from './validation.mjs';

export function workerAuth(request) {
  const secret = process.env.TRACKING_INGEST_SECRET;
  if (!secret) fail(503, 'NOT_CONFIGURED', 'Worker authentication is not configured');
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(request.headers.get('authorization') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, 'UNAUTHENTICATED', 'Worker credential required');
}
export async function clerkIdentity(required = false) {
  const { auth, clerkClient } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) {
    if (required) fail(401, 'UNAUTHENTICATED', 'Sign in required');
    return null;
  }
  // Only public profile fields are persisted; never store email or GPS history.
  const user = await (await clerkClient()).users.getUser(userId);
  return { id: userId, displayName: user.username ?? ([user.firstName, user.lastName].filter(Boolean).join(' ') || null), avatarUrl: user.imageUrl ?? null };
}
export function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) requireThat(origin === new URL(request.url).origin, 'Cross-origin mutation forbidden', 'FORBIDDEN', 403);
}
export async function upsertProfile(db, user) {
  if (user) await db.query(`INSERT INTO profiles(id,public_profile) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET public_profile=EXCLUDED.public_profile`, [user.id, user]);
}
export async function rateLimit(db, userId, action, max) {
  const { rows: [row] } = await db.query(`INSERT INTO rate_windows(user_id,action,window_at,count) VALUES($1,$2,date_trunc('minute',now()),1)
    ON CONFLICT(user_id,action,window_at) DO UPDATE SET count=rate_windows.count+1 RETURNING count`, [userId,action]);
  if (row.count > max) fail(429, 'RATE_LIMIT', 'Try again next minute');
}
