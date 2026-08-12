"use client";

import { useActionState } from "react";
import { runCollectionNow, type CollectionActionState } from "./actions";

const initialState: CollectionActionState = { status: "idle" };

export function CollectNowButton() {
  const [state, formAction, isPending] = useActionState(runCollectionNow, initialState);

  return (
    <div className="collect-now">
      <form action={formAction}>
        <button type="submit" className="collect-button" disabled={isPending}>
          {isPending ? "Collecting…" : "Collect now"}
        </button>
      </form>
      {state.status === "ok" ? (
        <p className="collect-result collect-result-ok">
          Fetched {state.summary.fetched}, shortlisted {state.summary.shortlisted}.
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="collect-result collect-result-error">{state.message}</p>
      ) : null}
    </div>
  );
}
