import { Providers } from "./providers";
import { config } from "@/lib/config";

type Search = Promise<Record<string, string | string[] | undefined>>;

const VIEWS = ["camera", "simulated", "map"] as const;

export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  // ?dataset=fx-overcast switches fixture scenarios for demos; ?view=map|simulated deep-links a view.
  const dataset = typeof params.dataset === "string" && /^[\w.-]{1,64}$/.test(params.dataset) ? params.dataset : config.datasetId;
  const view = typeof params.view === "string" && (VIEWS as readonly string[]).includes(params.view) ? (params.view as (typeof VIEWS)[number]) : null;
  return <Providers datasetId={dataset} initialView={view === "camera" ? null : view} />;
}
