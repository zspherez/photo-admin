export const FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH = 200;

export function normalizeFestivalUtmCampaign(value: unknown): string | null {
  const campaign = typeof value === "string" ? value.trim() : "";
  if (!campaign) return null;
  if (campaign.length > FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH) {
    throw new Error(
      `Festival UTM campaign must be ${FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH} characters or fewer`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(campaign)) {
    throw new Error("Festival UTM campaign contains invalid characters");
  }
  return campaign;
}
