import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips, clipStatusEnum, type ClipStatus } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { ClipCard } from "./ClipCard";

export const dynamic = "force-dynamic";

const FILTERS: { value: ClipStatus | "all"; label: string }[] = [
  { value: "shortlisted", label: "Shortlisted" },
  { value: "discovered", label: "Discovered" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "published", label: "Published" },
  { value: "all", label: "All" },
];

function resolveStatus(raw: string | undefined): ClipStatus | "all" {
  if (raw === "all") return "all";
  if (raw && (clipStatusEnum.enumValues as string[]).includes(raw)) {
    return raw as ClipStatus;
  }
  return "shortlisted";
}

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function AdminClipsPage({ searchParams }: PageProps) {
  await requireSession();
  const { status: statusParam } = await searchParams;
  const status = resolveStatus(statusParam);

  const db = getDb();
  const rows =
    status === "all"
      ? await db.select().from(clips).orderBy(desc(clips.rankingScore), desc(clips.clipCreatedAt))
      : await db
          .select()
          .from(clips)
          .where(eq(clips.status, status))
          .orderBy(desc(clips.rankingScore), desc(clips.clipCreatedAt));

  return (
    <main className="review-page">
      <header className="review-header">
        <div>
          <h1>ORIGIN clip review</h1>
          <p className="review-subtitle">
            Ranked by views, recency, and short-form duration fit. Nothing here posts anywhere
            until you approve it.
          </p>
        </div>
        <form action="/api/auth/logout" method="POST">
          <button type="submit" className="link-button">
            Sign out
          </button>
        </form>
      </header>

      <nav className="status-filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === "shortlisted" ? "/admin/clips" : `/admin/clips?status=${filter.value}`}
            className={status === filter.value ? "filter active" : "filter"}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="empty-state">No clips in this view yet.</p>
      ) : (
        <ul className="clip-list">
          {rows.map((clip) => (
            <ClipCard key={clip.id} clip={clip} />
          ))}
        </ul>
      )}
    </main>
  );
}
