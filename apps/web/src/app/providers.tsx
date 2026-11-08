"use client";
import { ApiProvider } from "@/lib/api/ApiProvider";
import { DriftAuthProvider } from "@/lib/auth/DriftAuth";
import { PostProvider } from "@/features/composer/posts";
import { DriftApp } from "@/features/sky/DriftApp";

export function Providers({ datasetId, initialView, debug }: { datasetId: string; initialView: "simulated" | "map" | null; debug: boolean }) {
  return (
    <DriftAuthProvider>
      <ApiProvider>
        <PostProvider>
          <DriftApp datasetId={datasetId} initialView={initialView} debug={debug} />
        </PostProvider>
      </ApiProvider>
    </DriftAuthProvider>
  );
}
