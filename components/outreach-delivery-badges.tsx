import { Badge, type BadgeTone } from "@/components/ui/badge";

export interface OutreachDeliveryState {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

export interface OutreachDeliveryBadge {
  key: "sent" | "delivered" | "opened" | "clicked";
  label: string;
  tone: BadgeTone;
}

export function outreachDeliveryBadges(
  outreach: OutreachDeliveryState,
): OutreachDeliveryBadge[] {
  if (outreach.status === "test") return [];

  const badges: OutreachDeliveryBadge[] = [];
  const hasProviderActivity =
    outreach.status === "sent" ||
    outreach.sentAt !== null ||
    outreach.deliveredAt !== null ||
    outreach.openCount > 0 ||
    outreach.clickCount > 0;

  if (hasProviderActivity) {
    badges.push({ key: "sent", label: "Sent", tone: "default" });
  }
  if (outreach.deliveredAt) {
    badges.push({
      key: "delivered",
      label: "Delivered",
      tone: "success",
    });
  }
  if (outreach.openCount > 0) {
    badges.push({
      key: "opened",
      label:
        outreach.openCount > 1
          ? `Opened (${outreach.openCount})`
          : "Opened",
      tone: "info",
    });
  }
  if (outreach.clickCount > 0) {
    badges.push({
      key: "clicked",
      label:
        outreach.clickCount > 1
          ? `Clicked (${outreach.clickCount})`
          : "Clicked",
      tone: "accent",
    });
  }

  return badges;
}

export function OutreachDeliveryBadges({
  outreach,
}: {
  outreach: OutreachDeliveryState;
}) {
  return outreachDeliveryBadges(outreach).map((badge) => (
    <Badge key={badge.key} tone={badge.tone} size="xs">
      {badge.label}
    </Badge>
  ));
}
