"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";

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
