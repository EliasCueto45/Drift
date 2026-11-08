import './environment.mjs';
// Presence/format checks only. Never echo a URI, password, token, or key.
const status={
  mongoUriConfigured:!!process.env.MONGODB_URI,
  mongoDatabaseConfigured:!!process.env.MONGODB_DB,
  clerkPublishableKeyConfigured:/^pk_(test|live)_/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY??''),
  clerkSecretComplete:/^sk_(test|live)_[A-Za-z0-9]{24,}$/.test(process.env.CLERK_SECRET_KEY??''),
  workerSecretConfigured:!!process.env.TRACKING_INGEST_SECRET&&!process.env.TRACKING_INGEST_SECRET.startsWith('dev-only'),
  storageCredentialsPresent:['S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'].every(key=>!!process.env[key]),
};
console.log(JSON.stringify(status,null,2));
