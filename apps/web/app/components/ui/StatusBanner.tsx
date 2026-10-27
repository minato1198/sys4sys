import type { ReactNode } from "react";

type BannerTone = "success" | "error" | "warning" | "info";

const toneClasses: Record<BannerTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  error: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
};

export function StatusBanner({
  tone,
  title,
  children,
  className = "",
}: {
  tone: BannerTone;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const assertive = tone === "error";
  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      className={`rounded-lg border px-4 py-3 text-sm ${toneClasses[tone]} ${className}`}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? "mt-1" : ""}>{children}</div>
    </div>
  );
}
