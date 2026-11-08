"use client";
import { ApiProvider } from "@/lib/api/ApiProvider";
import { DriftAuthProvider } from "@/lib/auth/DriftAuth";
import { PostProvider } from "@/features/composer/posts";
import { DriftApp } from "@/features/sky/DriftApp";

export function Providers({ datasetId, initialView }: { datasetId: string; initialView: "simulated" | "map" | null }) {
  return (
    <DriftAuthProvider>
      <ApiProvider>
        <PostProvider>
          <DriftApp datasetId={datasetId} initialView={initialView} />
        </PostProvider>
      </ApiProvider>
    </DriftAuthProvider>
  );
}
