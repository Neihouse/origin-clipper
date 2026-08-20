export interface CaptionInput {
  title: string;
  creatorName: string;
}

export interface ProposedCopy {
  proposedTitle: string;
  proposedCaption: string;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Produces a deterministic caption draft. This is copy scaffolding for
 * a human to edit, not a claim that the system understands what's good — see
 * the ranking module for the same caveat.
 */
export function generateProposedCopy({ title, creatorName }: CaptionInput): ProposedCopy {
  const cleanTitle = title.trim() || "ORIGIN session highlight";

  const caption = [
    `An ORIGIN field note with ${creatorName}.`,
    "Recorded live at Primordial Den.",
    "ORIGIN is a Primordial Groove weekly, held at the Den.",
  ].join("\n");

  return {
    proposedTitle: truncate(cleanTitle, 100),
    proposedCaption: caption,
  };
}
