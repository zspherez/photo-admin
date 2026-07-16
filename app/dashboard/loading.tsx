export default function Loading() {
  return (
    <main
      className="mx-auto max-w-6xl animate-pulse px-6 py-10"
      aria-label="Loading dashboard"
    >
      <div className="h-7 w-44 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-3 h-9 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 h-36 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-36 rounded-xl bg-zinc-200 dark:bg-zinc-800"
          />
        ))}
      </div>
    </main>
  );
}
