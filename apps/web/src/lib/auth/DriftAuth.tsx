"use client";
/**
 * One auth surface for the UI. Clerk is the identity authority when its publishable key is set.
 * NEXT_PUBLIC_DRIFT_DEV_AUTH=mock enables a visibly labeled dev sign-in that only the
 * synthetic mock API accepts (the real API verifies Clerk signatures and rejects it).
 */
import {
  ClerkProvider,
  UserButton,
  useAuth,
  useClerk,
  useUser,
} from "@clerk/nextjs";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAnonymousSession } from "./useAnonymousSession";

export interface DriftAuth {
  mode: "clerk" | "dev" | "none";
  ready: boolean;
  signedIn: boolean;
  userId: string | null;
  label: string | null;
  getToken: () => Promise<string | null>;
  ensureAnonymous: () => Promise<string>;
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<DriftAuth | null>(null);

export function useDriftAuth(): DriftAuth {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useDriftAuth outside DriftAuthProvider");
  return value;
}

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const devAuth = process.env.NEXT_PUBLIC_DRIFT_DEV_AUTH === "mock";

export function DriftAuthProvider({ children }: { children: ReactNode }) {
  if (publishableKey) {
    return (
      <ClerkProvider publishableKey={publishableKey}>
        <ClerkBridge>{children}</ClerkBridge>
      </ClerkProvider>
    );
  }
  return devAuth ? (
    <DevBridge>{children}</DevBridge>
  ) : (
    <NoAuth>{children}</NoAuth>
  );
}

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const guest = useAnonymousSession(Boolean(isLoaded && !isSignedIn));
  const value = useMemo<DriftAuth>(
    () => ({
      mode: "clerk",
      ready: Boolean(isLoaded && (isSignedIn || guest.ready)),
      signedIn: Boolean(isSignedIn),
      userId: isSignedIn ? user?.id ?? null : guest.session?.id ?? null,
      label: user ? (user.username ?? user.firstName ?? "Signed in") : guest.session?.displayName ?? null,
      ensureAnonymous: guest.ensureAnonymous,
      getToken: () => getToken(),
      signIn: () => clerk.openSignIn({}),
      signOut: () => void clerk.signOut(),
    }),
    [isLoaded, isSignedIn, getToken, user, clerk, guest.ready, guest.session, guest.ensureAnonymous],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function DevBridge({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  const guest = useAnonymousSession(!signedIn);
  const getToken = useCallback(
    async () => (signedIn ? "dev-mock-only" : null),
    [signedIn],
  );
  const value = useMemo<DriftAuth>(
    () => ({
      mode: "dev",
      ready: signedIn || guest.ready,
      signedIn,
      userId: signedIn ? "user_mock" : guest.session?.id ?? null,
      label: signedIn ? "Dev user (mock API only)" : guest.session?.displayName ?? null,
      ensureAnonymous: guest.ensureAnonymous,
      getToken,
      signIn: () => setSignedIn(true),
      signOut: () => setSignedIn(false),
    }),
    [signedIn, getToken, guest.ready, guest.session, guest.ensureAnonymous],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function NoAuth({ children }: { children: ReactNode }) {
  const guest = useAnonymousSession(true);
  const value = useMemo<DriftAuth>(
    () => ({
      mode: "none",
      ready: guest.ready,
      signedIn: false,
      userId: guest.session?.id ?? null,
      label: guest.session?.displayName ?? null,
      ensureAnonymous: guest.ensureAnonymous,
      getToken: async () => null,
      signIn: () => undefined,
      signOut: () => undefined,
    }),
    [guest.ready, guest.session, guest.ensureAnonymous],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Top-right account control: Clerk's own avatar menu, or a compact dev/sign-in button. */
export function AccountButton({ className }: { className?: string }) {
  const auth = useDriftAuth();
  if (auth.mode === "none" || !auth.ready) return null;
  if (!auth.signedIn) {
    return (
      <button type="button" className={className} onClick={auth.signIn}>
        Sign in
      </button>
    );
  }
  if (auth.mode === "clerk")
    return (
      <UserButton
        appearance={{ elements: { avatarBox: { width: 36, height: 36 } } }}
      />
    );
  return (
    <button
      type="button"
      className={className}
      onClick={auth.signOut}
      aria-label={`Signed in as ${auth.label}. Sign out`}
    >
      Dev · Sign out
    </button>
  );
}
