"use client";

import { useActionState } from "react";
import { updateClipNotes, type NotesActionState } from "../actions";

const initialState: NotesActionState = { status: "idle" };

export function NotesForm({ clipId, initialNotes }: { clipId: string; initialNotes: string | null }) {
  const [state, formAction, isPending] = useActionState(updateClipNotes, initialState);

  return (
    <form action={formAction} className="notes-form">
      <input type="hidden" name="id" value={clipId} />
      <label htmlFor="notes">Notes</label>
      <textarea
        id="notes"
        name="notes"
        rows={3}
        defaultValue={initialNotes ?? ""}
        placeholder="Private notes for this clip — not published anywhere."
      />
      <div className="notes-form-footer">
        <button type="submit" className="notes-save-button" disabled={isPending}>
          {isPending ? "Saving…" : "Save notes"}
        </button>
        {state.status === "ok" ? <span className="notes-saved">Saved</span> : null}
        {state.status === "error" ? <span className="publish-result-error">{state.message}</span> : null}
      </div>
    </form>
  );
}
