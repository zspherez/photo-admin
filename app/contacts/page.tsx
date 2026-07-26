import { redirect } from "next/navigation";
import type { Metadata } from "next";
import type { SearchParamValue } from "@/lib/searchParams";

export const metadata: Metadata = { title: "Artists" };

export default async function LegacyContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: SearchParamValue;
    search?: SearchParamValue;
    page?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["view", "search", "page"] as const) {
    const value = raw[key];
    const selected = Array.isArray(value) ? value[0] : value;
    if (selected) params.set(key, selected);
  }
  const query = params.toString();
  redirect(query ? `/artists?${query}` : "/artists");
}
