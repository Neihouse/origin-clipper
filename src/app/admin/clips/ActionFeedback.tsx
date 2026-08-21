import type { ClipWorkflowActionState } from "./actions";

export function ActionFeedback({ state }: { state: ClipWorkflowActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      className={state.status === "error" ? "publish-result-error" : "publish-result-ok"}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}
