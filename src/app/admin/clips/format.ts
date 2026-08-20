import type { Clip, PlatformPublishStatus } from "@/db/schema";

export function formatDuration(seconds: number): string {
  return `${Math.round(seconds)}s`;
}

export function formatScore(clip: Clip): string {
  if (clip.rankingReason) return clip.rankingReason;
  if (clip.rankingScore == null) return "Not yet scored";
  return `Score ${Math.round(clip.rankingScore * 100)}/100`;
}

export function platformStatusLabel(status: PlatformPublishStatus): string {
  switch (status) {
    case "published":
      return "Published";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "manual_review":
      return "Manual review required";
    default:
      return "Not started";
  }
}

export function platformStatusClass(status: PlatformPublishStatus): string {
  switch (status) {
    case "published":
      return "publish-result-ok";
    case "pending":
      return "publish-result-pending";
    case "failed":
      return "publish-result-error";
    case "manual_review":
      return "publish-result-review";
    default:
      return "";
  }
}
