export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl animate-pulse px-6 py-10" aria-label="Loading artist">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <div className="space-y-2">
          <div className="h-7 w-48 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
      <div className="mt-8 space-y-5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
    </main>
  );
}
