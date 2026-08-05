"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyProfessionalEmailButton({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(email);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {copied ? "Copied" : "Copy email"}
    </Button>
  );
}
