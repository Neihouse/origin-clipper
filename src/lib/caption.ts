import { config } from "@/lib/config";

export interface CaptionInput {
  title: string;
  creatorName: string;
}

export interface ProposedCopy {
  proposedTitle: string;
  proposedCaption: string;
  bookingUrl: string;
}

const CTA_LINE = "Book a DJ recording — $250";
const BIO_LINE = "Link in bio to book →";

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Produces a deterministic caption draft + CTA. This is copy scaffolding for
 * a human to edit, not a claim that the system understands what's good — see
 * the ranking module for the same caveat.
 *
 * The caption never embeds the raw booking URL — Instagram and Facebook don't
 * render caption links as clickable, so a bare URL there is a dead CTA. The
 * booking URL is returned separately for the admin UI (e.g. link-in-bio setup),
 * not for publishing into platform-facing text.
 */
export function generateProposedCopy({ title, creatorName }: CaptionInput): ProposedCopy {
  const cleanTitle = title.trim() || "ORIGIN session highlight";

  const caption = [
    truncate(cleanTitle, 150),
    `Live from ORIGIN with ${creatorName}.`,
    CTA_LINE,
    BIO_LINE,
  ].join("\n\n");

  return {
    proposedTitle: truncate(cleanTitle, 100),
    proposedCaption: caption,
    bookingUrl: config.den.bookingUrl,
  };
}
