"use client";

import { useActionState } from "react";
import { publishClip, type PublishActionState, type PublishPlatformResult } from "./actions";

const initialState: PublishActionState = { status: "idle" };

function resultClass(result: PublishPlatformResult): string {
  if (result.status === "failed") return "publish-result-error";
  return "publish-result-ok";
}

function resultLabel(platform: string, result: PublishPlatformResult): string {
  if (result.status === "published") return `${platform}: published`;
  if (result.status === "skipped") return `${platform}: already published`;
  return `${platform}: ${result.error ?? "failed"}`;
}

export function PublishButton({ clipId }: { clipId: string }) {
  const [state, formAction, isPending] = useActionState(publishClip, initialState);

  return (
    <div className="publish-now">
      <form action={formAction}>
        <input type="hidden" name="id" value={clipId} />
        <button type="submit" className="publish-button" disabled={isPending}>
          {isPending ? "Publishing…" : "Publish"}
        </button>
      </form>
      {state.status === "ok" ? (
        <>
          <p className={`publish-result ${resultClass(state.instagram)}`}>
            {resultLabel("Instagram", state.instagram)}
          </p>
          <p className={`publish-result ${resultClass(state.facebook)}`}>
            {resultLabel("Facebook", state.facebook)}
          </p>
        </>
      ) : null}
      {state.status === "error" ? (
        <p className="publish-result publish-result-error">{state.message}</p>
      ) : null}
    </div>
  );
}
