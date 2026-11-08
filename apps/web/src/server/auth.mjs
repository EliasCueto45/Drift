import { timingSafeEqual } from 'node:crypto';
import { fail, requireThat } from './validation.mjs';
import { collection } from './database.mjs';

export function workerAuth(request) {
  const secret = process.env.TRACKING_INGEST_SECRET;
  if (!secret) fail(503, 'NOT_CONFIGURED', 'Worker authentication is not configured');
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(request.headers.get('authorization') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, 'UNAUTHENTICATED', 'Worker credential required');
}
export async function clerkIdentity(required = false) {
  if(!process.env.CLERK_SECRET_KEY)fail(503,'NOT_CONFIGURED','Set the complete CLERK_SECRET_KEY in apps/web/.env.local');
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
// The standalone API verifies the same Clerk sessions as the Next adapter.
// Anonymous reads need no Clerk network request or configured secret key.
export async function requestIdentity(required,request){
  const authorization=request.headers.get('authorization');
  const sessionCookie=/(?:^|;\s*)__session=/.test(request.headers.get('cookie')??'');
  if(!authorization&&!sessionCookie){if(required)fail(401,'UNAUTHENTICATED','Sign in required');return null;}
  if(authorization&&!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization))fail(401,'UNAUTHENTICATED','Valid Clerk session required');
  if(!process.env.CLERK_SECRET_KEY)fail(503,'NOT_CONFIGURED','Set the complete CLERK_SECRET_KEY in apps/web/.env.local');
  const {createClerkClient}=await import('@clerk/backend');
  const client=createClerkClient({secretKey:process.env.CLERK_SECRET_KEY,publishableKey:process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY});
  let state;
  try{state=await client.authenticateRequest(request,{authorizedParties:[process.env.DRIFT_APP_ORIGIN||new URL(request.url).origin],acceptsToken:'session_token'});}
  catch{fail(401,'UNAUTHENTICATED','Valid Clerk session required');}
  const userId=state.toAuth()?.userId;
  if(!userId){if(required)fail(401,'UNAUTHENTICATED','Sign in required');return null;}
  const user=await client.users.getUser(userId);
  return {id:userId,displayName:user.username??([user.firstName,user.lastName].filter(Boolean).join(' ')||null),avatarUrl:user.imageUrl??null};
}
export function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) requireThat(origin === new URL(request.url).origin, 'Cross-origin mutation forbidden', 'FORBIDDEN', 403);
}
export async function upsertProfile(db, user) {
  if(user) await collection(db,'profiles').updateOne({_id:user.id},{$set:{id:user.id,public_profile:user}},{upsert:true});
}
export async function rateLimit(db, userId, action, max) {
  const now=db.now??new Date(),window=Math.floor(now.getTime()/60000);
  const id=JSON.stringify([userId,action,window]),rows=collection(db,'rate_windows');
  await rows.updateOne({_id:id},{$inc:{count:1},$setOnInsert:{user_id:userId,action,expires_at:new Date((window+3)*60000)}},{upsert:true});
  if((await rows.findOne({_id:id})).count>max) fail(429,'RATE_LIMIT','Try again next minute');
}
