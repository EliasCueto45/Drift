"use client";
import { ApiProvider } from "@/lib/api/ApiProvider";
import { DriftAuthProvider } from "@/lib/auth/DriftAuth";
import { PostProvider } from "@/features/composer/posts";
import { DriftApp } from "@/features/sky/DriftApp";

export function Providers({ datasetId, initialView, devParam }: { datasetId: string; initialView: "simulated" | "map" | null; devParam: boolean | null }) {
  return (
    <DriftAuthProvider>
      <ApiProvider>
        <PostProvider>
          <DriftApp datasetId={datasetId} initialView={initialView} devParam={devParam} />
        </PostProvider>
      </ApiProvider>
    </DriftAuthProvider>
  );
}
