export default function JobLoading() {
  return (
    <div className="landing dark peakcut-app flex min-h-full flex-1 flex-col bg-[var(--ink)] font-body text-[var(--text)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3">
          <div className="skeleton h-5 w-24" />
          <div className="skeleton h-3 w-20" />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 sm:py-10">
        <div className="flex flex-col gap-2">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-8 w-64" />
        </div>
        <div className="skeleton h-2 w-full rounded-full" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton aspect-[9/16] w-full rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
