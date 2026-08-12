"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { runWeeklyCollection, type CollectionSummary } from "@/lib/collection/run";

function requireId(formData: FormData): string {
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Missing clip id.");
  }
  return id;
}

export async function approveClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);

  const db = getDb();
  await db
    .update(clips)
    .set({ status: "approved", approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(clips.id, id));

  revalidatePath("/admin/clips");
}

export async function rejectClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);

  const db = getDb();
  await db
    .update(clips)
    .set({ status: "rejected", updatedAt: sql`now()` })
    .where(eq(clips.id, id));

  revalidatePath("/admin/clips");
}

export type CollectionActionState =
  | { status: "idle" }
  | { status: "ok"; summary: CollectionSummary }
  | { status: "error"; message: string };

export async function runCollectionNow(): Promise<CollectionActionState> {
  await requireSession();

  try {
    const summary = await runWeeklyCollection();
    revalidatePath("/admin/clips");
    return { status: "ok", summary };
  } catch (error) {
    console.error("Manual clip collection failed:", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "error",
      message: "Collection failed. Check the server logs for details.",
    };
  }
}
