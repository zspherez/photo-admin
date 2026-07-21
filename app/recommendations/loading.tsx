export default function Loading() {
  return (
    <main
      className="mx-auto max-w-6xl animate-pulse px-4 py-8 sm:px-6 sm:py-10"
      aria-label="Loading trajectory recommendations"
    >
      <div className="h-7 w-72 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-2 h-4 w-full max-w-xl rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 h-64 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 h-10 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-80 rounded-xl bg-zinc-200 dark:bg-zinc-800"
          />
        ))}
      </div>
    </main>
  );
}
