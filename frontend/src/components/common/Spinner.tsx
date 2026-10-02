export default function Spinner() {
  return (
    <span
      className="inline-flex h-4 w-[1.125rem] shrink-0 items-center justify-center gap-[2px] text-current"
      aria-hidden="true"
    >
      <span className="loading-dot h-[3px] w-[3px] rounded-full bg-current" />
      <span className="loading-dot loading-dot-delay-1 h-[3px] w-[3px] rounded-full bg-current" />
      <span className="loading-dot loading-dot-delay-2 h-[3px] w-[3px] rounded-full bg-current" />
    </span>
  );
}
