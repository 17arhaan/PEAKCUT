export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 sm:py-10">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-2">
          <div className="skeleton h-3 w-20" />
          <div className="skeleton h-7 w-40" />
        </div>
        <div className="skeleton h-9 w-28 rounded-full" />
      </div>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-16 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
