export default function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 shrink-0 text-current"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="8.5"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M12 3.5a8.5 8.5 0 018.5 8.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3"
      />
    </svg>
  );
}
