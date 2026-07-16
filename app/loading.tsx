export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl animate-pulse px-6 py-10" aria-label="Loading page">
      <div className="h-7 w-48 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-2 h-4 w-72 max-w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-16 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
    </main>
  );
}
