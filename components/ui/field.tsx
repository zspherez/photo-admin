import * as React from "react";
import { cn } from "@/lib/cn";

const INPUT_CLASS =
  "block min-h-11 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none sm:min-h-9 sm:text-sm dark:border-zinc-800 dark:bg-zinc-950 dark:placeholder:text-zinc-600";

interface FieldProps {
  name: string;
  label: string;
  description?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  className?: string;
}

export function Field({
  name,
  label,
  description,
  type = "text",
  placeholder,
  required,
  defaultValue,
  className,
}: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        className={cn("mt-1", INPUT_CLASS)}
      />
      {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
    </div>
  );
}

export function TextArea({
  id,
  name,
  label,
  description,
  placeholder,
  rows = 4,
  defaultValue,
  className,
  mono,
  maxLength,
  required,
}: {
  id?: string;
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  rows?: number;
  defaultValue?: string;
  className?: string;
  mono?: boolean;
  maxLength?: number;
  required?: boolean;
}) {
  const fieldId = id ?? name;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="text-sm font-medium">{label}</label>
      <textarea
        id={fieldId}
        name={name}
        rows={rows}
        placeholder={placeholder}
        defaultValue={defaultValue}
        maxLength={maxLength}
        required={required}
        className={cn(
          "mt-1",
          INPUT_CLASS,
          mono && "font-mono text-xs"
        )}
      />
      {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
    </div>
  );
}
