import '../apps/web/src/server/environment.mjs';
import { requireThat } from '../apps/web/src/server/validation.mjs';
import { requestIdentity } from '../apps/web/src/server/auth.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

// Read-only credential check. Never print keys, tokens, user records, or JWKS.
await runCli(async()=>{
  const publishable=process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY??'';
  const secret=process.env.CLERK_SECRET_KEY??'';
  requireThat(/^pk_(test|live)_/.test(publishable)&&/^sk_(test|live)_[A-Za-z0-9_-]{24,}$/.test(secret),'Complete Clerk keys are required','CLERK_NOT_CONFIGURED',503);
  const issuer=Buffer.from(publishable.replace(/^pk_(test|live)_/,''),'base64url').toString('utf8').replace(/\$$/,'');
  requireThat(/^[a-zA-Z0-9.-]+$/.test(issuer)&&issuer.includes('.'),'Invalid Clerk publishable key','INVALID_CLERK_KEY');
  const responses=await Promise.all([
    fetch('https://api.clerk.com/v1/jwks',{headers:{authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(15000)}),
    fetch(`https://${issuer}/.well-known/jwks.json`,{redirect:'error',signal:AbortSignal.timeout(15000)}),
  ]);
  requireThat(responses[0].status===200,'Clerk rejected the configured secret key','CLERK_KEY_REJECTED',401);
  requireThat(responses[1].status===200,'Clerk frontend signing keys could not be loaded','CLERK_FRONTEND_UNAVAILABLE',503);
  const [backend,frontend]=await Promise.all(responses.map(response=>response.json()));
  requireThat(Array.isArray(backend.keys)&&Array.isArray(frontend.keys),'Invalid Clerk key response');
  const fingerprint=key=>JSON.stringify([key.kid,key.kty,key.n,key.e]);
  const known=new Set(backend.keys.map(fingerprint));
  requireThat(frontend.keys.some(key=>known.has(fingerprint(key))),'Clerk keys belong to different applications','CLERK_APP_MISMATCH');
  let rejected=false;
  try{await requestIdentity(true,new Request('http://localhost:3000/api/v1/clouds',{headers:{authorization:'Bearer fake.jwt.signature'}}));}
  catch(error){if(error.status!==401)throw error;rejected=true;}
  requireThat(rejected,'Forged session token was not rejected');
  console.log(JSON.stringify({secretAccepted:true,keysMatchSameApplication:true,forgedSessionRejected:true,realBrowserSignIn:'not exercised'}));
});
