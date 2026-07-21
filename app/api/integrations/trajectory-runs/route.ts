import { handleTrajectoryIngestRequest } from "@/lib/trajectoryIngest";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleTrajectoryIngestRequest(request);
}
