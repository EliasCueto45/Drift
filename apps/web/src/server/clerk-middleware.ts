// Owner 4: re-export default + matcher from apps/web/src/proxy.ts (Next 16)
// or src/middleware.ts (Next 15). Internal worker auth is checked separately.
import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();
export const config = { matcher: ['/api/v1/:path*'] };
