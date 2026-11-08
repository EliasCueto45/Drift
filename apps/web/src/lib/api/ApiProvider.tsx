"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import { DriftApi } from "./client";

const ApiContext = createContext<DriftApi | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const { getToken } = useDriftAuth();
  const api = useMemo(() => new DriftApi(getToken), [getToken]);
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): DriftApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside ApiProvider");
  return api;
}
