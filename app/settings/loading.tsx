export default function Loading() {
  return (
    <main className="mx-auto max-w-4xl animate-pulse px-6 py-10" aria-label="Loading settings">
      <div className="h-7 w-36 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-2 h-4 w-64 max-w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-28 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
    </main>
  );
}
