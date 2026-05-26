"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  size = "md",
  disabled,
}: {
  label: string;
  pendingLabel: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending || disabled}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function SyncForm({
  action,
  label,
  pendingLabel = "Syncing…",
  variant = "primary",
  size = "md",
  hiddenFields,
  disabled,
  children,
  className,
}: {
  action: (formData: FormData) => void | Promise<void>;
  label: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  hiddenFields?: Record<string, string>;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <form action={action} className={className}>
      {hiddenFields &&
        Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      {children}
      <SubmitButton label={label} pendingLabel={pendingLabel} variant={variant} size={size} disabled={disabled} />
    </form>
  );
}
